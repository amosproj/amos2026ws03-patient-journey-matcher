"""The store against PostgreSQL at `TEST_DATABASE_URL`; each test gets its own schema."""

import asyncio
import json
import os
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import asyncpg
import pytest

from crawler.models import (
    CitationProvenance,
    CollectionResult,
    CollectionStats,
    QueryProvenance,
    RequestFailure,
    SourceDocument,
    SourceName,
)
from crawler.store import (
    RunInfo,
    StoreError,
    StoreReport,
    last_successful_runs,
    prepare_store,
    save_result,
)

pytestmark = pytest.mark.postgres

INIT_DIR = Path(__file__).resolve().parents[2] / "db" / "init"
RETRIEVED = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
# Expiry is compared with the database clock, so tests use dates far from today.
LONG_AGO = datetime(2000, 1, 1, tzinfo=UTC)
FAR_AHEAD = datetime(2999, 1, 1, tzinfo=UTC)
# The index table convention of Documentation/storage.md.
INDEX_TABLE = """
CREATE TABLE keyword_index (
    document_id text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    version text,
    document_changed_at timestamptz NOT NULL
)
"""


async def execute(url: str, sql: str) -> None:
    connection = await asyncpg.connect(url)
    try:
        await connection.execute(sql)
    finally:
        await connection.close()


async def fetch(url: str, sql: str, *args: object) -> list[dict[str, Any]]:
    connection = await asyncpg.connect(url)
    try:
        await connection.set_type_codec(
            "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"
        )
        return [dict(row) for row in await connection.fetch(sql, *args)]
    finally:
        await connection.close()


def query(url: str, sql: str, *args: object) -> list[dict[str, Any]]:
    return asyncio.run(fetch(url, sql, *args))


def with_search_path(url: str, schema: str) -> str:
    """asyncpg passes unknown URL parameters on to the server as settings."""
    return f"{url}{'&' if '?' in url else '?'}search_path={schema}"


def apply_schema(url: str) -> None:
    for path in sorted(INIT_DIR.glob("*.sql")):
        asyncio.run(execute(url, path.read_text(encoding="utf-8")))


@pytest.fixture(scope="session")
def database() -> str:
    url = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not url:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set on CI")
        pytest.skip("TEST_DATABASE_URL is not set")
    # Once, outside the test schemas: dropping a test schema would drop the extension with it.
    asyncio.run(execute(url, "CREATE EXTENSION IF NOT EXISTS vector"))
    return url


@pytest.fixture
def url(database: str) -> Iterator[str]:
    """A URL whose search path is a fresh schema with `db/init/` applied."""
    schema = f"test_{uuid4().hex[:12]}"
    asyncio.run(execute(database, f"CREATE SCHEMA {schema}"))
    try:
        scoped = with_search_path(database, schema)
        apply_schema(scoped)
        yield scoped
    finally:
        asyncio.run(execute(database, f"DROP SCHEMA {schema} CASCADE"))


def paper(native_id: str, **fields: Any) -> SourceDocument:
    values: dict[str, Any] = {
        "id": f"pubmed:{native_id}",
        "source": SourceName.PUBMED,
        "content_type": "journal_article",
        "source_id": native_id,
        "title": f"Paper {native_id}",
        "url": f"https://pubmed.ncbi.nlm.nih.gov/{native_id}/",
        "published_at": "2026-09",
        "retrieved_at": RETRIEVED,
    }
    return SourceDocument.model_validate(values | fields)


def video(native_id: str, expires_at: datetime) -> SourceDocument:
    return paper(
        native_id,
        id=f"youtube:{native_id}",
        source=SourceName.YOUTUBE,
        content_type="video",
        url=f"https://www.youtube.com/watch?v={native_id}",
        refresh_after=expires_at,
    )


def save(
    url: str,
    *documents: SourceDocument,
    citations: dict[str, list[str]] | None = None,
    failures: list[RequestFailure] | None = None,
) -> StoreReport:
    result = CollectionResult(
        documents=list(documents),
        citations=citations or {},
        failures=failures or [],
        stats=CollectionStats(documents=len(documents)),
    )
    run = RunInfo(
        source=SourceName.PUBMED,
        topics=["prostate_cancer"],
        arguments=["pubmed", "--topic", "prostate_cancer", "--store"],
        started_at=RETRIEVED,
        finished_at=RETRIEVED + timedelta(minutes=5),
    )
    return asyncio.run(save_result(url, result, run))


def set_timestamps(url: str, document_id: str, moment: datetime) -> None:
    query(
        url,
        "UPDATE documents SET created_at = $2, changed_at = $2 WHERE id = $1",
        document_id,
        moment,
    )


