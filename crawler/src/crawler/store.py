"""Store collected documents in PostgreSQL (#41).

The tables are defined in `db/init/`; `Documentation/storage.md` describes how rows are written
and read. The crawler is the only writer of `documents` and `crawl_runs`.
"""

import json
import os
import re
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager, suppress
from datetime import UTC, date, datetime, timedelta
from typing import Any

import asyncpg
from dotenv import dotenv_values
from pydantic import BaseModel, ConfigDict

from crawler.models import CollectionResult, SourceDocument, SourceName
from crawler.runner import ENV_FILE

__all__ = [
    "COLUMNS",
    "DATABASE_URL",
    "RESUME_OVERLAP",
    "RunInfo",
    "StoreError",
    "StoreReport",
    "database_url",
    "document_row",
    "last_successful_runs",
    "prepare_store",
    "resume_date",
    "save_result",
]

DATABASE_URL = "DATABASE_URL"
CONNECT_TIMEOUT_SECONDS = 10
RESUME_OVERLAP = timedelta(days=2)
"""`--since auto` starts this long before the last successful run: sources add some records late
and date them in their own time zone. Documents found again are only refreshed."""
# Every store transaction holds this lock, so parallel runs neither deadlock on shared rows nor
# miscount what they changed.
STORE_LOCK = 41
TABLES = ("documents", "crawl_runs")

COLUMNS = (
    "id",
    "source",
    "native_id",
    "version",
    "content_type",
    "publication_types",
    "title",
    "authors",
    "venue",
    "summary",
    "language",
    "subjects",
    "published_at",
    "published_precision",
    "source_updated_at",
    "duration_seconds",
    "canonical_url",
    "doi",
    "external_ids",
    "licence",
    "full_text",
    "found_by",
    "retrieved_at",
    "expires_at",
    "extra",
)
# A new crawl of a stored document updates these without counting as a change; `id`, `source` and
# `native_id` never change.
_NOT_CONTENT = {"id", "source", "native_id", "found_by", "retrieved_at", "expires_at"}
_CONTENT = tuple(column for column in COLUMNS if column not in _NOT_CONTENT)

_DATABASE_ERRORS = (OSError, asyncpg.PostgresError, asyncpg.InterfaceError)
_URL_PASSWORD = re.compile(r"(\w+://[^:/@\s]*:)[^@\s]*@")


class StoreError(Exception):
    """The database is not configured or not reachable, lacks the schema, refused a write, or
    has no run for `--since auto` to continue from."""


class RunInfo(BaseModel):
    """What ran, for the `crawl_runs` row."""

    model_config = ConfigDict(frozen=True)

    source: SourceName
    topics: list[str]
    arguments: list[str]
    started_at: datetime
    finished_at: datetime


class StoreReport(BaseModel):
    """What one store run did; the counts are also in its `crawl_runs` row."""

    run_id: int
    inserted: int
    changed: int
    unchanged: int
    cited: int
    """Stored documents not collected in this run that got a new `cited_by` entry."""
    expired: int


def database_url() -> str:
    """`DATABASE_URL` from the environment, else from `crawler/.env`; empty counts as unset."""
    url = os.environ.get(DATABASE_URL) or dotenv_values(ENV_FILE).get(DATABASE_URL) or ""
    if not url.strip():
        raise StoreError(f"{DATABASE_URL} is not set; add it to crawler/.env (see .env.example)")
    return url.strip()


def document_row(document: SourceDocument) -> tuple[object, ...]:
    """The `documents` row of a record, in the order of `COLUMNS`."""
    data = _storable(document.model_dump(mode="json"))
    external_ids = dict(data["external_ids"])
    if data["channel_id"] is not None:
        external_ids["channel_id"] = data["channel_id"]
    return (
        data["id"],
        data["source"],
        data["source_id"],
        data["version"],
        data["content_type"],
        data["publication_types"],
        data["title"],
        _json(data["authors"]),
        data["journal"],
        data["abstract"] or data["description"] or None,
        data["language"],
        _json(data["subjects"]),
        document.published_on,
        data["published_precision"],
        _utc(document.source_updated_at),
        data["duration_seconds"],
        data["url"],
        data["doi"],
        _json(external_ids),
        data["licence"],
        _json(data["full_text"]),
        _json(data["found_by"]),
        _utc(document.retrieved_at),
        _utc(document.refresh_after),
        _json(data["extra"]),
    )


