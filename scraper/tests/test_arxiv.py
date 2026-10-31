from datetime import UTC, date, datetime
from types import SimpleNamespace

from scraper.models import SourceName
from scraper.sources.arxiv import ArxivScraper


def test_build_query_keeps_the_legacy_date_filter() -> None:
    query = ArxivScraper.build_query("prostate cancer", "and", date(2026, 1, 2))
    assert query == (
        '(all:"prostate" AND all:"cancer") AND submittedDate:[202601020000 TO 300012312359]'
    )


def test_parse_result_returns_metadata_without_downloading_a_pdf() -> None:
    result = SimpleNamespace(
        get_short_id=lambda: "2610.12345v1",
        categories=["cs.AI", "q-bio.QM", "cs.AI"],
        doi="10.1000/arxiv",
        title="Clinical matching",
        entry_id="https://arxiv.org/abs/2610.12345v1",
        authors=[SimpleNamespace(name="Ada Lovelace")],
        summary="An abstract",
        published=datetime(2026, 10, 31, tzinfo=UTC),
        journal_ref=None,
    )

    document = ArxivScraper.parse_result(result, ["clinical", "matching"])

    assert document.id == "arxiv:2610.12345v1"
    assert document.source is SourceName.ARXIV
    assert document.url == "https://arxiv.org/abs/2610.12345v1"
    assert document.authors == ["Ada Lovelace"]
    assert document.keywords == ["cs.AI", "q-bio.QM"]
