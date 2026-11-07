"""Debug UI for the crawler: start runs, watch them live, inspect the results and the database.

Start it from the repository root with `make debug` (see debug/crawler/README.md). It runs in the
crawler's uv environment and only uses the crawler's public Python API (`run_requests`
with its factory and sleep hooks, `crawler.store` for `--store`), asyncpg and the standard
library, so the crawler needs nothing extra for it. The database view only reads, except when
the user empties tables and types the database name to confirm.
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
import threading
import time
import uuid
import warnings
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse, urlsplit

import asyncpg
from dotenv import dotenv_values
from pydantic import ValidationError

from crawler.cli import parser as cli_parser
from crawler.cli import requests_from_args
from crawler.models import SourceName
from crawler.runner import ENV_FILE, link_extractor_from_env, run_requests, source_from_env
from crawler.seeds import TOPICS_DIR, TopicFileError, load_topic
from crawler.store import (
    STORE_LOCK,
    RunInfo,
    StoreError,
    database_url,
    prepare_store,
    save_result,
)

HERE = Path(__file__).resolve().parent
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


class Run:
    def __init__(self, argv: list[str]) -> None:
        self.id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.argv = argv
        self.command = "uv run crawler " + shlex.join(argv)
        self.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.started = time.monotonic()
        self.duration: float | None = None
        self.status = "running"
        self.error: str | None = None
        self.result: dict[str, Any] | None = None
        self.events: list[dict[str, Any]] = []
        self.changed = threading.Condition()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.task: asyncio.Task[Any] | None = None
        self.cancel_requested = False
        self.store_url: str | None = None
        """`DATABASE_URL` when the run is stored like `crawler --store`."""
        self.stored: dict[str, Any] | None = None

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


class TracedScraper:
    """Wraps a real scraper and reports every source call as an event."""

    def __init__(self, inner: Any, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def scrape(self, request: Any) -> Any:
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


class TracedExtractor:
    """Wraps a real link extractor and reports the citation edges it finds."""

    def __init__(self, inner: Any, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def cited_ids(self, native_ids: Any) -> Any:
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

    def sources(source: Any) -> TracedScraper:
        return TracedScraper(source_from_env(source), run)

    def extractors(source: Any) -> TracedExtractor | None:
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
    try:
        report = loop.run_until_complete(save_result(run.store_url, result, info))
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
    topics = []
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


async def fetch_json(connection: Any, sql: str, *args: Any) -> list[Any]:
    """The rows of `sql` as JSON objects; Postgres writes dates and timestamps as ISO text."""
    rows = await connection.fetch(f"SELECT to_jsonb(r) AS row FROM ({sql}) AS r", *args)
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


async def table_names(connection: Any) -> list[str]:
    rows = await fetch_json(
        connection,
        "SELECT relname AS name FROM pg_class"
        " WHERE relnamespace = to_regnamespace(current_schema()) AND relkind IN ('r', 'p')"
        " ORDER BY relname",
    )
    return [row["name"] for row in rows]


async def db_overview(connection: Any) -> dict[str, Any]:
    [info] = await fetch_json(
        connection,
        "SELECT current_database() AS database, current_user AS user,"
        " current_setting('server_version') AS version, current_schema() AS schema",
    )
    overview: dict[str, Any] = info
    tables = []
    for name in await table_names(connection):
        rows = await connection.fetchval(f"SELECT count(*) FROM {quote_ident(name)}")
        size = await connection.fetchval("SELECT pg_total_relation_size(to_regclass($1))", name)
        tables.append({"name": name, "rows": rows, "bytes": size})
    names = {table["name"] for table in tables}
    overview |= {
        "target": database_target(),
        "tables": tables,
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


def document_filter(params: dict[str, list[str]]) -> tuple[str, list[Any]]:
    """SQL conditions and arguments for the filters of the documents table."""
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
    return " AND ".join(conditions) or "true", args


async def db_documents(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    where, args = document_filter(params)
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
                   {FROM_SEARCH} AS from_search,
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
    }


async def db_runs(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    limit, offset = page(params)
    rows = await fetch_json(
        connection, "SELECT * FROM crawl_runs ORDER BY id DESC LIMIT $1 OFFSET $2", limit, offset
    )
    total = await connection.fetchval("SELECT count(*) FROM crawl_runs")
    return {"total": total, "offset": offset, "limit": limit, "rows": rows}


async def db_schema(connection: Any) -> dict[str, Any]:
    in_schema = "to_regnamespace(current_schema())"
    return {
        "columns": await fetch_json(
            connection,
            f"""SELECT c.relname AS table, a.attname AS name,
                       format_type(a.atttypid, a.atttypmod) AS type,
                       NOT a.attnotnull AS nullable,
                       CASE WHEN a.attidentity <> '' THEN 'identity'
                            ELSE pg_get_expr(d.adbin, d.adrelid) END AS default
                FROM pg_attribute AS a
                JOIN pg_class AS c ON c.oid = a.attrelid
                LEFT JOIN pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                WHERE c.relnamespace = {in_schema} AND c.relkind IN ('r', 'p')
                  AND a.attnum > 0 AND NOT a.attisdropped
                ORDER BY c.relname, a.attnum""",
        ),
        "constraints": await fetch_json(
            connection,
            f"""SELECT conrelid::regclass::text AS table, conname AS name,
                       pg_get_constraintdef(oid) AS definition
                FROM pg_constraint
                -- NOT NULL is in the columns already (PostgreSQL 18 lists it here, too).
                WHERE connamespace = {in_schema} AND conrelid <> 0 AND contype <> 'n'
                ORDER BY 1, contype, 2""",
        ),
        "indexes": await fetch_json(
            connection,
            "SELECT tablename AS table, indexname AS name, indexdef AS definition"
            " FROM pg_indexes WHERE schemaname = current_schema() ORDER BY 1, 2",
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
           SELECT relname AS name FROM pg_class WHERE oid IN (SELECT oid FROM targets)
           ORDER BY relname""",
        names,
    )
    for table in tables:
        table["rows"] = await connection.fetchval(
            f"SELECT count(*) FROM {quote_ident(table['name'])}"
        )
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
        tables = ", ".join(quote_ident(table["name"]) for table in plan["tables"])
        await connection.execute(f"TRUNCATE TABLE {tables} RESTART IDENTITY")
    return {"database": database, "emptied": plan["tables"]}