async def prepare_store(url: str, source: SourceName, *, load_ids: bool) -> frozenset[str]:
    """Check that the database has the schema; with `load_ids`, return the stored IDs of `source`.

    Called before a crawl, so a missing database fails the run before it fetches anything.
    """
    async with _connect(url) as connection:
        try:
            missing = [
                table
                for table in TABLES
                if await connection.fetchval("SELECT to_regclass($1) IS NULL", table)
            ]
            if missing:
                raise StoreError(
                    f"the database has no {' or '.join(missing)} table; apply db/init/ "
                    "with `make db` (see Documentation/database.md)"
                )
            if not load_ids:
                return frozenset()
            rows = await connection.fetch(
                "SELECT id FROM documents WHERE source = $1", source.value
            )
        except _DATABASE_ERRORS as error:
            raise StoreError(f"cannot read from the database: {_describe(error)}") from error
    return frozenset(str(row["id"]) for row in rows)


async def last_successful_runs(
    url: str, source: SourceName, topics: Sequence[str]
) -> dict[str, datetime]:
    """When the last successful run of `source` started, per topic; topics without one are left
    out."""
    async with _connect(url) as connection:
        try:
            rows = await connection.fetch(_LAST_RUNS, source.value, list(topics))
        except _DATABASE_ERRORS as error:
            raise StoreError(f"cannot read from the database: {_describe(error)}") from error
    return {str(row["topic"]): row["started_at"] for row in rows}


def resume_date(last_runs: Mapping[str, datetime], topics: Sequence[str]) -> date:
    """The date `--since auto` stands for: `RESUME_OVERLAP` before the oldest of the topics' last
    successful runs, so no topic misses a day. A topic without one needs a run without `--since`
    first."""
    missing = [topic for topic in topics if topic not in last_runs]
    if missing:
        more = f" and {len(missing) - 5} more" if len(missing) > 5 else ""
        raise StoreError(
            f"--since auto: no successful run with --store yet for {', '.join(missing[:5])}"
            f"{more}; run them once without --since first"
        )
    oldest = min(last_runs[topic] for topic in topics)
    return (oldest - RESUME_OVERLAP).astimezone(UTC).date()


async def save_result(url: str, result: CollectionResult, run: RunInfo) -> StoreReport:
    """Store the documents, the citations of stored documents and the run; all or nothing.

    Documents are upserted by `id`. `found_by` gains the new entries, `changed_at` moves only if
    the content changed. `result.citations` also holds stored documents that were skipped as
    known; they get the `cited_by` entries the run found for them. Expired rows are deleted.
    """
    rows = [document_row(document) for document in result.documents]
    collected = {document.id for document in result.documents}
    citations = {
        cited_id: [{"cited_by": citing_id} for citing_id in citing_ids]
        for cited_id, citing_ids in result.citations.items()
        if cited_id not in collected
    }
    stats = _json(result.stats.model_dump(mode="json"))
    failures = _json(_storable([failure.model_dump(mode="json") for failure in result.failures]))
    async with _connect(url) as connection:
        try:
            async with connection.transaction():
                await connection.execute("SELECT pg_advisory_xact_lock($1)", STORE_LOCK)
                flags = await connection.fetchmany(_UPSERT, rows) if rows else []
                cited = 0
                if citations:
                    status = await connection.execute(_CITE, _json(_storable(citations)))
                    cited = _count(status)
                expired = _count(await connection.execute(_EXPIRE))
                inserted = sum(1 for flag in flags if flag["inserted"])
                changed = sum(1 for flag in flags if flag["changed"] and not flag["inserted"])
                unchanged = len(flags) - inserted - changed
                run_id = await connection.fetchval(
                    _LOG_RUN,
                    run.source.value,
                    run.topics,
                    run.arguments,
                    _utc(run.started_at),
                    _utc(run.finished_at),
                    result.ok,
                    stats,
                    failures,
                    _storable(result.run_error),
                    inserted,
                    changed,
                    unchanged,
                    cited,
                    expired,
                )
        except _DATABASE_ERRORS as error:
            raise StoreError(f"cannot write to the database: {_describe(error)}") from error
    return StoreReport(
        run_id=int(run_id),
        inserted=inserted,
        changed=changed,
        unchanged=unchanged,
        cited=cited,
        expired=expired,
    )


