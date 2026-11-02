import asyncio
import hashlib
from collections.abc import Callable, Iterable
from pathlib import Path
from urllib.error import HTTPError as UrlHttpError

from arxiv import HTTPError as ArxivHttpError
from crawlee import ConcurrencySettings, Request
from crawlee.crawlers import BasicCrawler, BasicCrawlingContext
from dotenv import load_dotenv
from googleapiclient.errors import HttpError as GoogleHttpError

from crawler.models import ScrapeRequest, SourceDocument, SourceName
from crawler.sources.arxiv import ArxivScraper
from crawler.sources.base import BaseScraper
from crawler.sources.pubmed import PubMedScraper
from crawler.sources.youtube import YouTubeScraper

SourceFactory = Callable[[SourceName], BaseScraper]


class ScrapeRunError(RuntimeError):
    """Raised when at least one source request fails."""


def _is_retryable_error(error: Exception) -> bool:
    """Retry only network failures, timeouts, and HTTP 5xx responses."""
    if isinstance(error, ArxivHttpError):
        return 500 <= int(error.status) < 600
    if isinstance(error, GoogleHttpError):
        return 500 <= int(error.status_code) < 600
    if isinstance(error, UrlHttpError):
        return 500 <= error.code < 600
    return isinstance(error, OSError)


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
    failures: list[tuple[Exception, int, bool]] = []
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
        try:
            documents = await asyncio.to_thread(scraper.scrape, payload)
        except Exception as error:
            if _is_retryable_error(error):
                raise
            failures.append((error, 0, True))
            return
        for document in documents:
            existing = results.get(document.id)
            if existing is not None:
                query_keywords = list(
                    dict.fromkeys([*existing.query_keywords, *document.query_keywords])
                )
                document = document.model_copy(update={"query_keywords": query_keywords})
            results[document.id] = document

    @crawler.failed_request_handler
    async def handle_failure(context: BasicCrawlingContext, error: Exception) -> None:
        failures.append((error, context.request.retry_count, False))

    queue_requests = []
    for scrape_request in requests:
        serialized = scrape_request.model_dump(mode="json")
        fingerprint = hashlib.sha256(scrape_request.model_dump_json().encode("utf-8")).hexdigest()
        queue_requests.append(
            Request.from_url(
                f"https://{scrape_request.source.value}.crawler.invalid/{fingerprint}",
                unique_key=fingerprint,
                user_data={"scrape_request": serialized},
            )
        )
    await crawler.run(queue_requests)
    if failures:
        messages = []
        permanent = [failure for failure in failures if failure[2]]
        exhausted = [failure for failure in failures if not failure[2]]
        if permanent:
            messages.append(
                f"{len(permanent)} scrape request(s) failed without retry: {permanent[0][0]}"
            )
        if exhausted:
            messages.append(
                f"{len(exhausted)} scrape request(s) failed after "
                f"{exhausted[0][1]} retries: {exhausted[0][0]}"
            )
        raise ScrapeRunError("; ".join(messages)) from failures[0][0]
    return list(results.values())
