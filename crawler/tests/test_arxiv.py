from collections.abc import Iterator
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any

import arxiv
import pytest
import requests

from crawler.models import ScrapeRequest, SourceName
from crawler.sources.arxiv import ArxivScraper, is_arxiv_id, split_version


def test_default_client_delegates_retries_to_the_runner() -> None:
    scraper = ArxivScraper()

    assert scraper._client.num_retries == 0


def test_build_query_keeps_the_legacy_date_filter() -> None:
    query = ArxivScraper.build_query("prostate cancer", "and", date(2026, 1, 2))
    assert query == (
        '(all:"prostate" AND all:"cancer") AND submittedDate:[202601020000 TO 300012312359]'
    )


def arxiv_result(short_id: str, title: str = "Clinical matching") -> SimpleNamespace:
    return SimpleNamespace(
        get_short_id=lambda: short_id,
        categories=["q-bio.QM"],
        doi=None,
        title=title,
        entry_id=f"http://arxiv.org/abs/{short_id}",
        authors=[],
        summary="An abstract",
        published=datetime(2026, 10, 31, tzinfo=UTC),
        journal_ref=None,
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

    document = ArxivScraper.parse_result(result)

    assert document.id == "arxiv:2610.12345"
    assert document.source_id == "2610.12345"
    assert document.version == "1"
    assert document.content_type == "preprint"
    assert document.source is SourceName.ARXIV
    assert document.url == "https://arxiv.org/abs/2610.12345"
    assert document.authors == ["Ada Lovelace"]
    assert document.keywords == ["cs.AI", "q-bio.QM"]


@pytest.mark.parametrize(
    ("short_id", "expected"),
    [
        ("2610.12345v12", ("2610.12345", "12")),
        ("2610.12345", ("2610.12345", None)),
        ("hep-th/9901001v2", ("hep-th/9901001", "2")),
        ("math.GT/0309136v1", ("math.GT/0309136", "1")),
    ],
)
def test_split_version(short_id: str, expected: tuple[str, str | None]) -> None:
    assert split_version(short_id) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2610.12345", True),
        ("0704.0001", True),
        ("hep-th/9901001", True),
        ("math.GT/0309136", True),
        ("2610.12345v1", False),
        ("10.48550/arXiv.2610.12345", False),
        ("", False),
    ],
)
def test_is_arxiv_id(value: str, expected: bool) -> None:
    assert is_arxiv_id(value) is expected


class FakeClient:
    def __init__(self, found: set[str]) -> None:
        self.found = found
        self.searches: list[Any] = []
        self.num_retries = 0

    def results(self, search: Any) -> Iterator[SimpleNamespace]:
        self.searches.append(search)
        for arxiv_id in search.id_list:
            if arxiv_id in self.found:
                yield arxiv_result(f"{arxiv_id}v2")
        if len(self.found.intersection(search.id_list)) < len(search.id_list):
            raise arxiv.UnexpectedEmptyPageError("https://export.arxiv.org", 0, None)


def test_lookup_keeps_results_when_arxiv_leaves_out_unknown_ids() -> None:
    client = FakeClient(found={"2610.00001", "2610.00003"})
    scraper = ArxivScraper(client=client)

    documents = scraper.scrape(
        ScrapeRequest(source=SourceName.ARXIV, ids=["2610.00001", "2610.00002", "2610.00003"])
    )

    assert [search.id_list for search in client.searches] == [
        ["2610.00001", "2610.00002", "2610.00003"]
    ]
    assert [document.id for document in documents] == ["arxiv:2610.00001", "arxiv:2610.00003"]
    assert {document.version for document in documents} == {"2"}


def test_lookup_asks_for_at_most_100_ids_per_query() -> None:
    ids = [f"2610.{number:05d}" for number in range(250)]
    client = FakeClient(found=set(ids))

    documents = ArxivScraper(client=client).scrape(ScrapeRequest(source=SourceName.ARXIV, ids=ids))

    assert [len(search.id_list) for search in client.searches] == [100, 100, 50]
    assert len(documents) == 250


def test_default_client_sends_requests_with_a_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict[str, Any] = {}

    def fake_request(_session: Any, _method: str, _url: str, **arguments: Any) -> Any:
        sent.update(arguments)
        return SimpleNamespace(status_code=200)

    monkeypatch.setattr(requests.Session, "request", fake_request)

    ArxivScraper()._client._session.get("https://export.arxiv.org/api/query")

    assert sent["timeout"] == 60.0