@asynccontextmanager
async def _connect(url: str) -> AsyncIterator[Any]:
    """An asyncpg connection (`Any`: asyncpg has no type hints); failures become `StoreError`."""
    try:
        connection = await asyncpg.connect(url, timeout=CONNECT_TIMEOUT_SECONDS)
    except (*_DATABASE_ERRORS, ValueError) as error:  # ValueError: e.g. a port that is no number
        raise StoreError(f"cannot connect to the database: {_describe(error)}") from error
    try:
        yield connection
    finally:
        with suppress(*_DATABASE_ERRORS):
            await connection.close()


def _merged_found_by(old: str, new: str) -> str:
    """SQL for `old` followed by the entries of `new` it lacks; jsonb ignores key order."""
    return (
        "(SELECT coalesce(jsonb_agg(entry ORDER BY first_seen), '[]'::jsonb)"
        " FROM (SELECT entry, min(seen) AS first_seen"
        f" FROM jsonb_array_elements({old} || {new}) WITH ORDINALITY AS item (entry, seen)"
        " GROUP BY entry) AS merged)"
    )


_UPSERT = f"""
INSERT INTO documents AS d ({", ".join(COLUMNS)})
VALUES ({", ".join(f"${number}" for number in range(1, len(COLUMNS) + 1))})
ON CONFLICT (id) DO UPDATE SET
    {", ".join(f"{column} = EXCLUDED.{column}" for column in _CONTENT)},
    found_by = {_merged_found_by("d.found_by", "EXCLUDED.found_by")},
    retrieved_at = EXCLUDED.retrieved_at,
    expires_at = EXCLUDED.expires_at,
    changed_at = CASE
        WHEN ({", ".join(f"d.{column}" for column in _CONTENT)})
            IS DISTINCT FROM ({", ".join(f"EXCLUDED.{column}" for column in _CONTENT)})
        THEN now()
        ELSE d.changed_at
    END
RETURNING created_at = now() AS inserted, changed_at = now() AS changed
"""

_CITE = f"""
UPDATE documents AS d
SET found_by = {_merged_found_by("d.found_by", "cited.found_by")}
FROM jsonb_each($1::jsonb) AS cited (id, found_by)
WHERE d.id = cited.id AND NOT d.found_by @> cited.found_by
"""

_EXPIRE = "DELETE FROM documents WHERE expires_at < now()"

_LAST_RUNS = """
SELECT topic, max(started_at) AS started_at
FROM crawl_runs, unnest(topics) AS topic
WHERE source = $1 AND ok AND topic = ANY($2::text[])
GROUP BY topic
"""

_LOG_RUN = """
INSERT INTO crawl_runs (
    source, topics, arguments, started_at, finished_at, ok, stats, failures, run_error,
    inserted, changed, unchanged, cited, expired
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
RETURNING id
"""


def _json(value: object) -> str:
    """A jsonb parameter; asyncpg takes JSON as text."""
    return json.dumps(value, ensure_ascii=False)


def _storable(value: Any) -> Any:
    """`value` with text Postgres accepts: NUL characters removed, lone surrogates replaced."""
    if isinstance(value, str):
        return value.replace("\x00", "").encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, list):
        return [_storable(item) for item in value]
    if isinstance(value, dict):
        return {key: _storable(item) for key, item in value.items()}
    return value


def _utc(value: datetime | None) -> datetime | None:
    """Naive datetimes are UTC in the crawler; asyncpg would read them as local time."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def _count(status: str) -> int:
    """The row count of a command status such as `UPDATE 3`."""
    return int(status.rsplit(" ", 1)[-1])


def _describe(error: BaseException) -> str:
    """Type and message of an error, without the password should a connection URL show up."""
    return _URL_PASSWORD.sub(r"\1<redacted>@", f"{type(error).__name__}: {error}")
