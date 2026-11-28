"""What the debug server's modules share: the paths, the crawler's environment keys, the event
log of a run and the runs in progress, and the helpers for the database and the matcher."""

import asyncio
import json
import os
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import asyncpg
from dotenv import dotenv_values

from crawler.runner import ENV_FILE
from crawler.store import (
    StoreError,
    database_url,
)

if TYPE_CHECKING:
    from indexing import IndexRun
    from runs import Run

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MATCHER_DIR = ROOT / "matcher"
ENV_KEYS = (
    "NCBI_ENTREZ_EMAIL",
    "NCBI_API_KEY",
    "OPENALEX_API_KEY",
    "SEMANTIC_SCHOLAR_API_KEY",
    "YOUTUBE_API_KEY",
)
SHELL_KEYS = {key for key in ENV_KEYS if os.environ.get(key)}
LOCK = threading.Lock()
CURRENT: "Run | None" = None


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


DB_SETTINGS = {
    # Every query of this view runs in a read-only transaction, whatever the SQL says.
    "default_transaction_read_only": "on",
    "application_name": "crawler-debug-ui",
    "TimeZone": "UTC",
}
CONNECT_ERRORS = (OSError, asyncpg.PostgresError, asyncpg.InterfaceError, ValueError)
URL_PASSWORD = re.compile(r"(\w+://[^:/@\s]*:)[^@\s]*@")


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


def first(params: dict[str, list[str]], key: str) -> str:
    return (params.get(key) or [""])[0].strip()


def page(params: dict[str, list[str]]) -> tuple[int, int]:
    try:
        limit = int(first(params, "limit") or 50)
        offset = int(first(params, "offset") or 0)
    except ValueError as error:
        raise ValueError("limit and offset must be whole numbers") from error
    return min(max(limit, 1), 500), max(offset, 0)


async def has_keyword_index(connection: Any) -> bool:
    """Whether the keyword indexer has created its tables (`make index`)."""
    return bool(
        await connection.fetchval(
            "SELECT to_regclass('keyword.documents') IS NOT NULL"
            " AND to_regclass('keyword.full_texts') IS NOT NULL"
        )
    )


def version(document: str) -> str:
    """The version of `document` for its indexes: its last change, or a later stored transcript.

    `VERSION` in matcher/db/src/documents.ts.
    """
    return (
        f"greatest({document}.changed_at, (SELECT t.read_at FROM transcripts AS t"
        f" WHERE t.document_id = {document}.id AND t.status <> 'failed'))"
    )


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


SLOW_QUERY = 30
"""Seconds a query over every full text may take before the view gives up."""
INDEXING: "IndexRun | None" = None
"""The indexer run in progress, or the last one."""


def matcher_missing() -> str | None:
    """What keeps this server from running the matcher's programs, if anything."""
    if shutil.which("node") is None:
        return "node is not on the PATH (the matcher needs Node.js 24)"
    if not (MATCHER_DIR / "node_modules").exists():
        return "The matcher is not installed: run make build"
    return None


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