def test_the_schema_files_apply_twice(url: str) -> None:
    apply_schema(url)

    tables = query(url, "SELECT to_regclass('documents') AS d, to_regclass('crawl_runs') AS r")
    assert tables == [{"d": "documents", "r": "crawl_runs"}]


def test_prepare_needs_the_schema(database: str) -> None:
    empty = with_search_path(database, f"missing_{uuid4().hex[:12]}")

    with pytest.raises(StoreError, match="no documents or crawl_runs table; apply db/init/"):
        asyncio.run(prepare_store(empty, SourceName.PUBMED, load_ids=False))


def test_prepare_returns_the_stored_ids_of_one_source_when_asked(url: str) -> None:
    save(url, paper("1"), paper("2"), video("v1", FAR_AHEAD))

    assert asyncio.run(prepare_store(url, SourceName.PUBMED, load_ids=True)) == {
        "pubmed:1",
        "pubmed:2",
    }
    assert asyncio.run(prepare_store(url, SourceName.PUBMED, load_ids=False)) == frozenset()


@pytest.mark.usefixtures("database")
def test_a_refused_connection_is_a_store_error_without_the_password() -> None:
    with pytest.raises(StoreError, match="cannot connect to the database") as error:
        asyncio.run(
            prepare_store(
                "postgresql://amos:topsecret@127.0.0.1:1/db", SourceName.PUBMED, load_ids=False
            )
        )

    assert "topsecret" not in str(error.value)


def test_save_inserts_the_documents_and_logs_the_run(url: str) -> None:
    failure = RequestFailure(
        kind="lookup",
        source=SourceName.PUBMED,
        detail="1 ID(s): 9",
        depth=1,
        error="HTTPError: HTTP Error 400",
        retries=0,
        retryable=False,
    )
    undated = paper("2", published_at=None)

    report = save(url, paper("1"), undated, failures=[failure])

    assert report.model_dump(exclude={"run_id"}) == {
        "inserted": 2,
        "changed": 0,
        "unchanged": 0,
        "cited": 0,
        "expired": 0,
    }
    rows = query(
        url,
        "SELECT id, native_id, published_at::text, published_precision, found_by"
        " FROM documents ORDER BY id",
    )
    assert rows == [
        {
            "id": "pubmed:1",
            "native_id": "1",
            "published_at": "2026-09-01",
            "published_precision": "month",
            "found_by": [],
        },
        {
            "id": "pubmed:2",
            "native_id": "2",
            "published_at": None,
            "published_precision": None,
            "found_by": [],
        },
    ]
    [run] = query(url, "SELECT * FROM crawl_runs")
    assert run["id"] == report.run_id
    assert run["source"] == "pubmed"
    assert run["topics"] == ["prostate_cancer"]
    assert run["arguments"] == ["pubmed", "--topic", "prostate_cancer", "--store"]
    assert run["started_at"] == RETRIEVED
    assert run["finished_at"] == RETRIEVED + timedelta(minutes=5)
    assert run["ok"] is False
    assert run["stats"]["documents"] == 2
    assert run["failures"] == [failure.model_dump(mode="json")]
    assert run["run_error"] is None
    assert (run["inserted"], run["changed"], run["unchanged"], run["cited"], run["expired"]) == (
        2,
        0,
        0,
        0,
        0,
    )


def test_saving_again_refreshes_retrieved_at_but_keeps_changed_at(url: str) -> None:
    save(url, paper("1"))
    set_timestamps(url, "pubmed:1", LONG_AGO)

    report = save(url, paper("1", retrieved_at=RETRIEVED + timedelta(days=1)))

    assert (report.inserted, report.changed, report.unchanged) == (0, 0, 1)
    [row] = query(url, "SELECT retrieved_at, created_at, changed_at FROM documents")
    assert row == {
        "retrieved_at": RETRIEVED + timedelta(days=1),
        "created_at": LONG_AGO,
        "changed_at": LONG_AGO,
    }


def test_content_changes_move_changed_at(url: str) -> None:
    save(url, paper("1"))
    set_timestamps(url, "pubmed:1", LONG_AGO)

    report = save(url, paper("1", title="Corrected title"))

    assert (report.inserted, report.changed, report.unchanged) == (0, 1, 0)
    [row] = query(url, "SELECT title, created_at, changed_at FROM documents")
    assert row["title"] == "Corrected title"
    assert row["created_at"] == LONG_AGO
    assert row["changed_at"] > LONG_AGO


