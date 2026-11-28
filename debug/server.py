"""Debug UI for the crawler, the database, the index and the matcher.

Start it from the repository root with `make debug` (see debug/README.md). It runs in the
crawler's uv environment and only uses the crawler's public Python API (`run_requests`
with its factory and sleep hooks, `crawler.store` for `--store`), asyncpg and the standard
library, so the crawler needs nothing extra for it. The database view only reads, except when
the user empties tables and types the database name to confirm, and when the Index overview sets
how many audio files the transcription job reads at once. The Pre-filter screen saves labels to
research/prefilter/labels.json, never to the database.

The matcher is TypeScript, so its logic stays there: the Index screens start the indexer job
(`matcher/indexer`) as a child process, for every approach or one, and read its tables, and the
Matcher screen asks `node src/main.ts explain` in `matcher/mcp-server` for the answer of
`match_journey` with the steps of the match, and `node src/main.ts get_source` for the files of
one source. Index › Graph shows a patient graph or PubTator3 annotations normalized by
`scripts/normalize.ts` of `matcher/algorithms/graph`. Journeys are passed on, never stored or
logged.
"""

import argparse
import asyncio
import contextlib
import fcntl
import http.client
import importlib
import io
import json
import logging
import math
import os
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid
import warnings
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse, urlsplit

import asyncpg
from dotenv import dotenv_values
from pydantic import ValidationError

from crawler.cli import parser as cli_parser
from crawler.cli import refresh_videos, requests_from_args
from crawler.links.base import LinkExtractor
from crawler.models import ScrapeRequest, SourceDocument, SourceName, validation_message
from crawler.runner import ENV_FILE, link_extractor_from_env, run_requests, source_from_env
from crawler.seeds import TOPICS_DIR, TopicFileError, load_topic
from crawler.sources.base import BaseScraper, redact_secrets
from crawler.store import (
    STORE_LOCK,
    RunInfo,
    StoreError,
    database_url,
    prepare_store,
    save_result,
)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MATCHER_DIR = ROOT / "matcher"
RUNS_DIR = HERE / "runs"
WEB_DIR = HERE / "web"
"""The page: index.html, one script and stylesheet per screen; nothing else is served."""
WEB_FILE = re.compile(r"/([a-z0-9-]+\.(?:html|css|js))")
WEB_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}
ENV_KEYS = (
    "NCBI_ENTREZ_EMAIL",
    "NCBI_API_KEY",
    "OPENALEX_API_KEY",
    "SEMANTIC_SCHOLAR_API_KEY",
    "YOUTUBE_API_KEY",
)
SHELL_KEYS = {key for key in ENV_KEYS if os.environ.get(key)}
RUN_ID = re.compile(r"[0-9A-Za-z-]+")
ALLOWED_HOSTS: set[str] = set()
"""`Host` header values of this server, set in main(); other hosts are DNS rebinding."""

LOCK = threading.Lock()
CURRENT: "Run | None" = None
SUMMARIES: dict[str, dict[str, Any]] = {}


def describe_error(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"


def refresh_env() -> dict[str, bool]:
    """Re-read crawler/.env so edits apply without a restart; shell variables win."""
    values = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}
    for key in ENV_KEYS:
        if key in SHELL_KEYS:
            continue
        value = (values.get(key) or "").strip()
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)
    return {key: bool(os.environ.get(key)) for key in ENV_KEYS}


class EventLog:
    """What a run reports while it runs; `stream_events` sends it to the browser."""

    def __init__(self) -> None:
        self.id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.started = time.monotonic()
        self.duration: float | None = None
        self.status = "running"
        self.events: list[dict[str, Any]] = []
        self.changed = threading.Condition()

    def emit(self, event_type: str, /, **data: Any) -> None:
        with self.changed:
            event = {
                "seq": len(self.events),
                "t": round(time.monotonic() - self.started, 2),
                "type": event_type,
                **data,
            }
            self.events.append(event)
            self.changed.notify_all()


class Run(EventLog):
    def __init__(self, argv: list[str]) -> None:
        super().__init__()
        self.argv = argv
        self.command = "uv run crawler " + shlex.join(argv)
        self.error: str | None = None
        self.result: dict[str, Any] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.task: asyncio.Task[Any] | None = None
        self.cancel_requested = False
        self.store_url: str | None = None
        """`DATABASE_URL` when the run is stored like `crawler --store`."""
        self.stored: dict[str, Any] | None = None

    def summary(self) -> dict[str, Any]:
        stats = (self.result or {}).get("stats") or {}
        return {
            "id": self.id,
            "command": self.command,
            "started_at": self.started_at,
            "status": self.status,
            "duration": self.duration,
            "documents": stats.get("documents"),
            "failures": len((self.result or {}).get("failures") or []),
            "error": self.error,
            "stored": (self.stored or {}).get("run_id"),
        }

    def to_json(self) -> dict[str, Any]:
        return {**self.summary(), "argv": self.argv, "result": self.result, "events": self.events}


# ── Tracing wrappers: plugged in through run_requests' factory hooks ─────────────


