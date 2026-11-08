import asyncio
import json
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from crawler import store
from crawler.models import (
    Author,
    CitationProvenance,
    FullTextLocator,
    QueryProvenance,
    SourceDocument,
    SourceName,
    Subject,
)
from crawler.store import (
    COLUMNS,
    StoreError,
    database_url,
    document_row,
    prepare_store,
    resume_date,
)

RETRIEVED = datetime(2026, 11, 6, 12, 0, tzinfo=UTC)


def row(document: SourceDocument) -> dict[str, object]:
    return dict(zip(COLUMNS, document_row(document), strict=True))


def paper(**fields: object) -> SourceDocument:
    values: dict[str, object] = {
        "id": "pubmed:1",
        "source": SourceName.PUBMED,
        "content_type": "journal_article",
        "source_id": "1",
        "title": "Prostate cancer",
        "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
        "retrieved_at": RETRIEVED,
    }
    return SourceDocument.model_validate(values | fields)


def test_document_row_maps_the_model_to_the_documented_columns() -> None:
    document = paper(
        version="1@1",
        authors=[Author(name="A. Author", orcid="0000-0002-1825-0097")],
        abstract="Background: text",
        language="en",
        published_at="2026-09",
        source_updated_at=datetime(2026, 10, 1, tzinfo=UTC),
        doi="10.1000/x",
        journal="J Urol",
        publication_types=["Review"],
        subjects=[Subject(scheme="mesh", id="D011471", label="Prostatic Neoplasms", major=True)],
        licence="CC-BY",
        full_text=[FullTextLocator(kind="jats", url="https://example.test/1.xml")],
        external_ids={"pmcid": "PMC1"},
        extra={"status": "MEDLINE"},
        found_by=[QueryProvenance(topic="prostate_cancer", query="prostate cancer")],
    )

    stored = row(document)

    assert stored["id"] == "pubmed:1"
    assert stored["source"] == "pubmed"
    assert stored["native_id"] == "1"
    assert stored["version"] == "1@1"
    assert stored["publication_types"] == ["Review"]
    assert stored["venue"] == "J Urol"
    assert stored["summary"] == "Background: text"
    assert stored["published_at"] == date(2026, 9, 1)
    assert stored["published_precision"] == "month"
    assert stored["source_updated_at"] == datetime(2026, 10, 1, tzinfo=UTC)
    assert stored["canonical_url"] == "https://pubmed.ncbi.nlm.nih.gov/1/"
    assert stored["doi"] == "10.1000/x"
    assert stored["licence"] == "CC-BY"
    assert stored["retrieved_at"] == RETRIEVED
    assert stored["expires_at"] is None
    assert json.loads(str(stored["authors"])) == [
        {"name": "A. Author", "orcid": "0000-0002-1825-0097", "affiliation": None}
    ]
    assert json.loads(str(stored["subjects"])) == [
        {"scheme": "mesh", "label": "Prostatic Neoplasms", "id": "D011471", "major": True}
    ]
    assert json.loads(str(stored["full_text"]))[0]["kind"] == "jats"
    assert json.loads(str(stored["external_ids"])) == {"pmcid": "PMC1"}
    assert json.loads(str(stored["extra"])) == {"status": "MEDLINE"}
    assert json.loads(str(stored["found_by"])) == [
        {"topic": "prostate_cancer", "query": "prostate cancer"}
    ]


def test_empty_lists_are_stored_as_empty_json() -> None:
    stored = row(paper())

    assert stored["publication_types"] == []
    assert [stored[column] for column in ("authors", "subjects", "full_text", "found_by")] == [
        "[]"
    ] * 4
    assert stored["external_ids"] == stored["extra"] == "{}"
    assert stored["published_at"] is None
    assert stored["published_precision"] is None


@pytest.mark.parametrize(
    ("abstract", "description", "summary"),
    [("Abstract", None, "Abstract"), (None, "Show notes", "Show notes"), ("", "Notes", "Notes")],
)
def test_summary_is_the_abstract_or_else_the_description(
    abstract: str | None, description: str | None, summary: str
) -> None:
    assert row(paper(abstract=abstract, description=description))["summary"] == summary