async def db_table(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """Any table of the schema, e.g. an index table, as plain rows."""
    name = first(params, "name")
    if name not in await table_names(connection):
        raise LookupError(f"No table {name}")
    limit, offset = page(params)
    table = quote_ident(name)
    columns = await fetch_json(
        connection,
        "SELECT attname AS name FROM pg_attribute"
        " WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
        name,
    )
    return {
        "name": name,
        "columns": [column["name"] for column in columns],
        "total": await connection.fetchval(f"SELECT count(*) FROM {table}"),
        "offset": offset,
        "limit": limit,
        "rows": await fetch_json(
            connection, f"SELECT * FROM {table} ORDER BY 1 LIMIT $1 OFFSET $2", limit, offset
        ),
    }


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
        except asyncpg.PostgresError as error:
            self.send_json({"error": describe_error(error)}, 500)

    def route_db(self, path: str, params: dict[str, list[str]]) -> None:
        if path == "/api/db":
            self.send_db(db_overview)
        elif path == "/api/db/documents":
            self.send_db(lambda connection: db_documents(connection, params))
        elif path == "/api/db/document":
            self.send_db(lambda connection: db_document(connection, first(params, "id")))
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
            self.stream_events(parse_qs(url.query))
        elif path == "/api/db" or path.startswith("/api/db/"):
            self.route_db(path, parse_qs(url.query))
        elif path.startswith("/api/runs/"):
            run_id, _, suffix = path.removeprefix("/api/runs/").partition("/")
            data = load_run(run_id)
            if data is None:
                self.send_json({"error": "Run not found"}, 404)
            elif suffix == "jsonl":
                documents = (data.get("result") or {}).get("documents") or []
                body = "".join(json.dumps(d, ensure_ascii=False) + "\n" for d in documents)
                encoded = body.encode()
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

    def stream_events(self, query: dict[str, list[str]]) -> None:
        run_id = (query.get("run") or [""])[0]
        run = CURRENT
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
    options = argparse.ArgumentParser(description="Debug UI for the crawler")
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
    print(f"Crawler debug UI: http://{arguments.host}:{arguments.port}", flush=True)
    print(f"Crawler .env: {ENV_FILE} ({'found' if ENV_FILE.exists() else 'missing'})", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
