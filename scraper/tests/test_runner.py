import asyncio

import pytest

from scraper.models import ScrapeRequest, SourceDocument, SourceName, SourceType
from scraper.runner import ScrapeRunError, run_requests
from scraper.sources.base import BaseScraper


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


class FailingScraper(BaseScraper):
    source = SourceName.PUBMED

    def scrape(self, _request: ScrapeRequest) -> list[SourceDocument]:
        raise ConnectionError("source unavailable")


def test_runner_raises_after_crawlee_exhausts_retries() -> None:
    request = ScrapeRequest(source=SourceName.PUBMED, query="failure test")

    with pytest.raises(ScrapeRunError, match="failed after retries"):
        asyncio.run(run_requests([request], source_factory=lambda _source: FailingScraper()))