class TracedScraper(BaseScraper):
    """Wraps a real scraper and reports every source call as an event."""

    def __init__(self, inner: BaseScraper, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        detail: str | None
        if request.is_lookup:
            kind, detail = "lookup", f"{len(request.ids)} IDs"
        elif request.channel or request.feed:
            kind, detail = "channel", request.seed_label
        else:
            kind, detail = "search", request.query
        base = {"kind": kind, "source": request.source.value, "detail": detail}
        self.run.emit("request_start", **base)
        start = time.monotonic()
        try:
            documents = self.inner.scrape(request)
        except Exception as error:
            seconds = round(time.monotonic() - start, 2)
            self.run.emit("request_error", **base, seconds=seconds, error=describe_error(error))
            raise
        self.run.emit(
            "request_done",
            **base,
            seconds=round(time.monotonic() - start, 2),
            count=len(documents),
            requested=len(request.ids) if request.is_lookup else None,
            docs=[
                {"id": document.id, "title": document.title, "type": document.content_type}
                for document in documents
            ],
        )
        return documents


class TracedExtractor(LinkExtractor):
    """Wraps a real link extractor and reports the citation edges it finds."""

    def __init__(self, inner: LinkExtractor, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def cited_ids(self, native_ids: Sequence[str]) -> dict[str, list[str]]:
        prefix = self.source.value
        base = {"kind": "references", "source": prefix, "detail": f"{len(native_ids)} papers"}
        self.run.emit("request_start", **base)
        start = time.monotonic()
        try:
            cited = self.inner.cited_ids(native_ids)
        except Exception as error:
            seconds = round(time.monotonic() - start, 2)
            self.run.emit("request_error", **base, seconds=seconds, error=describe_error(error))
            raise
        self.run.emit(
            "request_done",
            **base,
            seconds=round(time.monotonic() - start, 2),
            count=sum(len(values) for values in cited.values()),
            edges={
                f"{prefix}:{citing}": [f"{prefix}:{value}" for value in values]
                for citing, values in cited.items()
            },
        )
        return cited


class EventLogHandler(logging.Handler):
    """Forwards the runner's one-line retry messages to the current run."""

    def emit(self, record: logging.LogRecord) -> None:
        run = CURRENT
        if run is not None and run.status == "running":
            run.emit("retry", message=record.getMessage())


def show_warning(message: Any, category: Any, *_args: Any, **_kwargs: Any) -> None:
    text = str(message).strip()
    first_line = text.splitlines()[0] if text else ""
    run = CURRENT
    if run is not None and run.status == "running":
        run.emit("warning", message=f"{category.__name__}: {first_line}")
    else:
        print(f"{category.__name__}: {first_line}")


def execute(run: Run, seeds: list[Any], options: Any) -> None:
    global CURRENT
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    run.loop = loop

    def sources(source: SourceName) -> TracedScraper:
        return TracedScraper(source_from_env(source), run)

    def extractors(source: SourceName) -> TracedExtractor | None:
        inner = link_extractor_from_env(source)
        return None if inner is None else TracedExtractor(inner, run)

    async def sleep(seconds: float) -> None:
        run.emit("backoff", seconds=seconds)
        await asyncio.sleep(seconds)

    try:
        run.task = loop.create_task(
            run_requests(
                seeds,
                options=options,
                source_factory=sources,
                link_extractor_factory=extractors,
                sleep=sleep,
            )
        )
        result = loop.run_until_complete(run.task)
        run.result = result.model_dump(mode="json")
        run.duration = round(time.monotonic() - run.started, 2)
        # Crawlee stops on cancellation and returns what it has, so the result is partial.
        status = "cancelled" if run.cancel_requested else "finished"
        run.emit(
            "run_cancelled" if run.cancel_requested else "run_finished",
            ok=result.ok,
            documents=len(result.documents),
            failures=len(result.failures),
            run_error=result.run_error,
        )
        # Still running while it stores, so the live log gets the store lines before its end.
        if run.store_url is not None and status == "finished":
            store(run, loop, seeds, result)
        with run.changed:
            run.status = status
            run.changed.notify_all()
    except asyncio.CancelledError:
        run.duration = round(time.monotonic() - run.started, 2)
        run.status = "cancelled"
        run.emit("run_cancelled")
    except Exception as error:
        run.duration = round(time.monotonic() - run.started, 2)
        run.error = describe_error(error)
        run.status = "failed"
        run.emit("run_failed", error=run.error)
    finally:
        with contextlib.suppress(Exception):
            loop.close()
        save(run)
        with LOCK:
            CURRENT = None


def prepare(source: str, options: Any) -> tuple[str, Any]:
    """Like `crawler --store` before a crawl: check the database, skip stored cited papers."""
    try:
        url = database_url()
        stored = asyncio.run(prepare_store(url, SourceName(source), load_ids=options.max_depth > 0))
    except StoreError as error:
        raise ValueError(str(error)) from error
    return url, options.model_copy(update={"known_ids": options.known_ids | stored})


def store(run: Run, loop: asyncio.AbstractEventLoop, seeds: list[Any], result: Any) -> None:
    """Like `crawler --store` after a crawl, but several topics as one run, where the command
    line makes one of each; cancelled runs are not stored."""
    assert run.store_url is not None
    run.emit("store_started")
    info = RunInfo(
        source=SourceName(run.argv[0]),
        topics=list(dict.fromkeys(topic for seed in seeds for topic in seed.topics)),
        arguments=run.argv,
        started_at=datetime.fromisoformat(run.started_at),
        finished_at=datetime.now(UTC),
    )
    refreshed: list[Any] = []
    if info.source is SourceName.YOUTUBE:
        try:
            due, refreshed = loop.run_until_complete(refresh_videos(run.store_url, seeds, result))
        except Exception as error:
            message = redact_secrets(describe_error(error))
            run.emit("warning", message=f"Refreshing stored videos failed: {message}")
        else:
            run.emit("refreshed", due=due, refreshed=len(refreshed))
    try:
        report = loop.run_until_complete(
            save_result(run.store_url, result, info, refreshed=refreshed)
        )
    except StoreError as error:
        run.emit("store_failed", error=str(error))
        return
    run.stored = report.model_dump()
    run.emit("stored", **run.stored)


# ── Runs on disk ──────────────────────────────────────────────────────────────


def save(run: Run) -> None:
    RUNS_DIR.mkdir(exist_ok=True)
    (RUNS_DIR / f"{run.id}.json").write_text(
        json.dumps(run.to_json(), ensure_ascii=False), encoding="utf-8"
    )
    SUMMARIES[run.id] = run.summary()


def load_summaries() -> None:
    if not RUNS_DIR.exists():
        return
    for path in RUNS_DIR.glob("*.json"):
        with contextlib.suppress(OSError, ValueError):
            data = json.loads(path.read_text(encoding="utf-8"))
            SUMMARIES[data["id"]] = {
                key: data.get(key)
                for key in (
                    "id",
                    "command",
                    "started_at",
                    "status",
                    "duration",
                    "documents",
                    "failures",
                    "error",
                    "stored",
                )
            }


def list_runs() -> list[dict[str, Any]]:
    runs = sorted(SUMMARIES.values(), key=lambda run: run["id"], reverse=True)
    current = CURRENT
    if current is not None:
        runs = [current.summary(), *[run for run in runs if run["id"] != current.id]]
    return runs[:100]


def load_run(run_id: str) -> dict[str, Any] | None:
    current = CURRENT
    if current is not None and current.id == run_id:
        return current.to_json()
    if not RUN_ID.fullmatch(run_id):
        return None
    path = RUNS_DIR / f"{run_id}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def delete_all_runs() -> int:
    deleted = 0
    for run_id in list(SUMMARIES):
        deleted += delete_run(run_id)
    return deleted


def delete_run(run_id: str) -> bool:
    if not RUN_ID.fullmatch(run_id) or (CURRENT is not None and CURRENT.id == run_id):
        return False
    path = RUNS_DIR / f"{run_id}.json"
    SUMMARIES.pop(run_id, None)
    if path.exists():
        path.unlink()
        return True
    return False


# ── Building a run from the form, with the same rules as the CLI ─────────────


def build_argv(body: dict[str, Any]) -> list[str]:
    source = body.get("source")
    if source not in ("pubmed", "arxiv", "zenodo", "youtube", "podcast"):
        raise ValueError("Unknown source")
    argv = [source]

    def add(flag: str, value: Any) -> None:
        if value not in (None, ""):
            argv.extend([flag, str(value)])

    add("--max-results", body.get("max_results"))
    if source in ("pubmed", "arxiv"):
        add("--max-depth", body.get("max_depth"))
        if body.get("min_citations") != 1:
            add("--min-citations", body.get("min_citations"))
    add("--since", body.get("since"))
    if source in ("arxiv", "zenodo"):
        add("--query-mode", body.get("query_mode"))
    add("--max-requests", body.get("max_requests"))
    if body.get("store") is True:
        argv.append("--store")

    if body.get("mode") == "topic":
        topics = [str(topic) for topic in body.get("topics") or [] if topic]
        if not topics:
            raise ValueError("Select at least one topic")
        for topic in topics:
            argv.extend(["--topic", topic])
    else:
        value = str(body.get("query") or "").strip()
        if not value:
            missing = {"youtube": "Enter a channel", "podcast": "Enter a feed key"}
            raise ValueError(missing.get(source, "Enter a query"))
        argv.extend(["--", value] if value.startswith("-") else [value])
    return argv


def parse_run(argv: list[str]) -> tuple[list[Any], Any]:
    errors = io.StringIO()
    try:
        with contextlib.redirect_stderr(errors):
            arguments = cli_parser().parse_args(argv)
    except SystemExit as error:
        lines = errors.getvalue().strip().splitlines()
        raise ValueError(lines[-1] if lines else "Invalid arguments") from error
    try:
        return requests_from_args(arguments)
    except ValidationError as error:  # a ValueError too: catch it first, without pydantic's dump
        raise ValueError(validation_message(error)) from error
    except (TopicFileError, ValueError) as error:
        raise ValueError(str(error)) from error


def meta() -> dict[str, Any]:
    topics: list[dict[str, Any]] = []
    feeds: dict[str, dict[str, str]] = {}
    for path in sorted(TOPICS_DIR.glob("*.yaml")):
        try:
            topic = load_topic(path)
        except TopicFileError as error:
            topics.append({"id": path.stem, "label": path.stem, "error": str(error)})
            continue
        topics.append(
            {
                "id": topic.id,
                "label": topic.label,
                "queries": len(topic.queries),
                "channels": len(topic.channels),
                "podcasts": len(topic.podcasts),
                "terms": topic.terms,
            }
        )
        for feed in topic.podcasts:
            feeds.setdefault(
                feed.key, {"key": feed.key, "name": feed.name, "audience": feed.audience}
            )
    env = refresh_env() if CURRENT is None else {k: bool(os.environ.get(k)) for k in ENV_KEYS}
    try:
        database = bool(database_url())
    except StoreError:
        database = False
    return {
        "env": env,
        "env_file": str(ENV_FILE),
        "env_file_exists": ENV_FILE.exists(),
        "database": database,
        "topics": topics,
        "feeds": list(feeds.values()),
        "running": CURRENT.id if CURRENT is not None else None,
    }


# ── Database view: read-only, one connection per request ─────────────────────

DB_SETTINGS = {
    # Every query of this view runs in a read-only transaction, whatever the SQL says.
    "default_transaction_read_only": "on",
    "application_name": "crawler-debug-ui",
    "TimeZone": "UTC",
}
CONNECT_ERRORS = (OSError, asyncpg.PostgresError, asyncpg.InterfaceError, ValueError)
# Every schema but the system ones: `public`, and one per matching approach, e.g. `keyword`.
USER_SCHEMA = "n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'"
CELL_LIMIT = 300
"""Characters of a value the table view shows; the keyword index has cells of 50,000 words."""
URL_PASSWORD = re.compile(r"(\w+://[^:/@\s]*:)[^@\s]*@")
DOCUMENT_SORTS = {
    "changed": "changed_at",
    "retrieved": "retrieved_at",
    "created": "created_at",
    "published": "published_at",
    "expires": "expires_at",
    "title": "lower(title)",
    "id": "id",
    "source": "source",
}
FROM_SEARCH = "jsonb_path_exists(found_by, '$[*].query')"
DOCUMENT_STATS = """
SELECT count(*) AS total,
       count(*) FILTER (WHERE summary IS NOT NULL) AS with_summary,
       count(*) FILTER (WHERE doi IS NOT NULL) AS with_doi,
       count(*) FILTER (WHERE licence IS NOT NULL) AS with_licence,
       count(*) FILTER (WHERE jsonb_array_length(full_text) > 0) AS with_full_text,
       count(*) FILTER (WHERE NOT jsonb_path_exists(found_by, '$[*].query')) AS cited_only,
       count(*) FILTER (WHERE expires_at < now()) AS expired,
       count(*) FILTER (WHERE expires_at >= now() AND expires_at < now() + interval '7 days')
           AS expiring,
       count(*) FILTER (WHERE created_at > now() - interval '1 day') AS new_today,
       max(retrieved_at) AS last_retrieved
FROM documents
"""


class DbUnavailable(Exception):
    """No connection to the database; `hint` says what to do about it."""

    def __init__(self, message: str, hint: str) -> None:
        super().__init__(message)
        self.hint = hint


def connection_hint(error: BaseException) -> str:
    if isinstance(error, asyncpg.InvalidAuthorizationSpecificationError):
        return "Check user and password in DATABASE_URL against the root .env."
    if isinstance(error, asyncpg.InvalidCatalogNameError):
        return "Check the database name in DATABASE_URL against POSTGRES_DB in the root .env."
    if isinstance(error, ValueError | asyncpg.InterfaceError):
        return "Check DATABASE_URL: a postgresql:// URL as in crawler/.env.example."
    return (
        "If the database is not running, start it from the repository root: make db"
        " (or docker compose up -d). Else check host and port in DATABASE_URL."
    )


def run_db(
    query: Callable[[Any], Awaitable[Any]], *, write: bool = False, connect_timeout: float = 5
) -> Any:
    """`query(connection)` on a new connection to `DATABASE_URL`, read-only unless `write`."""
    try:
        url = database_url()
    except StoreError as error:
        raise DbUnavailable(str(error), "See crawler/.env.example.") from error
    settings = DB_SETTINGS | {"default_transaction_read_only": "off"} if write else DB_SETTINGS

    async def main() -> Any:
        try:
            connection = await asyncpg.connect(
                url, timeout=connect_timeout, server_settings=settings
            )
        except CONNECT_ERRORS as error:
            message = URL_PASSWORD.sub(r"\1<redacted>@", describe_error(error))
            raise DbUnavailable(message, connection_hint(error)) from error
        try:
            await note_drops_table(connection)
            return await query(connection)
        finally:
            await connection.close()

    return asyncio.run(main())


def database_target() -> str:
    """`host:port/database` of `DATABASE_URL`, without user and password."""
    parts = urlsplit(database_url())
    return f"{parts.hostname or 'localhost'}:{parts.port or 5432}{parts.path}"


async def fetch_json(
    connection: Any, sql: str, *args: Any, timeout: float | None = None
) -> list[Any]:
    """The rows of `sql` as JSON objects; Postgres writes dates and timestamps as ISO text."""
    rows = await connection.fetch(
        f"SELECT to_jsonb(r) AS row FROM ({sql}) AS r", *args, timeout=timeout
    )
    return [json.loads(row["row"]) for row in rows]


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def first(params: dict[str, list[str]], key: str) -> str:
    return (params.get(key) or [""])[0].strip()


def page(params: dict[str, list[str]]) -> tuple[int, int]:
    try:
        limit = int(first(params, "limit") or 50)
        offset = int(first(params, "offset") or 0)
    except ValueError as error:
        raise ValueError("limit and offset must be whole numbers") from error
    return min(max(limit, 1), 500), max(offset, 0)


async def user_tables(connection: Any) -> list[dict[str, Any]]:
    """The tables of every schema, those of the current schema first.

    `name` is the table as Postgres writes it: `documents`, or `keyword.documents` outside the
    search path. Postgres quotes it where needed, so it goes into SQL as it is.
    """
    return await fetch_json(
        connection,
        "SELECT c.oid::regclass::text AS name, n.nspname AS schema FROM pg_class AS c"
        " JOIN pg_namespace AS n ON n.oid = c.relnamespace"
        f" WHERE {USER_SCHEMA} AND c.relkind IN ('r', 'p')"
        " ORDER BY n.nspname <> current_schema(), n.nspname, c.relname",
    )


async def table_names(connection: Any) -> list[str]:
    return [table["name"] for table in await user_tables(connection)]


async def has_keyword_index(connection: Any) -> bool:
    """Whether the keyword indexer has created its tables (`make index`)."""
    return bool(
        await connection.fetchval(
            "SELECT to_regclass('keyword.documents') IS NOT NULL"
            " AND to_regclass('keyword.full_texts') IS NOT NULL"
        )
    )


async def db_overview(connection: Any) -> dict[str, Any]:
    [info] = await fetch_json(
        connection,
        "SELECT current_database() AS database, current_user AS user,"
        " current_setting('server_version') AS version, current_schema() AS schema",
    )
    overview: dict[str, Any] = info
    tables = await user_tables(connection)
    for table in tables:
        name = table["name"]
        table["rows"] = await connection.fetchval(f"SELECT count(*) FROM {name}")
        table["bytes"] = await connection.fetchval(
            "SELECT pg_total_relation_size(to_regclass($1))", name
        )
    names = {table["name"] for table in tables}
    overview |= {
        "target": database_target(),
        "tables": tables,
        "keyword_index": await has_keyword_index(connection),
        "missing": [name for name in ("documents", "crawl_runs") if name not in names],
        "documents": None,
        "runs": None,
    }
    if "documents" in names:
        [stats] = await fetch_json(connection, DOCUMENT_STATS)

        async def facet(expression: str) -> list[Any]:
            return await fetch_json(
                connection,
                f"SELECT {expression} AS value, count(*) AS count FROM documents"
                " GROUP BY 1 ORDER BY 2 DESC, 1",
            )

        stats["sources"] = await facet("source")
        stats["types"] = await facet("content_type")
        stats["licences"] = await facet("licence")
        stats["topics"] = await fetch_json(
            connection,
            "SELECT entry ->> 'topic' AS value, count(DISTINCT d.id) AS count"
            " FROM documents AS d, jsonb_array_elements(d.found_by) AS entry"
            " WHERE entry ->> 'topic' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1",
        )
        overview["documents"] = stats
    if "crawl_runs" in names:
        last = await fetch_json(connection, "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1")
        overview["runs"] = {
            "total": await connection.fetchval("SELECT count(*) FROM crawl_runs"),
            "last": last[0] if last else None,
        }
    return overview


def document_filter(params: dict[str, list[str]], indexed: bool) -> tuple[str, list[Any]]:
    """SQL conditions and arguments for the filters of the documents table.

    `indexed`: the keyword index exists, so its full-text status can be filtered.
    """
    conditions: list[str] = []
    args: list[Any] = []

    def arg(value: Any) -> str:
        args.append(value)
        return f"${len(args)}"

    if text := first(params, "q").lower():
        needle = arg(text)
        conditions.append(
            f"(strpos(lower(title), {needle}) > 0 OR strpos(lower(id), {needle}) > 0"
            f" OR strpos(coalesce(doi, ''), {needle}) > 0)"
        )
    if source := first(params, "source"):
        conditions.append(f"source = {arg(source)}")
    if content_type := first(params, "type"):
        conditions.append(f"content_type = {arg(content_type)}")
    origin = first(params, "origin")
    if origin == "search":
        conditions.append(FROM_SEARCH)
    elif origin == "cited":
        conditions.append(f"NOT {FROM_SEARCH}")
    if topic := first(params, "topic"):
        conditions.append(
            f"found_by @> jsonb_build_array(jsonb_build_object('topic', {arg(topic)}::text))"
        )
    licence = first(params, "licence")
    if licence == ":unknown":
        conditions.append("licence IS NULL")
    elif licence == ":known":
        conditions.append("licence IS NOT NULL")
    elif licence:
        conditions.append(f"licence = {arg(licence)}")
    expiry = first(params, "expiry")
    if expiry == "expired":
        conditions.append("expires_at < now()")
    elif expiry == "soon":
        conditions.append("expires_at >= now() AND expires_at < now() + interval '7 days'")
    elif expiry == "has":
        conditions.append("expires_at IS NOT NULL")
    elif expiry == "none":
        conditions.append("expires_at IS NULL")
    if run_id := first(params, "run"):
        if not run_id.isdigit():
            raise ValueError("run must be the ID of a store run")
        # A run's documents were retrieved while it ran; later runs move retrieved_at on.
        conditions.append(
            f"EXISTS (SELECT FROM crawl_runs AS r WHERE r.id = {arg(int(run_id))}"
            " AND r.source = documents.source"
            " AND documents.retrieved_at BETWEEN r.started_at AND r.finished_at)"
        )
    full_text, detail = first(params, "fulltext"), first(params, "detail")
    if full_text or detail:
        if not indexed:
            raise ValueError("No keyword index yet: run make index")
        # Like the keyword coverage: the indexer leaves expired documents alone.
        conditions.append("(expires_at IS NULL OR expires_at > now())")
        if full_text:
            states = FULL_TEXT_FILTERS.get(full_text)
            if states is None:
                raise ValueError("Unknown full-text state")
            conditions.append(f"{document_full_text()} = ANY ({arg(states)}::text[])")
        if detail:
            conditions.append(
                "EXISTS (SELECT FROM keyword.full_texts AS f"
                f" WHERE f.document_id = documents.id AND f.detail = {arg(detail)})"
            )
    return " AND ".join(conditions) or "true", args


async def db_documents(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    indexed = await has_keyword_index(connection)
    where, args = document_filter(params, indexed)
    state = document_full_text() if indexed else "NULL::text"
    sort = DOCUMENT_SORTS.get(first(params, "sort") or "changed")
    if sort is None:
        raise ValueError("Unknown sort column")
    order = "ASC" if first(params, "order") == "asc" else "DESC"
    limit, offset = page(params)
    total = await connection.fetchval(f"SELECT count(*) FROM documents WHERE {where}", *args)
    rows = await fetch_json(
        connection,
        f"""SELECT id, source, content_type, title, published_at, published_precision, licence,
                   doi, retrieved_at, changed_at, created_at, expires_at,
                   {FROM_SEARCH} AS from_search, {state} AS full_text_state,
                   jsonb_array_length(jsonb_path_query_array(found_by, '$[*].cited_by'))
                       AS cited_by,
                   (SELECT coalesce(jsonb_agg(DISTINCT entry ->> 'query'), '[]')
                    FROM jsonb_array_elements(found_by) AS entry WHERE entry ? 'query')
                       AS queries,
                   (SELECT coalesce(jsonb_agg(DISTINCT entry ->> 'topic'), '[]')
                    FROM jsonb_array_elements(found_by) AS entry
                    WHERE entry ->> 'topic' IS NOT NULL) AS topics
            FROM documents
            WHERE {where}
            ORDER BY {sort} {order} NULLS LAST, id
            LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}""",
        *args,
        limit,
        offset,
    )
    return {"total": total, "offset": offset, "limit": limit, "rows": rows}


async def db_document(connection: Any, document_id: str) -> dict[str, Any]:
    rows = await fetch_json(connection, "SELECT * FROM documents WHERE id = $1", document_id)
    if not rows:
        raise LookupError(f"No document {document_id} (deleted or never stored)")
    document = rows[0]
    citing = [entry["cited_by"] for entry in document["found_by"] if "cited_by" in entry]
    titles = {
        row["id"]: row["title"]
        for row in await fetch_json(
            connection, "SELECT id, title FROM documents WHERE id = ANY($1::text[])", citing
        )
    }
    cites = await fetch_json(
        connection,
        "SELECT id, title FROM documents"
        " WHERE found_by @> jsonb_build_array(jsonb_build_object('cited_by', $1::text))"
        " ORDER BY id",
        document_id,
    )
    return {
        "document": document,
        "cited_by": [{"id": item, "title": titles.get(item)} for item in citing],
        "cites": cites,
        "index": await document_index(connection, document_id),
    }


async def db_titles(connection: Any, ids: list[str]) -> dict[str, Any]:
    """Title and kind of the stored documents among `ids`, e.g. the candidates of a match."""
    rows = await fetch_json(
        connection,
        "SELECT id, title, source, content_type FROM documents WHERE id = ANY($1::text[])",
        ids,
    )
    return {"rows": rows}


async def db_prefilter_documents(connection: Any, ids: list[str]) -> dict[str, Any]:
    """What a Pre-filter card shows of the stored documents among `ids`."""
    rows = await fetch_json(
        connection,
        "SELECT id, title, source, content_type, publication_types, published_at, summary,"
        " canonical_url FROM documents WHERE id = ANY($1::text[])",
        ids,
    )
    return {"rows": rows}


DROPS_TABLE = False
"""Whether the database has the drop list of #92 (db/init/05-document-drops.sql); `run_db` checks
it before every query, so the version below matches the matcher's on old and new databases."""


async def note_drops_table(connection: Any) -> None:
    global DROPS_TABLE
    DROPS_TABLE = bool(await connection.fetchval(DROPS_EXIST))


def version(document: str) -> str:
    """The version of `document` for its indexes: its last change, a later stored transcript, or
    the time a person's drop took effect, whichever is latest.

    `VERSION` in matcher/db/src/documents.ts.
    """
    drop = (
        f", (SELECT dr.effect_at FROM document_drops AS dr WHERE dr.document_id = {document}.id)"
        if DROPS_TABLE
        else ""
    )
    return (
        f"greatest({document}.changed_at, (SELECT t.read_at FROM transcripts AS t"
        f" WHERE t.document_id = {document}.id AND t.status <> 'failed'){drop})"
    )


def index_current() -> str:
    """An index row `i` holds the current version of its document `d` (`toIndex` in @matcher/db)."""
    return f"i.document_changed_at = date_trunc('milliseconds', {version('d')})"


async def document_index(connection: Any, document_id: str) -> dict[str, Any] | None:
    """What the keyword index holds of a document; None before the first `make index`."""
    if not await has_keyword_index(connection):
        return None
    metadata = await fetch_json(
        connection,
        f"""SELECT i.content, {index_current()} AS current
            FROM keyword.documents AS i JOIN documents AS d ON d.id = i.document_id
            WHERE i.document_id = $1""",
        document_id,
    )
    words = "string_to_table(i.terms, ' ') AS word WHERE word <> ''"
    full_text = await fetch_json(
        connection,
        f"""SELECT i.status, i.detail, i.url, i.media_type, i.words, i.fetched_at,
                   {index_current()} AS current,
                   (SELECT count(DISTINCT word) FROM {words}) AS distinct_words,
                   (SELECT coalesce(jsonb_agg(top ORDER BY top.count DESC, top.word), '[]')
                    FROM (SELECT word, count(*) AS count FROM {words}
                          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30) AS top) AS top_words
            FROM keyword.full_texts AS i JOIN documents AS d ON d.id = i.document_id
            WHERE i.document_id = $1""",
        document_id,
    )
    return {
        "metadata": metadata[0] if metadata else None,
        "full_text": full_text[0] if full_text else None,
    }


async def db_term_test(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """Whether a search term finds a document, by the rule of the matcher's `matched_terms`."""
    term = first(params, "q")
    if not term:
        raise ValueError("Enter a term")
    if not await has_keyword_index(connection):
        raise ValueError("No keyword index yet: run make index")
    [result] = await fetch_json(
        connection,
        """SELECT tsvector_to_array(to_tsvector('english', $2)) AS stems,
                  (SELECT to_tsvector('english', i.content) @@ query
                   FROM keyword.documents AS i WHERE i.document_id = $1) AS metadata,
                  (SELECT i.lexemes @@ query FROM keyword.full_texts AS i
                   WHERE i.document_id = $1 AND i.status = 'indexed') AS full_text
           FROM plainto_tsquery('english', $2) AS query""",
        first(params, "id"),
        term,
    )
    return {"term": term, **result}


async def db_runs(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    limit, offset = page(params)
    rows = await fetch_json(
        connection, "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT $1 OFFSET $2", limit, offset
    )
    total = await connection.fetchval("SELECT count(*) FROM crawl_runs")
    return {"total": total, "offset": offset, "limit": limit, "rows": rows}


async def db_schema(connection: Any) -> dict[str, Any]:
    return {
        "columns": await fetch_json(
            connection,
            f"""SELECT c.oid::regclass::text AS table, a.attname AS name,
                       format_type(a.atttypid, a.atttypmod) AS type,
                       NOT a.attnotnull AS nullable,
                       CASE WHEN a.attidentity <> '' THEN 'identity'
                            WHEN a.attgenerated <> ''
                                THEN 'generated: ' || pg_get_expr(d.adbin, d.adrelid)
                            ELSE pg_get_expr(d.adbin, d.adrelid) END AS default
                FROM pg_attribute AS a
                JOIN pg_class AS c ON c.oid = a.attrelid
                JOIN pg_namespace AS n ON n.oid = c.relnamespace
                LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE {USER_SCHEMA} AND c.relkind IN ('r', 'p')
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY c.oid, a.attnum""",
        ),
        "constraints": await fetch_json(
            connection,
            f"""SELECT o.conrelid::regclass::text AS table, o.conname AS name,
                       pg_get_constraintdef(o.oid) AS definition
                FROM pg_constraint AS o JOIN pg_namespace AS n ON n.oid = o.connamespace
                -- NOT NULL is in the columns already (PostgreSQL 18 lists it here, too).
                WHERE {USER_SCHEMA} AND o.conrelid <> 0 AND o.contype <> 'n'
                ORDER BY 1, o.contype, 2""",
        ),
        "indexes": await fetch_json(
            connection,
            f"""SELECT i.indrelid::regclass::text AS table, c.relname AS name,
                       pg_get_indexdef(i.indexrelid) AS definition,
                       pg_relation_size(i.indexrelid) AS bytes
                FROM pg_index AS i
                JOIN pg_class AS c ON c.oid = i.indexrelid
                JOIN pg_namespace AS n ON n.oid = c.relnamespace
                WHERE {USER_SCHEMA} ORDER BY 1, 2""",
        ),
        "extensions": await fetch_json(
            connection,
            "SELECT extname AS name, extversion AS version FROM pg_extension"
            " WHERE extname <> 'plpgsql' ORDER BY 1",
        ),
    }


async def emptying_plan(connection: Any, names: list[str]) -> dict[str, Any]:
    """What emptying `names` deletes: those tables and every table that references them."""
    existing = await table_names(connection)
    if not names:
        raise ValueError("Choose at least one table")
    if unknown := [name for name in names if name not in existing]:
        raise LookupError(f"No table {', '.join(unknown)}")
    tables = await fetch_json(
        connection,
        """WITH RECURSIVE targets (oid) AS (
               SELECT to_regclass(name)::oid FROM unnest($1::text[]) AS name
               UNION
               SELECT c.conrelid FROM pg_constraint AS c
               JOIN targets AS t ON c.confrelid = t.oid WHERE c.contype = 'f'
           )
           SELECT oid::regclass::text AS name FROM pg_class
           WHERE oid IN (SELECT oid FROM targets) ORDER BY 1""",
        names,
    )
    for table in tables:
        table["rows"] = await connection.fetchval(f"SELECT count(*) FROM {table['name']}")
        table["requested"] = table["name"] in names
    database = await connection.fetchval("SELECT current_database()")
    return {"database": database, "tables": tables}


async def empty_tables(connection: Any, names: list[str], confirm: str) -> dict[str, Any]:
    """Delete every row of `names` and the tables that reference them, in one transaction."""
    database = await connection.fetchval("SELECT current_database()")
    if confirm != database:
        raise ValueError(f"Type the database name, {database}, to confirm")
    async with connection.transaction():
        # Waits for a store run that is writing, as store runs wait for each other.
        await connection.execute("SELECT pg_advisory_xact_lock($1)", STORE_LOCK)
        plan = await emptying_plan(connection, names)
        tables = ", ".join(table["name"] for table in plan["tables"])
        await connection.execute(f"TRUNCATE TABLE {tables} RESTART IDENTITY")
    return {"database": database, "emptied": plan["tables"]}


async def db_table(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """Any table, e.g. one of an index, as plain rows; long values are cut to `CELL_LIMIT`."""
    name = first(params, "name")
    if name not in await table_names(connection):
        raise LookupError(f"No table {name}")
    limit, offset = page(params)
    columns = [
        column["name"]
        for column in await fetch_json(
            connection,
            "SELECT attname AS name FROM pg_attribute WHERE attrelid = to_regclass($1)"
            " AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
            name,
        )
    ]

    def cell(column: str) -> str:
        value = f"t.{quote_ident(column)}"
        return (
            f"CASE WHEN length({value}::text) > {CELL_LIMIT}"
            f" THEN to_jsonb(left({value}::text, {CELL_LIMIT}) || ' … ('"
            f" || length({value}::text) || ' characters)')"
            f" ELSE to_jsonb({value}) END AS {quote_ident(column)}"
        )

    return {
        "name": name,
        "columns": columns,
        "total": await connection.fetchval(f"SELECT count(*) FROM {name}"),
        "offset": offset,
        "limit": limit,
        "rows": await fetch_json(
            connection,
            f"SELECT {', '.join(map(cell, columns))} FROM {name} AS t"
            f" ORDER BY t.{quote_ident(columns[0])} LIMIT $1 OFFSET $2",
            limit,
            offset,
        ),
    }


# ── Index screens: the indexer job, and what the keyword index holds ─────────────

NOT_EXPIRED = "(d.expires_at IS NULL OR d.expires_at > now())"


def to_index(index: str) -> str:
    """A document `d` an index table has not seen or that changed since (`toIndex`, @matcher/db)."""
    return (
        f"({index}.document_id IS NULL OR {index}.document_changed_at"
        f" IS DISTINCT FROM date_trunc('milliseconds', {version('d')}))"
    )


def full_text_state(row: str, document: str) -> str:
    """What the indexer does with the full text of `document`, given its keyword.full_texts `row`.

    Done, the next run leaves it alone: `indexed`, or `skipped` (no usable full text, so only the
    metadata is matched; read again when the document changes). Open, the next run reads it:
    `failed` (tried again in every run), `new` (no row yet), `changed` (a row of an older version).
    """
    return (
        f"CASE WHEN {row}.document_id IS NULL THEN 'new'"
        f" WHEN {row}.status = 'failed' THEN 'failed'"
        f" WHEN {row}.document_changed_at = date_trunc('milliseconds', {version(document)})"
        f" THEN {row}.status ELSE 'changed' END"
    )


def document_full_text() -> str:
    """The full-text state of a row of the documents table."""
    return (
        f"coalesce((SELECT {full_text_state('f', 'documents')} FROM keyword.full_texts AS f"
        " WHERE f.document_id = documents.id), 'new')"
    )
FULL_TEXT_FILTERS = {
    "indexed": ["indexed"],
    "skipped": ["skipped"],
    "failed": ["failed"],
    "unread": ["new", "changed"],
}
"""The full-text filter of the documents table: the columns of the keyword coverage."""


NO_INDEX = (
    "(SELECT NULL::text AS document_id, NULL::timestamptz AS document_changed_at,"
    " NULL::text AS status WHERE false)"
)
"""Stands in for an index table before the first `make index`: every document is to index."""
WORD_BUCKETS = [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 50000]
"""Keywords per full text, for the histogram; 50,000 is the indexer's limit (`MAX_WORDS`)."""
# The estimate of Index › Keyword copies two rules of matcher/download/src: the media types
# `formatOf` reads (extract.ts) and the seconds between two requests to a host (`INTERVAL_MS`
# in downloader.ts). Keep them in step; the indexer itself does not use these copies.
READABLE_TYPES = [
    "application/pdf",
    "application/xml",
    "text/xml",
    "text/html",
    "application/xhtml+xml",
    "text/vtt",
    "application/srt",
    "application/x-subrip",
    "text/srt",
    "text/plain",
]
HOST_INTERVAL = {"arxiv.org": 15, "zenodo.org": 1, "pmc-oa-opendata.s3.amazonaws.com": 0.1}
DEFAULT_INTERVAL = 3
SLOW_QUERY = 30
"""Seconds a query over every full text may take before the view gives up."""
GERMAN_TERMS = MATCHER_DIR / "algorithms" / "keyword" / "data" / "german-terms.json"
TERM_DOCUMENTS = """
WITH terms AS MATERIALIZED (
    SELECT term, plainto_tsquery('english', term) AS query FROM unnest($1::text[]) AS term),
metadata AS MATERIALIZED (
    SELECT to_tsvector('english', content) AS lexemes FROM keyword.documents)
SELECT term, numnode(query) = 0 AS stop_words,
       (SELECT count(*) FROM metadata WHERE lexemes @@ query) AS metadata,
       (SELECT count(*) FROM keyword.full_texts
        WHERE status = 'indexed' AND lexemes @@ query) AS full_text
FROM terms
"""
"""In how many documents each term is found, by the rule of the matcher's `matched_terms`."""

INDEXING: "IndexRun | None" = None
"""The indexer run in progress, or the last one."""


def matcher_missing() -> str | None:
    """What keeps this server from running the matcher's programs, if anything."""
    if shutil.which("node") is None:
        return "node is not on the PATH (the matcher needs Node.js 24)"
    if not (MATCHER_DIR / "node_modules").exists():
        return "The matcher is not installed: run make build"
    return None


def matcher_environment() -> dict[str, str]:
    """The environment of the matcher's programs: this one plus the crawler's `DATABASE_URL`
    and the encoder that this server started."""
    missing = matcher_missing()
    if missing:
        raise ValueError(missing)
    try:
        return with_encoder({**os.environ, "DATABASE_URL": database_url()})
    except StoreError as error:
        raise ValueError(str(error)) from error


INDEX_TECHNIQUES = {
    "all": ([], None, "make index"),
    "keyword": (["keyword"], None, "make index APPROACHES=keyword"),
    "semantic": (["ai_summary"], "qwen,bge", "make index-ai"),
    "qwen": (["ai_summary"], "qwen", "make index-ai SEMANTIC_MODELS=qwen"),
    "bge": (["ai_summary"], "bge", "make index-ai SEMANTIC_MODELS=bge"),
}


class IndexRun(EventLog):
    """One run of the indexer job (`make index`); its output lines are the events."""

    def __init__(self, technique: str = "all") -> None:
        super().__init__()
        arguments, models, command = INDEX_TECHNIQUES[technique]
        self.arguments = arguments
        self.approach = arguments[0] if arguments else None
        self.models = models
        self.command = command
        self.process: subprocess.Popen[str] | None = None
        self.cancel_requested = False

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "command": self.command,
            "approach": self.approach,
            "started_at": self.started_at,
            "status": self.status,
            "duration": self.duration,
        }


def run_indexer(run: IndexRun, environment: dict[str, str]) -> None:
    """Runs the indexer job like `make index` and reports its output line by line."""
    run.emit("index_started", command=run.command)
    code: int | None = None
    try:
        run.process = subprocess.Popen(
            ["node", "src/main.ts", *run.arguments],
            cwd=MATCHER_DIR / "indexer",
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert run.process.stdout is not None
        for line in run.process.stdout:
            run.emit("line", text=URL_PASSWORD.sub(r"\1<redacted>@", line.rstrip()))
        code = run.process.wait()
    except OSError as error:
        run.emit("line", text=describe_error(error))
    finally:
        run.duration = round(time.monotonic() - run.started, 2)
        # Together, so that a stream never ends before the last event.
        with run.changed:
            if run.cancel_requested:
                run.status = "cancelled"
            else:
                run.status = "finished" if code == 0 else "failed"
            run.emit("index_" + run.status, code=code)


def start_indexer(technique: str = "all") -> IndexRun:
    global INDEXING
    if not isinstance(technique, str) or technique not in INDEX_TECHNIQUES:
        raise ValueError("Choose all, keyword, semantic, qwen or bge")
    if INDEX_TECHNIQUES[technique][1] and encoder_state()["status"] != "running":
        raise RuntimeError("The AI index needs the encoder: start it and wait until it runs")
    environment = matcher_environment()
    with LOCK:
        if INDEXING is not None and INDEXING.status == "running":
            raise RuntimeError("The indexer is already running")
        run = INDEXING = IndexRun(technique)
        if run.models:
            environment["SEMANTIC_MODEL"] = run.models.split(",")[0]
            environment["SEMANTIC_MODELS"] = run.models
    threading.Thread(target=run_indexer, args=(run, environment), daemon=True).start()
    return run


def stop_indexer() -> dict[str, Any]:
    """Like Ctrl+C: the next run continues with the documents not read yet."""
    run = INDEXING
    if run is None or run.status != "running" or run.process is None:
        raise RuntimeError("The indexer is not running")
    run.cancel_requested = True
    run.emit("cancel_requested")
    run.process.send_signal(signal.SIGINT)
    return run.summary()


def indexer_state(*, events: bool = False) -> dict[str, Any]:
    run = INDEXING
    state: dict[str, Any] = {"missing": matcher_missing(), "run": run.summary() if run else None,
                             "techniques": list(INDEX_TECHNIQUES)}
    if events and run is not None:
        state["events"] = list(run.events)
    return state


# ── Index › AI: the local encoder of the AI approach (scripts/semantic.py) ──────────────────

ENCODER_URL = "http://127.0.0.1:8766"
"""Where the matcher looks for the encoder without SEMANTIC_URL."""
ENCODER_SERVICE = "patient-journey-semantic"
ENCODER_LINES = 30
ENCODER_LOCK = threading.Lock()
LOOPBACK = ("localhost", "127.0.0.1", "::1")
PROGRESS = re.compile(r"(.+?):\s+\d+%\|")
"""A step of a download's progress bar; it replaces the step before of the same file."""


class Encoder:
    """The encoder this server started, with the last lines it wrote."""

    def __init__(self, process: "subprocess.Popen[str]", port: int, device: str) -> None:
        self.process = process
        self.url = f"http://127.0.0.1:{port}"
        self.device = device
        self.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.lines: list[str] = []
        self.lines_lock = threading.Lock()

    def running(self) -> bool:
        return self.process.poll() is None

    def read_output(self) -> None:
        assert self.process.stdout is not None
        for text in self.process.stdout:
            line = text.rstrip()
            if not line:
                continue
            progress = PROGRESS.match(line)
            with self.lines_lock:
                last = PROGRESS.match(self.lines[-1]) if self.lines else None
                if progress and last and last[1] == progress[1]:
                    self.lines[-1] = line
                else:
                    self.lines = [*self.lines[1 - ENCODER_LINES :], line]


ENCODER: Encoder | None = None
"""The encoder this server started, until it is stopped; one that failed stays to show why."""


def encoder_device() -> str:
    """The device of the encoder; the matcher's requests must name the same one."""
    device = os.environ.get("SEMANTIC_DEVICE") or "cpu"
    if device not in ("cpu", "mps"):
        raise ValueError("SEMANTIC_DEVICE must be cpu or mps")
    return device


def encoder_health(url: str) -> dict[str, Any] | None:
    """What the encoder at `url` says of itself, or None if none answers there."""
    if urlsplit(url).hostname not in LOOPBACK:
        return None
    try:
        with LOCAL.open(f"{url.rstrip('/')}/health", timeout=0.5) as response:
            data = json.load(response)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return data if isinstance(data, dict) and data.get("service") == ENCODER_SERVICE else None


def encoder_state() -> dict[str, Any]:
    """The encoder the matcher's programs reach: the one this server started, else one that
    answers at SEMANTIC_URL, such as that of make debug-ai, which only that command stops."""
    encoder = ENCODER
    if encoder is not None:
        with encoder.lines_lock:
            lines = list(encoder.lines)
        code = encoder.process.poll()
        status = (
            "failed" if code is not None
            else "running" if encoder_health(encoder.url)
            else "starting"
        )
        return {"status": status, "own": True, "url": encoder.url, "device": encoder.device,
                "started_at": encoder.started_at, "code": code, "lines": lines}
    url = os.environ.get("SEMANTIC_URL") or ENCODER_URL
    health = encoder_health(url)
    return {"status": "running" if health else "stopped", "own": False, "url": url,
            "device": health.get("device") if health else encoder_device(), "lines": []}


def with_encoder(environment: dict[str, str]) -> dict[str, str]:
    """`environment` with the address and device of the encoder this server started."""
    encoder = ENCODER
    if encoder is not None and encoder.running():
        environment = {
            **environment, "SEMANTIC_URL": encoder.url, "SEMANTIC_DEVICE": encoder.device
        }
    return environment


def free_port(preferred: int) -> int:
    """`preferred`, or any free port if it is taken. The encoder opens its port only after it
    has loaded both models, so a taken one would fail minutes later."""
    with socket.socket() as connection:
        try:
            connection.bind(("127.0.0.1", preferred))
        except OSError:
            connection.bind(("127.0.0.1", 0))
        return int(connection.getsockname()[1])


def start_encoder() -> dict[str, Any]:
    """Starts the encoder like make debug-ai does. It loads both models before it answers and
    downloads the weights that are missing."""
    global ENCODER
    with ENCODER_LOCK:
        state = encoder_state()
        if state["status"] in ("starting", "running"):
            raise RuntimeError(f"An encoder is already {state['status']} at {state['url']}")
        device = encoder_device()
        endpoint = urlsplit(os.environ.get("SEMANTIC_URL") or ENCODER_URL)
        if endpoint.hostname not in LOOPBACK:
            raise ValueError("SEMANTIC_URL must use a loopback host")
        port = free_port(endpoint.port or 8766)
        environment = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        try:
            process = subprocess.Popen(
                ["uv", "run", "--locked", "scripts/semantic.py", "--prepare",
                 "--device", device, "--port", str(port)],
                cwd=ROOT,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                # Its own process group: a stop reaches the Python that uv starts.
                start_new_session=True,
            )
        except OSError as error:
            raise RuntimeError(describe_error(error)) from error
        encoder = ENCODER = Encoder(process, port, device)
    # Read all the time: a full pipe would halt the encoder.
    threading.Thread(target=encoder.read_output, daemon=True).start()
    return encoder_state()


def stop_process_group(process: "subprocess.Popen[str]") -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def stop_encoder() -> dict[str, Any]:
    """Stops the encoder this server started, or forgets the one that failed."""
    global ENCODER
    with ENCODER_LOCK:
        encoder, run = ENCODER, INDEXING
        if encoder is None:
            raise RuntimeError("This UI started no encoder; the command that started it stops it")
        indexing = run is not None and run.status == "running" and run.approach != "keyword"
        if encoder.running() and indexing:
            raise RuntimeError("The indexer is using the encoder: stop the indexer first")
        stop_process_group(encoder.process)
        ENCODER = None
    return encoder_state()


def semantic_profiles() -> list[dict[str, Any]]:
    """Read the canonical encoder configuration and table names from the matcher."""
    script = (
        "import {configuration,indexTable} from '../algorithms/ai-summary/src/encoder.ts';"
        "console.log(JSON.stringify(['qwen','bge'].map(model=>"
        "({...configuration(model),table:indexTable(model)}))));"
    )
    done = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=MATCHER_DIR / "indexer", env=dict(os.environ),
        capture_output=True, text=True, check=True, timeout=10,
    )
    return json.loads(done.stdout)


async def semantic_overview(connection: Any, technique: str) -> dict[str, Any]:
    profiles = semantic_profiles()
    chosen = [p for p in profiles if technique == "semantic" or p["model"] == technique]
    has_ready = await connection.fetchval("SELECT to_regclass('ai_summary.ready') IS NOT NULL")
    models = []
    for profile in chosen:
        table = profile["table"]
        if not re.fullmatch(r"ai_summary\.[a-z][a-z0-9_]+", table):
            raise ValueError("Invalid semantic index table")
        exists = bool(await connection.fetchval("SELECT to_regclass($1) IS NOT NULL", table))
        index = table if exists else (
            "(SELECT NULL::text AS document_id, NULL::timestamptz AS document_changed_at,"
            " NULL::text AS embedding WHERE false)"
        )
        pending = to_index("i")
        coverage = await fetch_json(connection, f"""
            SELECT d.source, d.content_type, count(*) AS documents,
                   count(*) FILTER (WHERE NOT {pending} AND i.embedding IS NOT NULL) AS indexed,
                   count(*) FILTER (WHERE {pending}) AS pending,
                   count(*) FILTER (WHERE NOT {pending} AND i.embedding IS NULL) AS empty
            FROM documents AS d LEFT JOIN {index} AS i ON i.document_id = d.id
            WHERE {NOT_EXPIRED}
            GROUP BY 1, 2 ORDER BY 1, 2
        """)
        totals = {key: sum(row[key] for row in coverage)
                  for key in ("documents", "indexed", "pending", "empty")}
        ready = exists and has_ready and bool(await connection.fetchval(
            "SELECT EXISTS (SELECT 1 FROM ai_summary.ready WHERE index_table = $1)", table
        ))
        models.append({**profile, **totals, "ready": ready, "coverage": coverage})
    return {"technique": technique, "indexer": indexer_state(), "models": models}


async def index_overview(connection: Any, technique: str = "keyword") -> dict[str, Any]:
    if technique not in INDEX_TECHNIQUES:
        raise ValueError("Unknown indexing technique")
    if technique in ("semantic", "qwen", "bge"):
        return await semantic_overview(connection, technique)
    exists = await has_keyword_index(connection)
    metadata = "keyword.documents" if exists else NO_INDEX
    full_texts = "keyword.full_texts" if exists else NO_INDEX
    [extension] = await fetch_json(
        connection,
        """SELECT (SELECT default_version FROM pg_available_extensions
                   WHERE name = 'pg_textsearch') AS available,
                  (SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch')
                      AS installed,
                  current_setting('shared_preload_libraries') ~ '\\mpg_textsearch\\M'
                      AS preloaded""",
    )
    overview: dict[str, Any] = {
        "technique": technique,
        "exists": exists,
        "extension": extension,
        "indexer": indexer_state(),
        # The stacked bars: the state of each document's full text (`full_text_state`).
        "coverage": await fetch_json(
            connection,
            f"""SELECT d.source, d.content_type, count(*) AS documents,
                       count(m.document_id) AS metadata,
                       count(*) FILTER (WHERE {to_index("m")}) AS metadata_to_index,
                       count(*) FILTER (WHERE s.state = 'indexed') AS indexed,
                       count(*) FILTER (WHERE s.state = 'skipped') AS skipped,
                       count(*) FILTER (WHERE s.state = 'failed') AS failed,
                       count(*) FILTER (WHERE s.state IN ('new', 'changed')) AS unread,
                       count(*) FILTER (WHERE s.state NOT IN ('indexed', 'skipped')) AS to_read
                FROM documents AS d
                LEFT JOIN {metadata} AS m ON m.document_id = d.id
                LEFT JOIN {full_texts} AS i ON i.document_id = d.id
                CROSS JOIN LATERAL (SELECT {full_text_state("i", "d")} AS state) AS s
                WHERE {NOT_EXPIRED}
                GROUP BY 1, 2 ORDER BY 1, 2""",
        ),
        # Where the next run downloads from: the host of the first file the downloader reads.
        "hosts": await fetch_json(
            connection,
            f"""SELECT file.host, count(*) AS documents
                FROM documents AS d
                LEFT JOIN {full_texts} AS i ON i.document_id = d.id
                LEFT JOIN LATERAL (
                    SELECT substring(e.locator ->> 'url' from '^[a-z]+://([^/:?#]+)') AS host
                    FROM jsonb_array_elements(d.full_text) WITH ORDINALITY AS e (locator, position),
                         lower(trim(split_part(coalesce(e.locator ->> 'media_type', ''), ';', 1)))
                             AS media_type
                    WHERE media_type = ANY ($1::text[])
                       OR (media_type = 'application/json' AND e.locator ->> 'kind' = 'transcript')
                    ORDER BY e.position LIMIT 1
                ) AS file ON true
                WHERE {NOT_EXPIRED}
                  AND {full_text_state("i", "d")} NOT IN ('indexed', 'skipped')
                GROUP BY 1 ORDER BY 2 DESC, 1""",
            READABLE_TYPES,
        ),
    }
    for host in overview["hosts"]:
        interval = HOST_INTERVAL.get(host["host"], DEFAULT_INTERVAL)
        host["seconds"] = None if host["host"] is None else round(host["documents"] * interval)
    if not exists:
        return overview
    # Like the coverage: a changed document counts as to read, whatever its old row says.
    overview["reasons"] = await fetch_json(
        connection,
        f"""SELECT i.status, i.detail, count(*) AS documents
            FROM keyword.full_texts AS i JOIN documents AS d ON d.id = i.document_id
            WHERE {NOT_EXPIRED} AND {full_text_state("i", "d")} <> 'changed'
            GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2""",
    )
    overview["formats"] = await fetch_json(
        connection,
        "SELECT media_type, count(*) AS documents, sum(words) AS words FROM keyword.full_texts"
        " WHERE status = 'indexed' GROUP BY 1 ORDER BY 2 DESC, 1",
    )
    [words] = await fetch_json(
        connection,
        """SELECT count(*) AS documents, coalesce(sum(words), 0) AS words, min(words) AS min,
                  max(words) AS max, max(fetched_at) AS last_read,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY words) AS median
           FROM keyword.full_texts WHERE status = 'indexed'""",
    )
    counts = {
        row["bucket"]: row["documents"]
        for row in await fetch_json(
            connection,
            "SELECT width_bucket(words, $1::int[]) AS bucket, count(*) AS documents"
            " FROM keyword.full_texts WHERE status = 'indexed' GROUP BY 1",
            WORD_BUCKETS,
        )
    }
    edges = [1, *WORD_BUCKETS]
    words["buckets"] = [
        {
            "from": edge,
            "to": edges[index + 1] - 1 if index + 1 < len(edges) else None,
            "documents": counts.get(index, 0),
        }
        for index, edge in enumerate(edges)
    ]
    overview["words"] = words
    return overview


async def index_vocabulary(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """The most frequent keywords of all full texts: what the keyword filter lets through."""
    if not await has_keyword_index(connection):
        raise ValueError("No keyword index yet: run make index")
    limit, _ = page(params)
    needle = first(params, "q").lower()
    return {
        "rows": await fetch_json(
            connection,
            """SELECT top.*, tsvector_to_array(to_tsvector('english', top.word)) AS stems
               FROM (SELECT word, count(*) AS count, count(DISTINCT i.document_id) AS documents
                     FROM keyword.full_texts AS i, string_to_table(i.terms, ' ') AS word
                     WHERE i.status = 'indexed' AND word <> '' AND strpos(word, $2) > 0
                     GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT $1) AS top
               ORDER BY top.count DESC, top.word""",
            limit,
            needle,
            timeout=SLOW_QUERY,
        ),
        "documents": await connection.fetchval(
            "SELECT count(*) FROM keyword.full_texts WHERE status = 'indexed'"
        ),
    }


async def term_documents(connection: Any, terms: list[str]) -> dict[str, Any]:
    """In how many documents each of `terms` is found, with the totals to compare with."""
    if not await has_keyword_index(connection):
        raise ValueError("No keyword index yet: run make index")
    [totals] = await fetch_json(
        connection,
        "SELECT (SELECT count(*) FROM keyword.documents) AS metadata,"
        " (SELECT count(*) FROM keyword.full_texts WHERE status = 'indexed') AS full_text",
    )
    rows = await fetch_json(connection, TERM_DOCUMENTS, terms, timeout=SLOW_QUERY)
    return {"totals": totals, "terms": rows}


async def journey_terms(connection: Any) -> dict[str, Any]:
    """The English terms of german-terms.json and how many documents each finds."""
    translations: dict[str, str] = json.loads(GERMAN_TERMS.read_text(encoding="utf-8"))[
        "translations"
    ]
    german: dict[str, list[str]] = {}
    for word, term in translations.items():
        german.setdefault(term, []).append(word)
    result = await term_documents(connection, list(german))
    for row in result["terms"]:
        row["german"] = german[row["term"]]
    return result


# ── Transcription job: its setting, and what it reports (the table transcription) ──

NO_SPEECH_TO_TEXT = "audio, and speech-to-text is off"
"""Why an index skipped a document whose audio has no stored transcript yet (@matcher/download)."""
# The documents that wait for the job: `WAITING` in matcher/transcriber/src/job.ts. Keep the two
# in step; the job itself does not use this copy.
WAITING_AUDIO = f"""
FROM documents AS d LEFT JOIN transcripts AS t ON t.document_id = d.id
WHERE d.full_text @> '[{{"kind": "audio"}}]' AND NOT d.full_text @> '[{{"kind": "transcript"}}]'
  AND {NOT_EXPIRED}
  AND (jsonb_typeof(d.extra -> 'metadata_language') = 'string'
       AND d.extra ->> 'metadata_language' <> ''
       AND d.extra ->> 'metadata_language' !~* '^en(-|$)') IS NOT TRUE
  AND (t.document_id IS NULL
       OR NOT d.full_text @> jsonb_build_array(jsonb_build_object('url', t.url))
       OR (t.status = 'failed' AND t.read_at < now() - interval '1 day'))
"""
JOB_REPORTS = 10
"""Seconds after its last report that the job counts as running; it reports every 2 s."""
TRANSCRIBE_UNIT = "matcher-transcribe.service"
UNIT_STATE: dict[str, Any] = {"at": 0.0, "state": None}
UNIT_LOCK = threading.Lock()


def transcribe_unit() -> str | None:
    """The state of the job's systemd unit, as on the VM; None where there is none."""
    with UNIT_LOCK:
        if time.monotonic() - UNIT_STATE["at"] >= INFO_TTL or not UNIT_STATE["at"]:
            unit = systemd_units([TRANSCRIBE_UNIT]).get(TRANSCRIBE_UNIT)
            UNIT_STATE.update(at=time.monotonic(), state=unit and unit.get("ActiveState"))
        return UNIT_STATE["state"]  # type: ignore[no-any-return]


def default_max_workers() -> int:
    """The most files a job on this machine reads at once, until a job reports its own.

    The rule of matcher/transcriber/src/main.ts: four threads per file.
    """
    cpus = os.cpu_count() or 1
    return max(1, cpus // min(4, cpus))


async def transcription_overview(connection: Any) -> dict[str, Any]:
    """The setting, what the job reported last, and how much audio waits or is read."""
    overview: dict[str, Any] = {
        "exists": False,
        "workers": 0,
        "running": False,
        "state": None,
        "reported_at": None,
        "max_workers": default_max_workers(),
        "cpus": os.cpu_count(),
        "unit": transcribe_unit(),
        "waiting_detail": NO_SPEECH_TO_TEXT,
        "waiting": None,
        "read": [],
    }
    if not await connection.fetchval("SELECT to_regclass('public.transcripts') IS NOT NULL"):
        return overview
    overview["exists"] = True
    rows = await fetch_json(
        connection,
        f"""SELECT workers, state, reported_at,
                   coalesce(reported_at > now() - interval '{JOB_REPORTS} seconds', false)
                       AS running
            FROM transcription""",
    )
    if rows:
        overview.update(rows[0])
        reported = (overview["state"] or {}).get("max_workers")
        overview["max_workers"] = reported or overview["max_workers"]
    [overview["waiting"]] = await fetch_json(
        connection,
        f"""SELECT count(*) AS documents, coalesce(sum(d.duration_seconds), 0) AS seconds,
                   count(*) FILTER (WHERE d.duration_seconds IS NULL) AS unknown
            {WAITING_AUDIO}""",
    )
    # What became of the audio read so far, whichever run read it.
    overview["read"] = await fetch_json(
        connection,
        """SELECT t.status, count(*) AS documents, coalesce(sum(d.duration_seconds), 0) AS seconds
           FROM transcripts AS t JOIN documents AS d ON d.id = t.document_id
           GROUP BY 1 ORDER BY 1""",
    )
    return overview


async def set_transcription_workers(connection: Any, workers: Any) -> dict[str, Any]:
    """Sets how many audio files the job reads at once; the running job follows within seconds."""
    overview = await transcription_overview(connection)
    if not overview["exists"]:
        raise ValueError("This database has no transcription table yet: run make db")
    most = overview["max_workers"]
    if isinstance(workers, bool) or not isinstance(workers, int) or not 0 <= workers <= most:
        raise ValueError(f"workers must be a whole number from 0 to {most}")
    await connection.execute(
        "INSERT INTO transcription (workers) VALUES ($1)"
        " ON CONFLICT (only_row) DO UPDATE SET workers = EXCLUDED.workers",
        workers,
    )
    return await transcription_overview(connection)


def string_list(body: dict[str, Any], key: str, limit: int) -> list[str]:
    values = body.get(key)
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise ValueError(f"{key} must be a list of texts")
    if len(values) > limit:
        raise ValueError(f"At most {limit} {key}")
    return values


# ── Matcher screen: match_journey for a journey, with the steps of the match ─────

JOURNEYS_DIR = ROOT / "patientdata"
"""The synthetic journeys of #14, one `timeline.json` per patient."""
JOURNEY_ID = re.compile(r"[0-9A-Za-z_-]+")
DEMO_JOURNEY = {
    "patient_id": "demo-1",
    "events": [
        {
            "id": "e1",
            "type": "surgery",
            "label": "Radikale Prostatektomie",
            "date": "2027-01-22",
        },
        {
            "id": "e2",
            "type": "progression",
            "label": "PSA-Anstieg – Biochemisches Rezidiv",
            "date": "2028-12-25",
        },
    ],
}
"""The journey of the example arguments in Documentation/user/mcp-interface.md."""
MATCH_TIMEOUT = 60
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))
"""Opens URLs of this machine without a proxy."""


def mcp_port() -> int:
    """The port of `make start`."""
    return int(os.environ.get("MCP_PORT") or 3000)


def mcp_running() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", mcp_port()), timeout=0.3):
            return True
    except OSError:
        return False


def match_meta() -> dict[str, Any]:
    def number(path: Path) -> tuple[int, str]:
        digits = re.search(r"\d+", path.parent.name)
        return int(digits.group()) if digits else 0, path.parent.name

    stored = sorted(JOURNEYS_DIR.glob("*/timeline.json"), key=number)
    return {
        "journeys": ["demo", *(path.parent.name for path in stored)],
        "missing": matcher_missing(),
        "mcp": {"url": f"http://127.0.0.1:{mcp_port()}/mcp", "running": mcp_running()},
    }


def load_journey(journey_id: str) -> Any:
    if journey_id == "demo":
        return DEMO_JOURNEY
    path = JOURNEYS_DIR / journey_id / "timeline.json"
    if not JOURNEY_ID.fullmatch(journey_id) or not path.exists():
        raise LookupError(f"No journey {journey_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def run_matcher(command: str, request: dict[str, Any], technique: str | None = None) -> dict[str, Any]:
    """A tool by the matcher's own code: `explain` is `match_journey` with the steps of the
    match, `get_source` is that tool."""
    environment = matcher_environment()
    if technique is not None:
        if technique not in ("qwen", "bge"):
            raise ValueError("Unknown semantic technique")
        environment["SEMANTIC_MODEL"] = technique
    try:
        done = subprocess.run(
            ["node", "src/main.ts", command],
            cwd=MATCHER_DIR / "mcp-server",
            env=environment,
            input=json.dumps(request),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=MATCH_TIMEOUT,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"The matcher did not answer within {MATCH_TIMEOUT} s") from error
    try:
        answer: dict[str, Any] = json.loads(done.stdout)
        return answer
    except json.JSONDecodeError as error:
        lines = URL_PASSWORD.sub(r"\1<redacted>@", done.stderr).strip().splitlines()
        # Node prints the error message after the source line and before the stack.
        message = next((line for line in lines if re.match(r"\w*Error\b", line)), "")
        message = message or f"The matcher failed (exit code {done.returncode})"
        raise RuntimeError(message) from error


# ── Index › Graph: the normalization of patient graphs and PubTator3 annotations (#80) ───

GRAPH_DIR = MATCHER_DIR / "algorithms" / "graph"
PUBTATOR_FIXTURES = GRAPH_DIR / "fixtures" / "pubtator"
GRAPH_TIMEOUT = 30
GRAPH_ENVIRONMENT = ("PATH", "HOME", "LANG", "SYSTEMROOT")
"""All the normalizer gets of this server's environment: it needs no keys and no database."""


def graph_meta() -> dict[str, Any]:
    """The graphs the screen can show: patient graphs of `make graph` and PubTator3 fixtures."""

    def number(path: Path) -> tuple[int, str]:
        digits = re.search(r"\d+", path.parent.name)
        return int(digits.group()) if digits else 0, path.parent.name

    patients = sorted(JOURNEYS_DIR.glob("*/graph.json"), key=number)
    return {
        "patients": [path.parent.name for path in patients],
        "papers": sorted(path.stem for path in PUBTATOR_FIXTURES.glob("*.json")),
        "missing": matcher_missing(),
    }


def graph_file(kind: str, name: str) -> Path:
    if not JOURNEY_ID.fullmatch(name):
        raise ValueError(f"Not a graph name: {name}")
    if kind == "patient":
        path = JOURNEYS_DIR / name / "graph.json"
    elif kind == "paper":
        path = PUBTATOR_FIXTURES / f"{name}.json"
    else:
        raise ValueError(f"Not a graph kind: {kind}")
    if not path.exists():
        raise LookupError(f"No {kind} graph {name}")
    return path


def graph_normalize(kind: str, name: str, min_score: str) -> dict[str, Any]:
    """The NormalizedGraph of one file, by the graph package's own `normalize --json`, and how
    many nodes and edges or annotations and relations the file has before it."""
    path = graph_file(kind, name)
    try:
        score = float(min_score or 0)
    except ValueError as error:
        raise ValueError(f"min_score is not a number: {min_score}") from error
    if not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError(f"min_score must be between 0 and 1: {min_score}")
    missing = matcher_missing()
    if missing:
        raise ValueError(missing)
    try:
        done = subprocess.run(
            ["node", "scripts/normalize.ts", str(path), "--json", "--min-score", str(score)],
            cwd=GRAPH_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=GRAPH_TIMEOUT,
            env={key: os.environ[key] for key in GRAPH_ENVIRONMENT if key in os.environ},
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"The normalization did not finish within {GRAPH_TIMEOUT} s") from error
    graphs: Any = None
    if done.returncode == 0:
        with contextlib.suppress(json.JSONDecodeError):
            graphs = json.loads(done.stdout)
    if not isinstance(graphs, list):
        lines = (done.stderr.strip() or done.stdout.strip()).splitlines()
        message = next((line for line in lines if re.match(r"\w*Error\b", line)), "")
        message = message or f"The normalization failed (exit code {done.returncode})"
        raise RuntimeError(message)
    if not graphs:
        raise LookupError(f"The {kind} file {name} has no document")
    return {"kind": kind, "name": name, "before": graph_size(kind, path), "graph": graphs[0],
            "original": json.loads(path.read_text(encoding="utf-8")) if kind == "patient" else None}


def graph_size(kind: str, path: Path) -> dict[str, int]:
    """How many nodes and edges, or annotations and relations of the first document, a file
    has. The normalizer has read it already, so an odd shape only gives zeros here."""
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = None

    def items(value: Any, key: str) -> list[Any]:
        found = value.get(key) if isinstance(value, dict) else None
        return found if isinstance(found, list) else []

    if kind == "patient":
        return {"nodes": len(items(raw, "nodes")), "edges": len(items(raw, "edges"))}
    # An export (`{"PubTator3": [...]}`), a list of documents or one document, as the script reads.
    documents = raw if isinstance(raw, list) else items(raw, "PubTator3") or [raw]
    first = documents[0] if documents else None
    return {
        "annotations": sum(len(items(p, "annotations")) for p in items(first, "passages")),
        "relations": len(items(first, "relations")),
    }


def call_mcp(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """A tool of the running MCP server (`make start`), as a client gets it."""
    call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    url = f"http://127.0.0.1:{mcp_port()}/mcp"
    request = urllib.request.Request(
        url,
        data=json.dumps(call).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with LOCAL.open(request, timeout=MATCH_TIMEOUT) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"The MCP server answered HTTP {error.code}") from error
    except OSError as error:
        # urllib wraps what went wrong on connecting; a timeout while reading comes as it is.
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        if isinstance(reason, ConnectionRefusedError):
            raise RuntimeError(f"No MCP server on {url}: run make start") from error
        if isinstance(reason, TimeoutError):
            raise RuntimeError(
                f"The MCP server on {url} did not answer within {MATCH_TIMEOUT} s"
            ) from error
        raise RuntimeError(f"The MCP server on {url} could not be reached: {reason}") from error
    # The server answers as an event stream with one message.
    data = [line[5:] for line in body.splitlines() if line.startswith("data:")]
    not_mcp = f"{url} did not answer like an MCP server"
    try:
        message = json.loads("".join(data) or body)
    except json.JSONDecodeError as error:
        raise RuntimeError(not_mcp) from error
    if not isinstance(message, dict):
        raise RuntimeError(not_mcp)
    if "error" in message:
        failure = message["error"]
        return {"error": {"code": str(failure.get("code")), "message": failure.get("message")}}
    result = message.get("result")
    if not isinstance(result, dict):
        raise RuntimeError(not_mcp)
    if result.get("isError"):
        text = "".join(part.get("text", "") for part in result.get("content", []))
        try:
            refused = json.loads(text)
            return {"error": {"code": refused["error_code"], "message": refused["message"]}}
        except (ValueError, KeyError, TypeError):
            return {"error": {"code": "INVALID_REQUEST", "message": text}}
    if "structuredContent" not in result:
        raise RuntimeError(not_mcp)
    return {"answer": result["structuredContent"]}


def match(body: dict[str, Any]) -> dict[str, Any]:
    request = body.get("request")
    if not isinstance(request, dict):
        raise ValueError("request must be the arguments of match_journey")
    started = time.monotonic()
    if body.get("via") == "mcp":
        # Tuning is not part of the tool: the server ranks with its own constants.
        arguments = {key: value for key, value in request.items() if key != "tuning"}
        result = {"steps": [], **call_mcp("match_journey", arguments)}
    else:
        technique = body.get("technique")
        if technique is not None and (
            technique not in ("qwen", "bge") or request.get("algorithm") != "ai_summary"
        ):
            raise ValueError("Invalid semantic technique")
        if request.get("algorithm") == "ai_summary" and encoder_state()["status"] != "running":
            raise RuntimeError("The AI approach needs the encoder: start it under Index › AI")
        result = run_matcher("explain", request, technique)
    return {**result, "seconds": round(time.monotonic() - started, 2)}


def source(body: dict[str, Any]) -> dict[str, Any]:
    """`get_source` for the example client, the same way as its match."""
    source_id = body.get("source_id")
    if not isinstance(source_id, str):
        raise ValueError("source_id must be the ID of a source")
    arguments = {"source_id": source_id}
    started = time.monotonic()
    if body.get("via") == "mcp":
        result = call_mcp("get_source", arguments)
    else:
        result = run_matcher("get_source", arguments)
    return {**result, "seconds": round(time.monotonic() - started, 2)}


# ── HTTP ──────────────────────────────────────────────────────────────────────


# ── Info screen: the machine, the timers, what runs, the topic files ─────────

INFO_TTL = 30.0  # seconds; systemd, Docker, processes, the database and git are probed this rarely
PROBE_TIMEOUT = 2.0
VM_SETUP = ROOT / "deploy" / "vm-setup.sh"
BACKUP_DIR = Path("/var/backups/matcher")
SOURCE_NAMES = {
    "pubmed": "PubMed",
    "arxiv": "arXiv",
    "zenodo": "Zenodo",
    "youtube": "YouTube",
    "podcast": "Podcast",
}
JOB_LABELS = {
    "matcher-index": "Index update",
    "matcher-backup": "Database backup",
    "matcher-prune": "Docker cleanup",
}
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
CALENDAR = re.compile(
    r"(?:(?P<day>Mon|Tue|Wed|Thu|Fri|Sat|Sun) )?\*-\*-\* "
    r"(?P<hour>\d\d):(?P<minute>\d\d):(?P<second>\d\d) UTC"
)
SLOW: dict[str, Any] = {"at": 0.0, "data": None}
SLOW_LOCK = threading.Lock()
# The last CPU times, when they were read and the busy share since the reading before
CPU: dict[str, Any] = {"at": 0.0, "times": None, "value": None}
CPU_LOCK = threading.Lock()
# psutil.Process objects kept between probes: their CPU share is measured since the last probe
PROCESSES: dict[tuple[int, float], Any] = {}
try:
    psutil: Any = importlib.import_module("psutil")  # comes with the crawler's dependencies
except ImportError:  # pragma: no cover - the screen then shows less of the machine
    psutil = None


def probe(argv: list[str], **env: str) -> str | None:
    """The output of a read-only command; None if it is missing, fails or takes too long."""
    if shutil.which(argv[0]) is None:
        return None
    try:
        done = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT,
            check=False,
            env={**os.environ, **env} if env else None,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return done.stdout if done.returncode == 0 else None


def guarded(section: Callable[[], Any]) -> Any:
    """One section of the info; its failure is shown there, not as an error of the screen."""
    try:
        return section()
    except Exception as error:
        return {"error": describe_error(error)}


def machine() -> dict[str, Any]:
    """Load, memory and disk now: cheap enough for every poll."""
    disk = shutil.disk_usage(ROOT)
    data: dict[str, Any] = {
        "host": socket.gethostname(),
        "os": platform.platform(terse=True),
        "cpus": os.cpu_count(),
        "load": list(os.getloadavg()) if hasattr(os, "getloadavg") else None,
        "disk": {"path": str(ROOT), "total": disk.total, "used": disk.used},
        "memory": None,
        "uptime": None,
        "cpu": None,
    }
    if psutil is not None:
        memory = psutil.virtual_memory()
        data["memory"] = {"total": memory.total, "used": memory.total - memory.available}
        data["uptime"] = round(time.time() - psutil.boot_time())
        data["cpu"] = cpu_share(psutil.cpu_times())
    return data


def cpu_share(times: Any) -> float | None:
    """How busy all cores were since the reading before, at most one reading a second.

    Not psutil.cpu_percent(): it keeps its last reading per thread, and every request has a
    thread of its own. The same sums as psutil's: guest time is part of user time on Linux.
    """
    total = sum(times) - getattr(times, "guest", 0.0) - getattr(times, "guest_nice", 0.0)
    idle = times.idle + getattr(times, "iowait", 0.0)
    with CPU_LOCK:
        now = time.monotonic()
        if now - CPU["at"] >= 1.0:
            last = CPU["times"]
            if last is not None and total > last[0]:
                CPU["value"] = round(100 * (1 - (idle - last[1]) / (total - last[0])), 1)
            CPU.update(at=now, times=(total, idle))
        return CPU["value"]  # type: ignore[no-any-return]


def own_runs() -> dict[str, Any]:
    """The crawler and indexer runs started from this page."""
    crawl, index = CURRENT, INDEXING
    return {
        "crawl": None
        if crawl is None
        else {
            "id": crawl.id,
            "command": crawl.command,
            "started_at": crawl.started_at,
            "store": crawl.store_url is not None,
        },
        "index": None
        if index is None or index.status != "running"
        else {"id": index.id, "command": index.command, "started_at": index.started_at},
    }


def planned_jobs() -> list[dict[str, Any]]:
    """The timers deploy/vm-setup.sh installs on the VM: every one of them, or an error."""
    text = VM_SETUP.read_text(encoding="utf-8")
    loop = re.search(r"^for entry in ([\w=: ]+); do$", text, re.MULTILINE)
    jobs: list[dict[str, Any]] = []
    for call in re.findall(r"^\s*timer\s+(.+)$", text, re.MULTILINE):
        if call.startswith('"crawler-$name" "*-*-* ${entry#*=}:00 UTC"') and loop:
            for entry in loop.group(1).split():
                name, _, at = entry.partition("=")
                jobs.append(
                    {
                        "id": f"crawler-{name}",
                        "label": f"{SOURCE_NAMES.get(name, name)} crawl",
                        "calendar": f"*-*-* {at}:00 UTC",
                        "unit": f"crawler@{name}.service",
                        "source": name,
                    }
                )
            continue
        match = re.fullmatch(r'([\w-]+) "([^"]+)" (\S+) "[^"]*"', call.strip())
        if match is None:
            raise ValueError(f"deploy/vm-setup.sh: cannot read the timer {call.strip()}")
        name, calendar, unit = match.groups()
        jobs.append(
            {
                "id": name,
                "label": JOB_LABELS.get(name, name),
                "calendar": calendar,
                "unit": unit,
                "source": None,
            }
        )
    if not jobs:
        raise ValueError("deploy/vm-setup.sh: no timers found")
    return jobs


def next_run(calendar: str, now: datetime) -> str | None:
    """The next time of a daily or weekly OnCalendar= value in UTC, as vm-setup.sh writes them."""
    match = CALENDAR.fullmatch(calendar)
    if match is None:
        return None
    start = now.replace(
        hour=int(match["hour"]),
        minute=int(match["minute"]),
        second=int(match["second"]),
        microsecond=0,
    )
    for days in range(8):
        at = start + timedelta(days=days)
        if at > now and match["day"] in (None, WEEKDAYS[at.weekday()]):
            return at.isoformat()
    return None


def systemd_time(value: str | None) -> str | None:
    """A timestamp of `systemctl show`: `@<seconds>`, or text in UTC; None for never."""
    if not value:
        return None
    if value.startswith("@"):
        return datetime.fromtimestamp(int(value[1:]), UTC).isoformat()
    try:
        moment = datetime.strptime(value, "%a %Y-%m-%d %H:%M:%S UTC")
    except ValueError:
        return None
    return moment.replace(tzinfo=UTC).isoformat()


def systemd_units(names: list[str]) -> dict[str, dict[str, str]]:
    """The loaded units of `names` with their state; empty without systemd or these units."""
    output = probe(
        [
            "systemctl",
            "show",
            *names,
            "--timestamp=unix",
            "--property=Id,LoadState,ActiveState,SubState,Result,NextElapseUSecRealtime,"
            "LastTriggerUSec,ExecMainStartTimestamp,ExecMainExitTimestamp",
        ],
        TZ="UTC",
        LC_ALL="C",
    )
    units: dict[str, dict[str, str]] = {}
    for block in (output or "").strip().split("\n\n"):
        properties = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
        if properties.get("LoadState") == "loaded":
            units[properties["Id"]] = properties
    return units


def schedule() -> dict[str, Any]:
    """The timers of the VM; live from systemd where this machine runs them."""
    jobs = planned_jobs()
    units = systemd_units(
        [f"{job['id']}.timer" for job in jobs]
        + [job["unit"] for job in jobs]
        + ["matcher-mcp.service", TRANSCRIBE_UNIT]
    )
    now = datetime.now(UTC)
    for job in jobs:
        timer, service = units.get(f"{job['id']}.timer"), units.get(job["unit"])
        job["live"] = timer is not None
        if timer is None:
            job["next"] = next_run(job["calendar"], now)
            continue
        job["next"] = systemd_time(timer.get("NextElapseUSecRealtime"))
        job["last"] = systemd_time(timer.get("LastTriggerUSec"))
        if service is not None:
            job["last_start"] = systemd_time(service.get("ExecMainStartTimestamp"))
            job["last_end"] = systemd_time(service.get("ExecMainExitTimestamp"))
            job["result"] = service.get("Result")
            # a oneshot service is "activating" while it runs
            job["running"] = service.get("ActiveState") in ("active", "activating", "reloading")
    mcp, transcribe = units.get("matcher-mcp.service"), units.get(TRANSCRIBE_UNIT)
    return {
        "live": any(job["live"] for job in jobs),
        "jobs": jobs,
        "mcp_service": None if mcp is None else mcp.get("ActiveState"),
        "transcribe_service": None if transcribe is None else transcribe.get("ActiveState"),
    }


async def database_facts(connection: Any) -> dict[str, Any]:
    """Size and sessions; the last stored run per source; the last indexed full text.

    A crawl stores one run per topic, so the last run of a source says little. With it come
    the topics of the source that have a run, and those whose newest run failed.
    """
    row = await connection.fetchrow(
        """SELECT pg_database_size(current_database()) AS size,
                  (SELECT count(*) FROM pg_stat_activity
                   WHERE datname = current_database()) AS connections"""
    )
    facts: dict[str, Any] = {"target": database_target(), **dict(row)}
    facts["crawls"] = facts["indexed"] = None
    with contextlib.suppress(asyncpg.PostgresError):
        rows = await connection.fetch(
            "SELECT DISTINCT ON (source) source, finished_at, ok"
            " FROM crawl_runs ORDER BY source, id DESC"
        )
        topics = {
            row["source"]: row
            for row in await connection.fetch(
                """SELECT source, count(*) AS topics, count(*) FILTER (WHERE NOT ok) AS failed
                   FROM (SELECT DISTINCT ON (source, topic) source, ok
                         FROM crawl_runs, unnest(topics) AS topic
                         ORDER BY source, topic, id DESC) AS newest
                   GROUP BY source"""
            )
        }
        facts["crawls"] = [
            {
                "source": row["source"],
                "finished_at": row["finished_at"].isoformat() if row["finished_at"] else None,
                "ok": row["ok"],
                "topics": topics[row["source"]]["topics"] if row["source"] in topics else 0,
                "failed_topics": topics[row["source"]]["failed"] if row["source"] in topics else 0,
            }
            for row in rows
        ]
    with contextlib.suppress(asyncpg.PostgresError):
        last = await connection.fetchval(
            "SELECT max(fetched_at) FROM keyword.full_texts WHERE status = 'indexed'"
        )
        facts["indexed"] = last.isoformat() if last else None
    facts["transcription"] = None
    with contextlib.suppress(asyncpg.PostgresError):
        job = await connection.fetchrow(
            f"""SELECT workers AS wanted, coalesce((state ->> 'workers')::int, 0) AS workers,
                       coalesce(reported_at > now() - interval '{JOB_REPORTS} seconds', false)
                           AS running
                FROM transcription"""
        )
        facts["transcription"] = dict(job) if job else None
    return facts


def database_probe() -> dict[str, Any]:
    try:
        return {"up": True, **run_db(database_facts, connect_timeout=PROBE_TIMEOUT)}
    except DbUnavailable as error:
        return {"up": False, "error": str(error)}


def containers() -> list[dict[str, str]] | None:
    """The running Docker containers by name; None without Docker or access to it."""
    output = probe(["docker", "ps", "--format", "{{json .}}"])
    if output is None:
        return None
    rows = []
    for line in output.splitlines():
        with contextlib.suppress(json.JSONDecodeError):
            item = json.loads(line)
            rows.append({"name": item.get("Names", ""), "status": item.get("Status", "")})
    return rows


def busiest_processes(limit: int = 8) -> list[dict[str, Any]] | None:
    """The processes with the most CPU since the last probe; names only, no arguments."""
    if psutil is None:
        return None
    rows, seen = [], set()
    for process in psutil.process_iter(["pid", "name", "create_time", "memory_info"]):
        key = (process.info["pid"], process.info["create_time"] or 0.0)
        seen.add(key)
        first = key not in PROCESSES  # the first reading has no base: no share yet
        known = PROCESSES.setdefault(key, process)
        try:
            cpu = known.cpu_percent(interval=None)
        except psutil.Error:
            continue
        memory = process.info["memory_info"]
        rows.append(
            {
                "name": process.info["name"] or "?",
                "pid": key[0],
                "cpu": None if first else cpu,
                "memory": memory.rss if memory else None,
            }
        )
    for gone in set(PROCESSES) - seen:
        del PROCESSES[gone]
    rows.sort(key=lambda row: (row["cpu"] or 0.0, row["memory"] or 0), reverse=True)
    return rows[:limit]


def code_version() -> dict[str, Any] | None:
    """The branch and commit of this checkout, and how many tracked files differ from it."""
    branch = probe(["git", "-C", str(ROOT), "rev-parse", "--abbrev-ref", "HEAD"])
    head = probe(["git", "-C", str(ROOT), "log", "-1", "--format=%h%x1f%s%x1f%cI"])
    if branch is None or head is None:
        return None
    commit, subject, date = (head.strip().split("\x1f") + ["", "", ""])[:3]
    changed = probe(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=no"])
    return {
        "branch": branch.strip(),
        "commit": commit,
        "subject": subject,
        "date": date,
        "changed": None if changed is None else len(changed.splitlines()),
    }


def backups() -> dict[str, Any] | None:
    """The newest database dump of the VM's nightly backup; None where there is none."""
    try:  # macOS keeps /var/backups for root: stat() fails instead of finding nothing
        if not BACKUP_DIR.is_dir():
            return None
        dumps = sorted(BACKUP_DIR.glob("*.dump"), key=lambda dump: dump.stat().st_mtime)[::-1]
    except PermissionError:
        return None
    newest = dumps[0].stat() if dumps else None
    return {
        "path": str(BACKUP_DIR),
        "count": len(dumps),
        "newest": None
        if newest is None
        else {
            "name": dumps[0].name,
            "size": newest.st_size,
            "at": datetime.fromtimestamp(newest.st_mtime, UTC).isoformat(),
        },
    }


def slow_info(fresh: bool) -> dict[str, Any]:
    """The probes that take a moment, at most once per INFO_TTL unless `fresh`."""
    with SLOW_LOCK:
        cached = SLOW["data"]
        if cached is not None and not fresh and time.monotonic() - SLOW["at"] < INFO_TTL:
            return cached  # type: ignore[no-any-return]
        data = {
            "schedule": guarded(schedule),
            "database": guarded(database_probe),
            "containers": guarded(containers),
            "processes": guarded(busiest_processes),
            "code": guarded(code_version),
            "backups": guarded(backups),
            "probed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        SLOW.update(at=time.monotonic(), data=data)
        return data


def info(fresh: bool = False) -> dict[str, Any]:
    return {
        "machine": guarded(machine),
        "runs": own_runs(),
        "mcp": {"url": f"http://127.0.0.1:{mcp_port()}/mcp", "running": mcp_running()},
        **slow_info(fresh),
    }


def query_groups(text: str, queries: list[str]) -> list[dict[str, Any]]:
    """The queries under the comment lines that head them in the file, or one plain group."""
    groups: list[dict[str, Any]] = []
    inside = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if not line.startswith((" ", "-", "#")):
            inside = line.startswith("queries:")
        elif inside and stripped.startswith("#") and line.startswith(" "):
            groups.append({"name": stripped.lstrip("#").strip(), "queries": []})
        elif inside and stripped.startswith("- "):
            if not groups:
                groups.append({"name": "", "queries": []})
            value = stripped[2:].strip()
            if len(value) > 1 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            groups[-1]["queries"].append(value)
    groups = [group for group in groups if group["queries"]]
    if [query for group in groups for query in group["queries"]] != queries:
        return [{"name": "", "queries": queries}]
    return groups


def topic_detail(topic_id: str) -> dict[str, Any]:
    """One topic file, looked up among the files and never opened by a path from the URL."""
    path = next((path for path in TOPICS_DIR.glob("*.yaml") if path.stem == topic_id), None)
    if path is None:
        raise LookupError(f"No topic file {topic_id}.yaml")
    text = path.read_text(encoding="utf-8")
    base = {"id": path.stem, "file": f"crawler/topics/{path.name}", "yaml": text}
    try:
        topic = load_topic(path)
    except TopicFileError as error:
        return {**base, "label": path.stem, "error": str(error)}
    return {
        **base,
        "label": topic.label,
        "terms": topic.terms,
        "queries": query_groups(text, topic.queries),
        "channels": [{"name": channel.name, "url": channel.url} for channel in topic.channels],
        "podcasts": [
            {
                "key": feed.key,
                "name": feed.name,
                "url": feed.url,
                "publisher": feed.publisher,
                "audience": feed.audience,
            }
            for feed in topic.podcasts
        ],
    }


# The Pre-filter screen: the labels and results of the document pre-filter study (#92), which
# scripts/prefilter.py writes. Only these files are read and written; documents come from
# /api/prefilter/documents, read only.
PREFILTER_DIR = ROOT / "research/prefilter"
PREFILTER_STATUSES = ("unchecked", "accepted", "changed")
PREFILTER_LABELS = ("keep", "unhelpful", "none")


def prefilter_status(entry: dict[str, Any]) -> str:
    """Unchecked, accepted (the same label and group as the proposal) or changed."""
    if entry.get("label") is None:
        return "unchecked"
    proposal = entry.get("proposal") or {}
    same = proposal.get("label") == entry["label"] and proposal.get("group") == entry.get("group")
    return "accepted" if same else "changed"


def prefilter_label(entry: dict[str, Any]) -> str:
    """The label that counts: a person's, else the LLM's proposal, else none."""
    if entry.get("label") is not None:
        return str(entry["label"])
    return str((entry.get("proposal") or {}).get("label") or "none")


def prefilter_labels(params: dict[str, list[str]]) -> dict[str, Any]:
    path = PREFILTER_DIR / "labels.json"
    if not path.exists():
        return {"missing": True}
    data = json.loads(path.read_text(encoding="utf-8"))
    set_name, status, label = first(params, "set"), first(params, "status"), first(params, "label")
    if status and status not in PREFILTER_STATUSES:
        raise ValueError(f"status must be one of {', '.join(PREFILTER_STATUSES)}")
    if label and label not in PREFILTER_LABELS:
        raise ValueError(f"label must be one of {', '.join(PREFILTER_LABELS)}")
    limit, offset = page(params)
    progress: dict[str, dict[str, int]] = {}
    for entry in data["documents"]:
        for name in entry["sets"]:
            counts = progress.setdefault(name, {"checked": 0, "total": 0})
            counts["total"] += 1
            counts["checked"] += entry.get("label") is not None
    items = [
        entry | {"status": prefilter_status(entry)}
        for entry in data["documents"]
        if (not set_name or set_name in entry["sets"])
        and (not status or prefilter_status(entry) == status)
        and (not label or prefilter_label(entry) == label)
    ]
    return {
        "items": items[offset : offset + limit],
        "total": len(items),
        "progress": progress,
        "guide": data.get("guide", []),
        "pipeline": prefilter_pipeline(data["documents"]),
    }


def prefilter_pipeline(documents: list[dict[str, Any]]) -> dict[str, Any]:
    """How far the study is, for the pipeline strip: labels, the classifier and the last measure."""
    by_model: dict[str, int] = {}
    for entry in documents:
        if entry.get("proposal"):
            name = str(entry["proposal"].get("model") or "?").split("@")[0].split("/")[-1]
            by_model[name] = by_model.get(name, 0) + 1
    model_path, results_path = PREFILTER_DIR / "model.json", PREFILTER_DIR / "results.json"
    model, results = (
        json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
        for path in (model_path, results_path)
    )
    return {
        "documents": len(documents),
        "proposed": sum(by_model.values()),
        "by_model": by_model,
        "by_person": sum(entry.get("label") is not None for entry in documents),
        "model": None
        if model is None
        else {key: model.get(key) for key in ("trained_on", "threshold", "below_threshold")},
        "measured_at": results.get("generated_at") if results else None,
        "rules": (results or {}).get("approaches", {}).get("rules"),
    }


def prefilter_results() -> dict[str, Any]:
    path = PREFILTER_DIR / "results.json"
    if not path.exists():
        return {"missing": True}
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


DROPS_EXIST = "SELECT to_regclass('document_drops') IS NOT NULL"
DROPS_MISSING = (
    "No document_drops table: apply db/init/05-document-drops.sql (make db) to this database"
)
DROP_STATUSES = ("proposed", "accepted", "rejected")
DROP_DECISIONS = {
    # A decision only changes the rows it can: "Keep all on this page" never undoes an accepted
    # drop. effect_at moves only when what is indexed changes (accept, undo of an accept).
    "accept": "status = 'accepted', decided_at = now(), effect_at = now()"
    " WHERE status <> 'accepted'",
    "reject": "status = 'rejected', decided_at = now() WHERE status = 'proposed'",
    "undo": "status = 'proposed', decided_at = now(),"
    " effect_at = CASE WHEN status = 'accepted' THEN now() ELSE effect_at END"
    " WHERE status <> 'proposed'",
}


async def prefilter_drops(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """A page of the drop list with what a card shows of each document, the counts per status and
    who proposed drops. Rows of deleted documents are gone with them (ON DELETE CASCADE)."""
    if not await connection.fetchval(DROPS_EXIST):
        return {"missing": True}
    status = first(params, "status") or "proposed"
    if status not in DROP_STATUSES:
        raise ValueError(f"status must be one of {', '.join(DROP_STATUSES)}")
    proposer = first(params, "proposed_by") or None
    limit, offset = page(params)
    where = "dr.status = $1 AND ($2::text IS NULL OR dr.proposed_by = $2)"
    total = await connection.fetchval(
        f"SELECT count(*) FROM document_drops dr WHERE {where}", status, proposer
    )
    items = await fetch_json(
        connection,
        f"""SELECT dr.document_id AS id, dr.proposed_by, dr.reason, dr.status, dr.proposed_at,
                   dr.decided_at, dr.note, d.title, d.source, d.content_type, d.publication_types,
                   d.published_at, d.summary, d.canonical_url
            FROM document_drops dr JOIN documents d ON d.id = dr.document_id
            WHERE {where} ORDER BY dr.proposed_at, dr.document_id LIMIT $3 OFFSET $4""",
        status,
        proposer,
        limit,
        offset,
    )
    counts = {name: 0 for name in DROP_STATUSES}
    for row in await connection.fetch(
        "SELECT status, count(*) AS n FROM document_drops GROUP BY status"
    ):
        counts[row["status"]] = row["n"]
    proposers = [
        row["proposed_by"]
        for row in await connection.fetch(
            "SELECT DISTINCT proposed_by FROM document_drops ORDER BY proposed_by"
        )
    ]
    return {"items": items, "total": total, "counts": counts, "proposers": proposers}


async def save_prefilter_drops(connection: Any, body: dict[str, Any]) -> dict[str, Any]:
    """A person's decision on drops: accept, reject or undo; returns how many rows changed."""
    decision, note = body.get("decision"), body.get("note")
    if decision not in DROP_DECISIONS:
        raise ValueError(f"decision must be one of {', '.join(DROP_DECISIONS)}")
    ids = string_list(body, "ids", 500)
    if not ids:
        raise ValueError("ids must not be empty")
    if note is not None and (not isinstance(note, str) or len(note) > 500):
        raise ValueError("note must be text of at most 500 characters")
    if not await connection.fetchval(DROPS_EXIST):
        raise RuntimeError(DROPS_MISSING)
    set_note = ", note = $2" if note is not None else ""
    changes, condition = DROP_DECISIONS[decision].split(" WHERE ")
    rows = await connection.fetch(
        f"UPDATE document_drops SET {changes}{set_note}"
        f" WHERE document_id = ANY($1::text[]) AND {condition} RETURNING 1",
        ids,
        *([note.strip()] if note is not None else []),
    )
    return {"changed": len(rows)}


PREFILTER_LOCK = threading.Lock()
"""One save at a time: two browser tabs must not overwrite each other's labels."""


def prefilter_write(path: Path, data: dict[str, Any]) -> None:
    """Write through a temporary file next to it, so the labels file is never half written."""
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def save_prefilter_label(body: dict[str, Any]) -> dict[str, Any]:
    """A person's label for one document; the LLM's proposal stays next to it."""
    document_id, label, group = body.get("id"), body.get("label"), body.get("group")
    note = body.get("note", "")
    if label not in ("unhelpful", "keep"):
        raise ValueError("label must be unhelpful or keep")
    whole = type(group) is int and group in (1, 2)  # not true or 1.0, which JSON also allows
    if (label == "unhelpful") != whole or (label == "keep" and group is not None):
        raise ValueError("group must be 1 or 2 for unhelpful and empty for keep")
    if not isinstance(note, str) or len(note) > 500:
        raise ValueError("note must be text of at most 500 characters")
    path = PREFILTER_DIR / "labels.json"
    # The thread lock for this server's own requests; the file lock for scripts/prefilter.py.
    with PREFILTER_LOCK, open(PREFILTER_DIR / ".labels.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not path.exists():
            raise LookupError("No labels file yet: run scripts/prefilter.py sample first")
        data = json.loads(path.read_text(encoding="utf-8"))
        entry = next((item for item in data["documents"] if item["id"] == document_id), None)
        if entry is None:
            raise LookupError(f"{document_id} is not in the labels file")
        entry |= {
            "label": label,
            "group": group,
            "note": note.strip(),
            "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
        prefilter_write(path, data)
    return entry | {"status": prefilter_status(entry)}


class Handler(BaseHTTPRequestHandler):
    server_version = "CrawlerDebug/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        """Keep the terminal quiet; the UI shows what happens."""

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def refuse_foreign(self, *, changes_state: bool) -> bool:
        """Answer 403 to requests another website can make the browser send.

        A foreign `Host` is DNS rebinding. A foreign `Origin` is a cross-site request, and a
        body that is not JSON could come from a cross-site form without a CORS preflight.
        """
        origin = self.headers.get("Origin")
        content_type = (self.headers.get("Content-Type") or "").partition(";")[0].strip()
        foreign = (
            self.headers.get("Host") not in ALLOWED_HOSTS
            or (origin is not None and origin.removeprefix("http://") not in ALLOWED_HOSTS)
            or (changes_state and content_type.lower() != "application/json")
        )
        if foreign:
            self.send_json({"error": "Forbidden"}, 403)
        return foreign

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        return data if isinstance(data, dict) else {}

    def send_db(self, query: Callable[[Any], Awaitable[Any]], *, write: bool = False) -> None:
        try:
            self.send_json(run_db(query, write=write))
        except DbUnavailable as error:
            self.send_json({"error": str(error), "hint": error.hint, "unavailable": True}, 503)
        except LookupError as error:
            self.send_json({"error": str(error).strip("'\"")}, 404)
        except (ValueError, asyncpg.DataError) as error:
            self.send_json({"error": str(error)}, 400)
        except TimeoutError:
            self.send_json({"error": f"The query took longer than {SLOW_QUERY} s"}, 504)
        except asyncpg.PostgresError as error:
            self.send_json({"error": describe_error(error)}, 500)

    def send_result(self, action: Callable[[], Any]) -> None:
        """The JSON answer of `action`; its errors as 400 (bad request), 404, 409 or 502."""
        try:
            self.send_json(action())
        except LookupError as error:
            self.send_json({"error": str(error).strip("'\"")}, 404)
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
        except RuntimeError as error:
            self.send_json({"error": str(error)}, 409)

    def route_db(self, path: str, params: dict[str, list[str]]) -> None:
        if path == "/api/db":
            self.send_db(db_overview)
        elif path == "/api/db/documents":
            self.send_db(lambda connection: db_documents(connection, params))
        elif path == "/api/db/document":
            self.send_db(lambda connection: db_document(connection, first(params, "id")))
        elif path == "/api/db/term-test":
            self.send_db(lambda connection: db_term_test(connection, params))
        elif path == "/api/db/runs":
            self.send_db(lambda connection: db_runs(connection, params))
        elif path == "/api/db/schema":
            self.send_db(db_schema)
        elif path == "/api/db/table":
            self.send_db(lambda connection: db_table(connection, params))
        elif path == "/api/db/empty-plan":
            self.send_db(lambda connection: emptying_plan(connection, params.get("table") or []))
        else:
            self.send_json({"error": "not found"}, 404)

    def route_index(self, path: str, params: dict[str, list[str]]) -> None:
        if path == "/api/index":
            self.send_db(lambda connection: index_overview(connection, first(params, "technique") or "keyword"))
        elif path == "/api/index/run":
            self.send_json(indexer_state(events=True))
        elif path == "/api/index/events":
            self.stream_events(INDEXING, params)
        elif path == "/api/index/vocabulary":
            self.send_db(lambda connection: index_vocabulary(connection, params))
        elif path == "/api/index/journey-terms":
            self.send_db(journey_terms)
        elif path == "/api/index/transcription":
            self.send_db(transcription_overview)
        elif path == "/api/index/encoder":
            self.send_result(encoder_state)
        else:
            self.send_json({"error": "not found"}, 404)

    def empty_db(self) -> None:
        """Empty tables; the body must name the database, which the UI asks the user to type."""
        try:
            body = self.read_json()
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        tables, confirm = body.get("tables"), body.get("confirm")
        if not isinstance(tables, list) or not all(isinstance(name, str) for name in tables):
            self.send_json({"error": "tables must be a list of table names"}, 400)
            return
        run = CURRENT
        if run is not None and run.store_url is not None:
            self.send_json({"error": "A crawler run with Store is in progress; wait for it"}, 409)
            return
        if INDEXING is not None and INDEXING.status == "running":
            self.send_json({"error": "The indexer is running; stop it first"}, 409)
            return
        self.send_db(lambda connection: empty_tables(connection, tables, str(confirm)), write=True)

    def do_GET(self) -> None:
        if self.refuse_foreign(changes_state=False):
            return
        url = urlparse(self.path)
        path = url.path
        page = WEB_FILE.fullmatch("/index.html" if path == "/" else path)
        if page and (WEB_DIR / page[1]).is_file():
            body = (WEB_DIR / page[1]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", WEB_TYPES[Path(page[1]).suffix])
            self.send_header("Content-Length", str(len(body)))
            # Read from disk on every request, so a reload shows an edit without a restart.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/meta":
            self.send_json(meta())
        elif path == "/api/runs":
            self.send_json(list_runs())
        elif path == "/api/events":
            self.stream_events(CURRENT, parse_qs(url.query))
        elif path == "/api/db" or path.startswith("/api/db/"):
            self.route_db(path, parse_qs(url.query))
        elif path == "/api/index" or path.startswith("/api/index/"):
            self.route_index(path, parse_qs(url.query))
        elif path == "/api/graph/meta":
            self.send_json(graph_meta())
        elif path == "/api/graph/normalize":
            params = parse_qs(url.query)
            kind, name, score = (first(params, key) for key in ("kind", "name", "min_score"))
            self.send_result(lambda: graph_normalize(kind, name, score))
        elif path == "/api/prefilter/results":
            self.send_result(prefilter_results)
        elif path == "/api/prefilter/drops":
            self.send_db(lambda connection: prefilter_drops(connection, parse_qs(url.query)))
        elif path == "/api/prefilter/labels":
            self.send_result(lambda: prefilter_labels(parse_qs(url.query)))
        elif path == "/api/match/meta":
            self.send_json(match_meta())
        elif path == "/api/info":
            self.send_json(info(fresh="fresh" in parse_qs(url.query)))
        elif path.startswith("/api/topics/"):
            self.send_result(lambda: topic_detail(path.removeprefix("/api/topics/")))
        elif path == "/api/match/journey":
            self.send_result(lambda: load_journey(first(parse_qs(url.query), "id")))
        elif path.startswith("/api/runs/"):
            run_id, _, suffix = path.removeprefix("/api/runs/").partition("/")
            data = load_run(run_id)
            if data is None:
                self.send_json({"error": "Run not found"}, 404)
            elif suffix == "jsonl":
                documents = (data.get("result") or {}).get("documents") or []
                lines = (json.dumps(d, ensure_ascii=False) + "\n" for d in documents)
                encoded = "".join(lines).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{run_id}.jsonl"')
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            else:
                self.send_json(data)
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        if self.refuse_foreign(changes_state=True):
            return
        path = urlparse(self.path).path
        if path == "/api/runs":
            self.start_run()
        elif path == "/api/db/empty":
            self.empty_db()
        elif path == "/api/index/cancel":
            self.send_result(stop_indexer)
        elif path == "/api/index/encoder/start":
            self.send_result(start_encoder)
        elif path == "/api/index/encoder/stop":
            self.send_result(stop_encoder)
        elif path in (
            "/api/index/run",
            "/api/index/terms",
            "/api/index/transcription",
            "/api/db/titles",
            "/api/prefilter/documents",
            "/api/prefilter/drops",
            "/api/match",
            "/api/match/source",
            "/api/prefilter/label",
        ):
            try:
                body = self.read_json()
            except json.JSONDecodeError:
                self.send_json({"error": "Invalid JSON"}, 400)
                return
            if path == "/api/match":
                self.send_result(lambda: match(body))
            elif path == "/api/index/run":
                self.send_result(lambda: start_indexer(body.get("technique", body.get("approach") or "all")).summary())
            elif path == "/api/index/transcription":
                self.send_db(
                    lambda connection: set_transcription_workers(connection, body.get("workers")),
                    write=True,
                )
            elif path == "/api/match/source":
                self.send_result(lambda: source(body))
            elif path == "/api/prefilter/label":
                self.send_result(lambda: save_prefilter_label(body))
            elif path == "/api/prefilter/drops":
                self.send_db(
                    lambda connection: save_prefilter_drops(connection, body), write=True
                )
            elif path == "/api/prefilter/documents":
                self.send_db(
                    lambda connection: db_prefilter_documents(
                        connection, string_list(body, "ids", 500)
                    )
                )
            elif path == "/api/db/titles":
                self.send_db(
                    lambda connection: db_titles(connection, string_list(body, "ids", 5000))
                )
            else:
                self.send_db(
                    lambda connection: term_documents(connection, string_list(body, "terms", 500))
                )
        elif path == "/api/cancel":
            run = CURRENT
            if run is None or run.loop is None or run.task is None:
                self.send_json({"error": "No run in progress"}, 409)
                return
            run.cancel_requested = True
            run.emit("cancel_requested")
            run.loop.call_soon_threadsafe(run.task.cancel)
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_DELETE(self) -> None:
        if self.refuse_foreign(changes_state=True):
            return
        path = urlparse(self.path).path
        if path == "/api/runs":
            self.send_json({"deleted": delete_all_runs()})
        elif path.startswith("/api/runs/") and delete_run(path.removeprefix("/api/runs/")):
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "Run not found"}, 404)

    def start_run(self) -> None:
        global CURRENT
        try:
            body = self.read_json()
            argv = build_argv(body)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
            return
        with LOCK:
            if CURRENT is not None:
                self.send_json({"error": "A run is already in progress"}, 409)
                return
            refresh_env()
            try:
                seeds, options = parse_run(argv)
                store_url = None
                if body.get("store") is True:
                    store_url, options = prepare(argv[0], options)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
                return
            run = Run(argv)
            run.store_url = store_url
            CURRENT = run
        run.emit(
            "run_started",
            command=run.command,
            seeds=len(seeds),
            options=options.model_dump(mode="json"),
        )
        threading.Thread(target=execute, args=(run, seeds, options), daemon=True).start()
        self.send_json({"id": run.id, "command": run.command})

    def stream_events(self, run: EventLog | None, query: dict[str, list[str]]) -> None:
        """Sends the events of `run`, a crawler run or an indexer run, until it is done."""
        run_id = (query.get("run") or [""])[0]
        if run is None or run.id != run_id:
            self.send_json({"error": "Run is not active"}, 404)
            return
        last = self.headers.get("Last-Event-ID") or ""
        start = (query.get("from") or ["0"])[0]
        seq = int(last) + 1 if last.isdigit() else int(start) if start.isdigit() else 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                with run.changed:
                    if seq >= len(run.events) and run.status == "running":
                        run.changed.wait(timeout=15)
                    batch = run.events[seq:]
                    done = run.status != "running"
                for event in batch:
                    data = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"id: {event['seq']}\ndata: {data}\n\n".encode())
                seq += len(batch)
                if not batch:
                    self.wfile.write(b": keepalive\n\n")
                if done and seq >= len(run.events):
                    self.wfile.write(b"event: end\ndata: {}\n\n")
                    self.wfile.flush()
                    return
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return


def interrupt(*_: Any) -> None:
    raise KeyboardInterrupt


def main() -> None:
    options = argparse.ArgumentParser(description="Debug UI for the crawler and the matcher")
    options.add_argument("--host", default="127.0.0.1")
    options.add_argument("--port", type=int, default=8765)
    arguments = options.parse_args()

    # Crawlee logs every failure with a full traceback; the UI shows failures itself.
    logging.getLogger("crawlee").setLevel(logging.CRITICAL)
    runner_logger = logging.getLogger("crawler.runner")
    runner_logger.addHandler(EventLogHandler())
    runner_logger.setLevel(logging.WARNING)
    runner_logger.propagate = False
    warnings.showwarning = show_warning

    host = f"[{arguments.host}]" if ":" in arguments.host else arguments.host
    ALLOWED_HOSTS.update(
        f"{name}:{arguments.port}" for name in (host, "127.0.0.1", "localhost", "[::1]")
    )
    refresh_env()
    load_summaries()
    # The page asks for all its files at once; the default queue of 5 resets some of them.
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    server.daemon_threads = True
    print(f"Debug UI: http://{arguments.host}:{arguments.port}", flush=True)
    print(f"Crawler .env: {ENV_FILE} ({'found' if ENV_FILE.exists() else 'missing'})", flush=True)
    # A stop (make debug-ai, systemd) or a closed terminal also stops the encoder it started.
    for stopping in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(stopping, interrupt)
    try:
        with contextlib.suppress(KeyboardInterrupt):
            server.serve_forever()
    finally:
        if ENCODER is not None:
            stop_process_group(ENCODER.process)


if __name__ == "__main__":
    main()
