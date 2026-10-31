import asyncio
import hashlib
from collections.abc import Callable, Iterable
from pathlib import Path

from crawlee import ConcurrencySettings, Request
from crawlee.crawlers import BasicCrawler, BasicCrawlingContext
from dotenv import load_dotenv

from scraper.models import ScrapeRequest, SourceDocument, SourceName
from scraper.sources.arxiv import ArxivScraper
from scraper.sources.base import BaseScraper
from scraper.sources.pubmed import PubMedScraper
from scraper.sources.youtube import YouTubeScraper

SourceFactory = Callable[[SourceName], BaseScraper]


class ScrapeRunError(RuntimeError):
    """Raised after Crawlee exhausts retries for at least one request."""


def source_from_env(source: SourceName) -> BaseScraper:
    if source is SourceName.PUBMED:
        return PubMedScraper.from_env()
    if source is SourceName.ARXIV:
        return ArxivScraper()
    return YouTubeScraper.from_env()


async def run_requests(
    scrape_requests: Iterable[ScrapeRequest],
    *,
    source_factory: SourceFactory = source_from_env,
) -> list[SourceDocument]:
    """Run source API work through Crawlee's deduplicating retry queue."""
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    requests = list(scrape_requests)
    sources = {request.source: source_factory(request.source) for request in requests}
    results: dict[str, SourceDocument] = {}
    failures: list[Exception] = []
    crawler = BasicCrawler(
        max_request_retries=3,
        use_session_pool=False,
        abort_on_error=False,
        configure_logging=False,
        concurrency_settings=ConcurrencySettings(
            min_concurrency=1, desired_concurrency=1, max_concurrency=1
        ),
    )

    @crawler.router.default_handler
    async def handle(context: BasicCrawlingContext) -> None:
        payload = ScrapeRequest.model_validate(context.request.user_data["scrape_request"])
        scraper = sources[payload.source]
        documents = await asyncio.to_thread(scraper.scrape, payload)
        results.update((document.id, document) for document in documents)

    @crawler.failed_request_handler
    async def handle_failure(_context: BasicCrawlingContext, error: Exception) -> None:
        failures.append(error)

    queue_requests = []
    for scrape_request in requests:
        serialized = scrape_request.model_dump(mode="json")
        fingerprint = hashlib.sha256(scrape_request.model_dump_json().encode("utf-8")).hexdigest()
        queue_requests.append(
            Request.from_url(
                f"https://{scrape_request.source.value}.scraper.invalid/{fingerprint}",
                unique_key=fingerprint,
                user_data={"scrape_request": serialized},
            )
        )
    await crawler.run(queue_requests)
    if failures:
        raise ScrapeRunError(
            f"{len(failures)} scrape request(s) failed after retries: {failures[0]}"
        ) from failures[0]
    return list(results.values())