def test_channel_id_joins_the_external_ids() -> None:
    video = paper(
        id="youtube:abc",
        source=SourceName.YOUTUBE,
        content_type="video",
        source_id="abc",
        channel_id="UC1",
        external_ids={"other": "x"},
        refresh_after=RETRIEVED + timedelta(days=30),
    )

    stored = row(video)

    assert json.loads(str(stored["external_ids"])) == {"other": "x", "channel_id": "UC1"}
    assert stored["expires_at"] == RETRIEVED + timedelta(days=30)


def test_naive_datetimes_are_stored_as_utc() -> None:
    naive = datetime(2026, 11, 6, 12, 0)
    document = paper(source_updated_at=naive, retrieved_at=naive, refresh_after=naive)

    stored = row(document)

    for column in ("source_updated_at", "retrieved_at", "expires_at"):
        assert stored[column] == naive.replace(tzinfo=UTC)


def test_text_postgres_rejects_is_cleaned() -> None:
    document = paper(
        title="Prostate\x00 cancer",
        abstract="lone \ud800 surrogate",
        found_by=[CitationProvenance(cited_by="pubmed:2\x00")],
    )

    stored = row(document)

    assert stored["title"] == "Prostate cancer"
    assert stored["summary"] == "lone ? surrogate"
    assert json.loads(str(stored["found_by"])) == [{"cited_by": "pubmed:2"}]


def test_database_url_comes_from_the_environment_before_crawler_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("DATABASE_URL=postgresql://file/db\n", encoding="utf-8")
    monkeypatch.setattr(store, "ENV_FILE", env_file)
    monkeypatch.setenv("DATABASE_URL", " postgresql://environment/db ")

    assert database_url() == "postgresql://environment/db"

    monkeypatch.setenv("DATABASE_URL", "")

    assert database_url() == "postgresql://file/db"


@pytest.mark.parametrize("env_file_text", [None, "DATABASE_URL=\n", "DATABASE_URL=   \n"])
def test_a_missing_database_url_is_a_store_error(
    env_file_text: str | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_file = tmp_path / ".env"
    if env_file_text is not None:
        env_file.write_text(env_file_text, encoding="utf-8")
    monkeypatch.setattr(store, "ENV_FILE", env_file)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    with pytest.raises(StoreError, match="DATABASE_URL is not set"):
        database_url()


@pytest.mark.parametrize(
    "url",
    ["mysql://amos:topsecret@127.0.0.1/db", "postgresql://amos:topsecret@127.0.0.1:port/db"],
)
def test_a_broken_url_is_a_store_error_without_the_password(url: str) -> None:
    with pytest.raises(StoreError, match="cannot connect to the database") as error:
        asyncio.run(prepare_store(url, SourceName.PUBMED, load_ids=False))

    assert "topsecret" not in str(error.value)


def test_passwords_in_connection_urls_are_redacted_from_errors() -> None:
    error = RuntimeError("failed for postgresql://amos:topsecret@db:5432/x and more")

    assert store._describe(error) == (
        "RuntimeError: failed for postgresql://amos:<redacted>@db:5432/x and more"
    )


def test_resume_date_is_two_days_before_the_oldest_last_run_in_utc() -> None:
    last_runs = {
        "prostate_cancer": datetime(2026, 11, 7, 3, 0, tzinfo=UTC),
        # 23:30 UTC on the 6th, given in UTC+1.
        "type2_diabetes": datetime(2026, 11, 7, 0, 30, tzinfo=timezone(timedelta(hours=1))),
    }

    assert resume_date(last_runs, ["prostate_cancer"]) == date(2026, 11, 5)
    assert resume_date(last_runs, ["prostate_cancer", "type2_diabetes"]) == date(2026, 11, 4)


def test_resume_date_needs_a_successful_run_of_every_topic() -> None:
    last_runs = {"a": datetime(2026, 11, 7, tzinfo=UTC)}

    with pytest.raises(StoreError, match="yet for b, c; run them once without --since first"):
        resume_date(last_runs, ["a", "b", "c"])
    with pytest.raises(StoreError, match="yet for t1, t2, t3, t4, t5 and 2 more; "):
        resume_date(last_runs, [f"t{number}" for number in range(1, 8)])
