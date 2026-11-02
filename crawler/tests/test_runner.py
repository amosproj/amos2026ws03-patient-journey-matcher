import asyncio

import pytest

from crawler.models import ScrapeRequest, SourceDocument, SourceName, SourceType
from crawler.runner import ScrapeRunError, run_requests
from crawler.sources.base import BaseScraper


class FakePubMedScraper(BaseScraper):
    source = SourceName.PUBMED

    def __init__(self) -> None:
        self.calls = 0

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        self.calls += 1
        return [
            SourceDocument(
                id="pubmed:1",
                source=self.source,
                source_type=SourceType.PAPER,
                source_id="1",
                title=request.query or "",
                url="https://pubmed.ncbi.nlm.nih.gov/1/",
                query_keywords=[request.query] if request.query else [],
            )
        ]


def test_runner_uses_crawlee_queue_to_deduplicate_requests() -> None:
    scraper = FakePubMedScraper()
    request = ScrapeRequest(source=SourceName.PUBMED, query="unique runner test")

    documents = asyncio.run(
        run_requests([request, request], source_factory=lambda _source: scraper)
    )

    assert scraper.calls == 1
    assert [document.id for document in documents] == ["pubmed:1"]


def test_runner_merges_query_keywords_for_duplicate_documents() -> None:
    scraper = FakePubMedScraper()
    requests = [
        ScrapeRequest(source=SourceName.PUBMED, query="a"),
        ScrapeRequest(source=SourceName.PUBMED, query="b"),
        ScrapeRequest(source=SourceName.PUBMED, query="a", max_results=20),
    ]

    documents = asyncio.run(run_requests(requests, source_factory=lambda _source: scraper))

    assert scraper.calls == 3
    assert len(documents) == 1
    assert documents[0].query_keywords == ["a", "b"]


class FailingScraper(BaseScraper):
    source = SourceName.PUBMED

    def __init__(self) -> None:
        self.calls = 0

    def scrape(self, _request: ScrapeRequest) -> list[SourceDocument]:
        self.calls += 1
        raise ConnectionError("source unavailable")


def test_runner_raises_after_crawlee_exhausts_retries() -> None:
    scraper = FailingScraper()
    request = ScrapeRequest(source=SourceName.PUBMED, query="failure test")

    with pytest.raises(ScrapeRunError, match="failed after 3 retries"):
        asyncio.run(run_requests([request], source_factory=lambda _source: scraper))

    assert scraper.calls == 4


class InvalidScraper(BaseScraper):
    source = SourceName.PUBMED

    def __init__(self) -> None:
        self.calls = 0

    def scrape(self, _request: ScrapeRequest) -> list[SourceDocument]:
        self.calls += 1
        raise ValueError("channel not found")


def test_runner_does_not_retry_permanent_errors() -> None:
    scraper = InvalidScraper()
    request = ScrapeRequest(source=SourceName.PUBMED, query="invalid test")

    with pytest.raises(ScrapeRunError, match="failed without retry: channel not found"):
        asyncio.run(run_requests([request], source_factory=lambda _source: scraper))

    assert scraper.calls == 1
