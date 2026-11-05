from datetime import date

import pytest
from pydantic import ValidationError

from crawler.models import (
    CitationProvenance,
    CollectionResult,
    QueryProvenance,
    RequestFailure,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    source_document_id,
)


def test_source_document_id_is_stable_and_source_scoped() -> None:
    assert source_document_id(SourceName.PUBMED, "123") == "pubmed:123"
    assert source_document_id(SourceName.ARXIV, "123") == "arxiv:123"


def test_request_requires_the_source_specific_input() -> None:
    with pytest.raises(ValidationError, match="query or ids is required"):
        ScrapeRequest(source=SourceName.PUBMED)
    with pytest.raises(ValidationError, match="channel is required"):
        ScrapeRequest(source=SourceName.YOUTUBE)


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        ({"source": "pubmed", "query": "q", "ids": ["1"]}, "either a query or ids"),
        ({"source": "arxiv", "channel": "UC1"}, "channel is only valid for YouTube"),
        ({"source": "youtube", "channel": "UC1", "query": "q"}, "channel only"),
        ({"source": "youtube", "channel": "UC1", "ids": ["1"]}, "channel only"),
    ],
)
def test_request_rejects_mixed_inputs(arguments: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        ScrapeRequest.model_validate(arguments)


def test_request_with_ids_is_a_lookup() -> None:
    lookup = ScrapeRequest(source=SourceName.ARXIV, ids=["2610.12345"])
    search = ScrapeRequest(source=SourceName.ARXIV, query="prostate cancer")

    assert lookup.is_lookup
    assert not search.is_lookup


def test_found_by_dumps_to_the_documents_table_shapes() -> None:
    document = SourceDocument(
        id="pubmed:1",
        source=SourceName.PUBMED,
        content_type="journal_article",
        source_id="1",
        title="Provenance test",
        url="https://example.test/1",
        found_by=[
            QueryProvenance(topic="prostate_cancer", query="prostate cancer"),
            QueryProvenance(query="psa"),
            CitationProvenance(cited_by="pubmed:2"),
        ],
    )

    dumped = document.model_dump(mode="json")["found_by"]

    assert dumped == [
        {"topic": "prostate_cancer", "query": "prostate cancer"},
        {"topic": None, "query": "psa"},
        {"cited_by": "pubmed:2"},
    ]
    assert SourceDocument.model_validate_json(document.model_dump_json()) == document


def failure(retryable: bool) -> RequestFailure:
    return RequestFailure(
        kind="search",
        source=SourceName.PUBMED,
        detail="prostate cancer",
        depth=0,
        error="ConnectionError: source unavailable",
        retries=3 if retryable else 0,
        retryable=retryable,
    )


def test_result_is_ok_only_without_failures() -> None:
    assert CollectionResult(documents=[]).ok
    assert not CollectionResult(documents=[], failures=[failure(True)]).ok
    assert not CollectionResult(documents=[], failures=[failure(False)]).ok
    assert not CollectionResult(documents=[], run_error="RuntimeError: boom").ok


@pytest.mark.parametrize(
    ("published_at", "published_on", "precision"),
    [
        ("2026-10-31T00:00:00+00:00", date(2026, 10, 31), "day"),
        ("2026-10-31", date(2026, 10, 31), "day"),
        ("2026-10", date(2026, 10, 1), "month"),
        ("2024", date(2024, 1, 1), "year"),
        ("2026-10-31T10:00:00Z", date(2026, 10, 31), "day"),
        (None, None, None),
    ],
)
def test_document_normalizes_source_publication_dates(
    published_at: str | None,
    published_on: date | None,
    precision: str | None,
) -> None:
    document = SourceDocument(
        id="pubmed:1",
        source=SourceName.PUBMED,
        content_type="journal_article",
        source_id="1",
        title="Publication date test",
        url="https://example.test/1",
        published_at=published_at,
    )

    assert document.published_at == published_at
    assert document.published_on == published_on
    assert document.published_precision == precision
    assert document.model_dump(mode="json")["published_on"] == (
        published_on.isoformat() if published_on else None
    )


def test_document_rejects_an_invalid_publication_date() -> None:
    with pytest.raises(ValidationError, match="published_at must be ISO 8601"):
        SourceDocument(
            id="pubmed:1",
            source=SourceName.PUBMED,
            content_type="journal_article",
            source_id="1",
            title="Invalid publication date test",
            url="https://example.test/1",
            published_at="31 October 2026",
        )


def test_podcast_requests_take_a_feed_only() -> None:
    feed = {
        "key": "jco",
        "name": "JCO Podcast",
        "url": "https://jcopodcast.libsyn.com/rss",
        "publisher": "ASCO",
        "audience": "clinicians",
    }

    request = ScrapeRequest.model_validate({"source": "podcast", "feed": feed})

    assert request.seed_label == "jco"
    with pytest.raises(ValidationError, match="feed is required for podcasts"):
        ScrapeRequest.model_validate({"source": "podcast"})
    with pytest.raises(ValidationError, match="feed only"):
        ScrapeRequest.model_validate({"source": "podcast", "feed": feed, "query": "q"})
    with pytest.raises(ValidationError, match="feed is only valid for podcasts"):
        ScrapeRequest.model_validate({"source": "pubmed", "query": "q", "feed": feed})