def test_found_by_keeps_its_order_and_gains_only_new_entries(url: str) -> None:
    seed = QueryProvenance(topic="prostate_cancer", query="psa")
    save(url, paper("1", found_by=[seed]))

    save(url, paper("1", found_by=[CitationProvenance(cited_by="pubmed:9"), seed]))

    [row] = query(url, "SELECT found_by FROM documents")
    assert row["found_by"] == [
        {"topic": "prostate_cancer", "query": "psa"},
        {"cited_by": "pubmed:9"},
    ]


def test_citations_of_stored_documents_are_added_once(url: str) -> None:
    save(url, paper("1"))
    set_timestamps(url, "pubmed:1", LONG_AGO)
    citations = {"pubmed:1": ["pubmed:5"], "pubmed:404": ["pubmed:5"]}

    first = save(url, paper("5"), citations=citations)
    again = save(url, paper("5"), citations=citations)

    assert (first.cited, again.cited) == (1, 0)
    [row] = query(url, "SELECT found_by, changed_at FROM documents WHERE id = 'pubmed:1'")
    assert row == {"found_by": [{"cited_by": "pubmed:5"}], "changed_at": LONG_AGO}


def test_expired_documents_and_their_index_rows_are_deleted(url: str) -> None:
    asyncio.run(execute(url, INDEX_TABLE))
    save(url, video("old", FAR_AHEAD), video("kept", FAR_AHEAD))
    query(
        url,
        "INSERT INTO keyword_index (document_id, document_changed_at)"
        " SELECT id, changed_at FROM documents",
    )
    query(url, "UPDATE documents SET expires_at = $1 WHERE id = 'youtube:old'", LONG_AGO)

    report = save(url, video("kept", FAR_AHEAD))

    assert report.expired == 1
    assert query(url, "SELECT id FROM documents") == [{"id": "youtube:kept"}]
    assert query(url, "SELECT document_id FROM keyword_index") == [{"document_id": "youtube:kept"}]


def test_a_failed_save_stores_nothing(url: str) -> None:
    mismatched = paper("2", id="pubmed:3")

    with pytest.raises(StoreError, match="cannot write to the database"):
        save(url, paper("1"), mismatched)

    assert query(url, "SELECT count(*) AS n FROM documents") == [{"n": 0}]
    assert query(url, "SELECT count(*) AS n FROM crawl_runs") == [{"n": 0}]


def log_run(
    url: str,
    topics: list[str],
    started_at: datetime,
    *,
    ok: bool = True,
    source: SourceName = SourceName.PUBMED,
) -> None:
    failure = RequestFailure(
        kind="search",
        source=source,
        detail="q",
        depth=0,
        error="HTTPError: HTTP Error 500",
        retries=3,
        retryable=True,
    )
    result = CollectionResult(documents=[], failures=[] if ok else [failure])
    run = RunInfo(
        source=source,
        topics=topics,
        arguments=[source.value, "--store"],
        started_at=started_at,
        finished_at=started_at + timedelta(minutes=5),
    )
    asyncio.run(save_result(url, result, run))


def test_last_successful_runs_are_per_topic_and_source(url: str) -> None:
    log_run(url, ["a", "b"], RETRIEVED)
    log_run(url, ["a"], RETRIEVED + timedelta(days=1))
    log_run(url, ["b"], RETRIEVED + timedelta(days=2), ok=False)
    log_run(url, ["b"], RETRIEVED + timedelta(days=3), source=SourceName.ARXIV)
    log_run(url, ["c"], RETRIEVED)

    last = asyncio.run(last_successful_runs(url, SourceName.PUBMED, ["a", "b", "d"]))

    assert last == {"a": RETRIEVED + timedelta(days=1), "b": RETRIEVED}


def test_duplicates_by_doi_and_the_last_run_of_a_source(url: str) -> None:
    preprint = paper(
        "2601.00001",
        id="arxiv:2601.00001",
        source=SourceName.ARXIV,
        content_type="preprint",
        doi="10.1000/x",
    )
    save(url, paper("1", doi="10.1000/x"), paper("2", doi="10.1000/y"))
    last = save(url, preprint)

    assert query(url, DUPLICATES) == [{"doi": "10.1000/x", "ids": ["arxiv:2601.00001", "pubmed:1"]}]
    assert query(url, LAST_RUNS) == [
        {"source": "pubmed", "id": last.run_id, "finished_at": RETRIEVED + timedelta(minutes=5)}
    ]


# Queries from Documentation/storage.md; the matcher's reads are tested in matcher/db.
DUPLICATES = """
SELECT doi, array_agg(id ORDER BY id) AS ids
FROM documents
WHERE doi IS NOT NULL
GROUP BY doi
HAVING count(*) > 1
"""
LAST_RUNS = """
SELECT DISTINCT ON (source) source, id, finished_at
FROM crawl_runs
ORDER BY source, finished_at DESC, id DESC
"""
