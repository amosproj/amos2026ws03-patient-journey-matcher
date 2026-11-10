"""Debug UI for the crawler, the database, the index and the matcher.

Start it from the repository root with `make debug` (see debug/crawler/README.md). It runs in the
crawler's uv environment and only uses the crawler's public Python API (`run_requests`
with its factory and sleep hooks, `crawler.store` for `--store`), asyncpg and the standard
library, so the crawler needs nothing extra for it. The database view only reads, except when
the user empties tables and types the database name to confirm.

The matcher is TypeScript, so its logic stays there: the Index screen starts the indexer job
(`matcher/indexer`) as a child process and reads its tables, and the Matcher screen asks
`node src/main.ts explain` in `matcher/mcp-server` for the answer of `match_journey` with the
steps of the match. Journeys are passed on, never stored or logged.
"""

import argparse
import asyncio
import contextlib
import io
import json
import logging
import os
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
from datetime import UTC, datetime
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
from crawler.models import ScrapeRequest, SourceDocument, SourceName
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
ROOT = HERE.parent.parent
MATCHER_DIR = ROOT / "matcher"
RUNS_DIR = HERE / "runs"
ENV_KEYS = ("NCBI_ENTREZ_EMAIL", "NCBI_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "YOUTUBE_API_KEY")
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
        run.status = "cancelled" if run.cancel_requested else "finished"
        run.emit(
            "run_cancelled" if run.cancel_requested else "run_finished",
            ok=result.ok,
            documents=len(result.documents),
            failures=len(result.failures),
            run_error=result.run_error,
        )
        if run.store_url is not None and run.status == "finished":
            store(run, loop, seeds, result)
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
    """Like `crawler --store` after a crawl; cancelled runs are not stored."""
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
            raise ValueError("Enter a query or a channel")
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
    except (TopicFileError, ValidationError, ValueError) as error:
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
        return "DATABASE_URL is no postgresql:// URL, see crawler/.env.example."
    return "Start it from the repository root: make db (or docker compose up -d)."


def run_db(query: Callable[[Any], Awaitable[Any]], *, write: bool = False) -> Any:
    """`query(connection)` on a new connection to `DATABASE_URL`, read-only unless `write`."""
    try:
        url = database_url()
    except StoreError as error:
        raise DbUnavailable(str(error), "See crawler/.env.example.") from error
    settings = DB_SETTINGS | {"default_transaction_read_only": "off"} if write else DB_SETTINGS

    async def main() -> Any:
        try:
            connection = await asyncpg.connect(url, timeout=5, server_settings=settings)
        except CONNECT_ERRORS as error:
            message = URL_PASSWORD.sub(r"\1<redacted>@", describe_error(error))
            raise DbUnavailable(message, connection_hint(error)) from error
        try:
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
        row = "SELECT FROM keyword.full_texts AS f WHERE f.document_id = documents.id"
        if full_text == "none":
            conditions.append(f"NOT EXISTS ({row})")
        elif full_text in ("indexed", "skipped", "failed"):
            conditions.append(f"EXISTS ({row} AND f.status = {arg(full_text)})")
        elif full_text:
            raise ValueError("Unknown full-text status")
        if detail:
            conditions.append(f"EXISTS ({row} AND f.detail = {arg(detail)})")
    return " AND ".join(conditions) or "true", args


async def db_documents(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    indexed = await has_keyword_index(connection)
    where, args = document_filter(params, indexed)
    full_text_status = (
        "(SELECT f.status FROM keyword.full_texts AS f WHERE f.document_id = documents.id)"
        if indexed
        else "NULL::text"
    )
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
                   {FROM_SEARCH} AS from_search, {full_text_status} AS full_text_status,
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


INDEX_CURRENT = "i.document_changed_at = date_trunc('milliseconds', d.changed_at)"
"""An index row `i` holds the current version of its document `d` (`toIndex` in @matcher/db)."""


async def document_index(connection: Any, document_id: str) -> dict[str, Any] | None:
    """What the keyword index holds of a document; None before the first `make index`."""
    if not await has_keyword_index(connection):
        return None
    metadata = await fetch_json(
        connection,
        f"""SELECT i.content, {INDEX_CURRENT} AS current
            FROM keyword.documents AS i JOIN documents AS d ON d.id = i.document_id
            WHERE i.document_id = $1""",
        document_id,
    )
    words = "string_to_table(i.terms, ' ') AS word WHERE word <> ''"
    full_text = await fetch_json(
        connection,
        f"""SELECT i.status, i.detail, i.url, i.media_type, i.words, i.fetched_at,
                   {INDEX_CURRENT} AS current,
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


# ── Index screen: what the keyword index holds, and the indexer job ──────────────

NOT_EXPIRED = "(d.expires_at IS NULL OR d.expires_at > now())"


def to_index(index: str) -> str:
    """A document `d` an index table has not seen or that changed since (`toIndex`, @matcher/db)."""
    return (
        f"({index}.document_id IS NULL OR {index}.document_changed_at"
        " IS DISTINCT FROM date_trunc('milliseconds', d.changed_at))"
    )


NO_INDEX = (
    "(SELECT NULL::text AS document_id, NULL::timestamptz AS document_changed_at,"
    " NULL::text AS status WHERE false)"
)
"""Stands in for an index table before the first `make index`: every document is to index."""
WORD_BUCKETS = [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 50000]
"""Keywords per full text, for the histogram; 50,000 is the indexer's limit (`MAX_WORDS`)."""
# The estimate of the Index screen copies two rules of matcher/download/src: the media types
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
    """The environment of the matcher's programs: this one plus the crawler's `DATABASE_URL`."""
    missing = matcher_missing()
    if missing:
        raise ValueError(missing)
    try:
        return {**os.environ, "DATABASE_URL": database_url()}
    except StoreError as error:
        raise ValueError(str(error)) from error


class IndexRun(EventLog):
    """One run of the indexer job (`make index`); its output lines are the events."""

    command = "make index"

    def __init__(self) -> None:
        super().__init__()
        self.process: subprocess.Popen[str] | None = None
        self.cancel_requested = False

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "command": self.command,
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
            ["node", "src/main.ts"],
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


def start_indexer() -> IndexRun:
    global INDEXING
    environment = matcher_environment()
    with LOCK:
        if INDEXING is not None and INDEXING.status == "running":
            raise RuntimeError("The indexer is already running")
        run = INDEXING = IndexRun()
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
    state: dict[str, Any] = {"missing": matcher_missing(), "run": run.summary() if run else None}
    if events and run is not None:
        state["events"] = list(run.events)
    return state


async def index_overview(connection: Any) -> dict[str, Any]:
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
        "exists": exists,
        "extension": extension,
        "indexer": indexer_state(),
        # The stacked bars: every document is indexed, skipped, failed or not read yet.
        "coverage": await fetch_json(
            connection,
            f"""SELECT d.source, d.content_type, count(*) AS documents,
                       count(m.document_id) AS metadata,
                       count(*) FILTER (WHERE {to_index("m")}) AS metadata_to_index,
                       count(*) FILTER (WHERE i.status = 'indexed') AS indexed,
                       count(*) FILTER (WHERE i.status = 'skipped') AS skipped,
                       count(*) FILTER (WHERE i.status = 'failed') AS failed,
                       count(*) FILTER (WHERE i.document_id IS NULL) AS unread,
                       -- What the next run reads: new and changed documents, failed downloads.
                       count(*) FILTER (WHERE {to_index("i")} OR i.status = 'failed') AS to_read
                FROM documents AS d
                LEFT JOIN {metadata} AS m ON m.document_id = d.id
                LEFT JOIN {full_texts} AS i ON i.document_id = d.id
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
                WHERE {NOT_EXPIRED} AND ({to_index("i")} OR i.status = 'failed')
                GROUP BY 1 ORDER BY 2 DESC, 1""",
            READABLE_TYPES,
        ),
    }
    for host in overview["hosts"]:
        interval = HOST_INTERVAL.get(host["host"], DEFAULT_INTERVAL)
        host["seconds"] = None if host["host"] is None else round(host["documents"] * interval)
    if not exists:
        return overview
    overview["reasons"] = await fetch_json(
        connection,
        "SELECT status, detail, count(*) AS documents FROM keyword.full_texts"
        " GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2",
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


def string_list(body: dict[str, Any], key: str, limit: int) -> list[str]:
    values = body.get(key)
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise ValueError(f"{key} must be a list of texts")
    if len(values) > limit:
        raise ValueError(f"At most {limit} {key}")
    return values


# ── Matcher screen: match_journey for a journey, with the steps of the match ─────

JOURNEYS_DIR = ROOT / "patientdata"
"""The synthetic journeys of #14, one `timeline.json` per patient, once they are merged."""
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
"""The test journey of Documentation/build.md."""
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


def explain_match(request: dict[str, Any]) -> dict[str, Any]:
    """`match_journey` by the matcher's own code, with the steps of the match."""
    try:
        done = subprocess.run(
            ["node", "src/main.ts", "explain"],
            cwd=MATCHER_DIR / "mcp-server",
            env=matcher_environment(),
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


def call_mcp(arguments: dict[str, Any]) -> dict[str, Any]:
    """`match_journey` of the running MCP server (`make start`), as a client gets it."""
    call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": "match_journey", "arguments": arguments},
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
        raise RuntimeError(f"No MCP server on {url}: run make start") from error
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
        result = {"steps": [], **call_mcp(arguments)}
    else:
        result = explain_match(request)
    return {**result, "seconds": round(time.monotonic() - started, 2)}


# ── HTTP ──────────────────────────────────────────────────────────────────────


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
            self.send_db(index_overview)
        elif path == "/api/index/run":
            self.send_json(indexer_state(events=True))
        elif path == "/api/index/events":
            self.stream_events(INDEXING, params)
        elif path == "/api/index/vocabulary":
            self.send_db(lambda connection: index_vocabulary(connection, params))
        elif path == "/api/index/journey-terms":
            self.send_db(journey_terms)
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
            self.send_json({"error": "A run is storing into the database; wait for it"}, 409)
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
        if path in ("/", "/index.html"):
            body = (HERE / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
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
        elif path == "/api/match/meta":
            self.send_json(match_meta())
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
        elif path == "/api/index/run":
            self.send_result(lambda: start_indexer().summary())
        elif path == "/api/index/cancel":
            self.send_result(stop_indexer)
        elif path in ("/api/index/terms", "/api/db/titles", "/api/match"):
            try:
                body = self.read_json()
            except json.JSONDecodeError:
                self.send_json({"error": "Invalid JSON"}, 400)
                return
            if path == "/api/match":
                self.send_result(lambda: match(body))
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
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    server.daemon_threads = True
    print(f"Debug UI: http://{arguments.host}:{arguments.port}", flush=True)
    print(f"Crawler .env: {ENV_FILE} ({'found' if ENV_FILE.exists() else 'missing'})", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
