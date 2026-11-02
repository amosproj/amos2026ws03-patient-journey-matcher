from datetime import date

import pytest
from pydantic import ValidationError

from crawler.models import (
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)


def test_source_document_id_is_stable_and_source_scoped() -> None:
    assert source_document_id(SourceName.PUBMED, "123") == "pubmed:123"
    assert source_document_id(SourceName.ARXIV, "123") == "arxiv:123"


def test_request_requires_the_source_specific_input() -> None:
    with pytest.raises(ValidationError, match="query is required"):
        ScrapeRequest(source=SourceName.PUBMED)
    with pytest.raises(ValidationError, match="channel is required"):
        ScrapeRequest(source=SourceName.YOUTUBE)


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
        source_type=SourceType.PAPER,
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
            source_type=SourceType.PAPER,
            source_id="1",
            title="Invalid publication date test",
            url="https://example.test/1",
            published_at="31 October 2026",
        )
