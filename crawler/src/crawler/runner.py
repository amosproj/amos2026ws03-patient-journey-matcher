import asyncio
import hashlib
import logging
import socket
from collections.abc import Awaitable, Callable, Iterable, Sequence
from datetime import timedelta
from pathlib import Path
from urllib.error import HTTPError as UrlHttpError
from uuid import uuid4

from arxiv import HTTPError as ArxivHttpError
from arxiv import UnexpectedEmptyPageError
from crawlee import ConcurrencySettings, Request
from crawlee.crawlers import BasicCrawler, BasicCrawlingContext
from crawlee.storage_clients import MemoryStorageClient
from crawlee.storages import RequestQueue
from dotenv import load_dotenv
from googleapiclient.errors import HttpError as GoogleHttpError
from pydantic import BaseModel, ConfigDict, Field

from crawler.frontier import REFERENCES_BATCH_SIZE, Frontier, TopicFilter
from crawler.links.arxiv import REFERENCES_BATCH_SIZE as ARXIV_REFERENCES_BATCH_SIZE
from crawler.links.arxiv import ArxivLinkExtractor
from crawler.links.base import LinkExtractor
from crawler.links.pubmed import PubMedLinkExtractor
from crawler.models import (
    CollectionResult,
    RequestFailure,
    RequestKind,
    ScrapeRequest,
    SourceName,
)
from crawler.sources.arxiv import LOOKUP_BATCH_SIZE as ARXIV_LOOKUP_BATCH_SIZE
from crawler.sources.arxiv import ArxivScraper
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, BaseScraper
from crawler.sources.podcast import PodcastScraper
from crawler.sources.pubmed import EFETCH_BATCH_SIZE, PubMedScraper
from crawler.sources.youtube import YouTubeScraper
from crawler.sources.zenodo import ZenodoScraper

__all__ = [
    "CollectionOptions",
    "CollectionSetupError",
    "link_extractor_from_env",
    "run_requests",
    "source_from_env",
]

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

logger = logging.getLogger(__name__)

SourceFactory = Callable[[SourceName], BaseScraper]
LinkExtractorFactory = Callable[[SourceName], LinkExtractor | None]
Sleep = Callable[[float], Awaitable[None]]


class CollectionSetupError(ValueError):
    """A scraper or link extractor could not be created, for example without an API key."""


class CollectionOptions(BaseModel):
    """Settings of one collection run."""

    model_config = ConfigDict(frozen=True)

    max_depth: int = Field(default=1, ge=0)
    """How many levels of references to follow; 0 collects the seeds only."""
    topic_terms: tuple[str, ...] = ()
    """Terms a cited paper must contain to be kept; empty keeps every cited paper."""
    match_all_terms: bool = False
    """Keep a cited paper only if it contains every topic term, not just one."""
    known_ids: frozenset[str] = frozenset()
    """Document IDs stored by earlier runs; cited papers among them are not fetched again."""
    max_requests: int | None = Field(default=None, ge=1)
    """Stop after this many queued requests, as a safety cap."""
    max_retries: int = Field(default=3, ge=0)
    retry_base_delay: float = Field(default=2.0, ge=0)
    retry_max_delay: float = Field(default=60.0, ge=0)
    handler_timeout: timedelta = timedelta(minutes=10)
    """Time limit of one request, before `item_timeout` is added for each item."""
    item_timeout: timedelta = timedelta(seconds=10)
    """Extra time per item of the largest request; arXiv spends about 3 s per paper."""


class CrawlTask(BaseModel):
    """Payload of one queued Crawlee request."""

    kind: RequestKind
    source: SourceName
    depth: int = Field(ge=0)
    request: ScrapeRequest | None = None
    """The source request of a search, channel listing or lookup."""
    ids: list[str] = Field(default_factory=list)
    """The citing native IDs of a reference request."""


def _retryable_status(status: int) -> bool:
    return status == 429 or 500 <= status < 600


def _is_retryable_error(error: Exception) -> bool:
    """Retry network failures, timeouts, HTTP 429 and HTTP 5xx responses."""
    if isinstance(error, ArxivHttpError):
        return _retryable_status(int(error.status))
    if isinstance(error, GoogleHttpError):
        return _retryable_status(int(error.status_code))
    if isinstance(error, UrlHttpError):
        return _retryable_status(error.code)
    if isinstance(error, UnexpectedEmptyPageError):
        return True
    return isinstance(error, OSError)


def _retry_after(error: Exception) -> float | None:
    """Seconds to wait from a `Retry-After` header, if the source sent one."""
    value: object = None
    if isinstance(error, UrlHttpError) and error.headers is not None:
        value = error.headers.get("Retry-After")
    elif isinstance(error, GoogleHttpError):
        value = error.resp.get("retry-after")
    if isinstance(value, str) and value.strip().isdigit():
        return float(value.strip())
    return None


def source_from_env(source: SourceName) -> BaseScraper:
    if source is SourceName.PUBMED:
        return PubMedScraper.from_env()
    if source is SourceName.ARXIV:
        return ArxivScraper()
    if source is SourceName.ZENODO:
        return ZenodoScraper()
    if source is SourceName.PODCAST:
        return PodcastScraper()
    return YouTubeScraper.from_env()


def link_extractor_from_env(source: SourceName) -> LinkExtractor | None:
    if source is SourceName.PUBMED:
        return PubMedLinkExtractor.from_env()
    if source is SourceName.ARXIV:
        return ArxivLinkExtractor.from_env()
    return None


def _create[T](factory: Callable[[SourceName], T], source: SourceName) -> T:
    try:
        return factory(source)
    except ValueError as error:
        raise CollectionSetupError(f"{source.value}: {error}") from error


def _seed_kind(request: ScrapeRequest) -> RequestKind:
    if request.source in {SourceName.YOUTUBE, SourceName.PODCAST}:
        return "channel"
    return "lookup" if request.is_lookup else "search"


def _queue_request(task: CrawlTask) -> Request:
    fingerprint = hashlib.sha256(task.model_dump_json().encode("utf-8")).hexdigest()
    return Request.from_url(
        f"https://{task.source.value}.crawler.invalid/{task.kind}/{fingerprint}",
        unique_key=f"{task.kind}:{fingerprint}",
        user_data={"task": task.model_dump(mode="json")},
    )


def _summarize_ids(ids: Sequence[str]) -> str:
    shown = ", ".join(ids[:3])
    return f"{len(ids)} ID(s): {shown}{', ...' if len(ids) > 3 else ''}"


def _describe(task: CrawlTask) -> str:
    if task.request is None:
        return _summarize_ids(task.ids)
    if task.request.is_lookup:
        return _summarize_ids(task.request.ids)
    return task.request.seed_label


def _describe_error(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"


def _handler_timeout(seeds: Sequence[ScrapeRequest], settings: CollectionOptions) -> timedelta:
    """The time limit for every request of the run, sized for its largest request.

    Sources make paced calls per item (arXiv one licence call per paper, 3 s apart), so a
    request's run time grows with the number of items it returns.
    """
    sizes = [len(seed.ids) if seed.is_lookup else seed.max_results for seed in seeds]
    if settings.max_depth > 0:
        sizes += [REFERENCES_BATCH_SIZE, EFETCH_BATCH_SIZE, ARXIV_LOOKUP_BATCH_SIZE]
    return settings.handler_timeout + settings.item_timeout * max(sizes, default=0)


async def _attempt[A, T](context: BasicCrawlingContext, call: Callable[[A], T], argument: A) -> T:
    """Run a source call in a worker thread; mark errors that a retry cannot fix."""
    work = asyncio.ensure_future(asyncio.to_thread(call, argument))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        # The request timed out or the run was cancelled, but the thread cannot be stopped.
        # Wait for it, so the next request never shares the source's pacing with it, and
        # do not repeat its work.
        context.request.no_retry = True
        await asyncio.wait([work])
        raise
    except Exception as error:
        if not _is_retryable_error(error):
            context.request.no_retry = True
        raise


async def run_requests(
    seeds: Iterable[ScrapeRequest],
    *,
    options: CollectionOptions | None = None,
    source_factory: SourceFactory = source_from_env,
    link_extractor_factory: LinkExtractorFactory = link_extractor_from_env,
    sleep: Sleep = asyncio.sleep,
) -> CollectionResult:
    """Collect the seed requests and, up to `max_depth`, the papers they cite.

    One Crawlee queue holds three kinds of request: seeds (search or channel), reference
    requests for collected papers, and lookups of cited papers in batches. Failed requests
    are reported in the result; they do not discard what the other requests collected.
    """
    settings = options or CollectionOptions()
    load_dotenv(ENV_FILE)
    seed_list = list(seeds)
    sources = list(dict.fromkeys(seed.source for seed in seed_list))
    scrapers = {source: _create(source_factory, source) for source in sources}
    extractors: dict[SourceName, LinkExtractor | None] = {
        source: _create(link_extractor_factory, source) if settings.max_depth > 0 else None
        for source in sources
    }
    frontier = Frontier(
        max_depth=settings.max_depth,
        topic_filter=TopicFilter(settings.topic_terms, match_all=settings.match_all_terms),
        known_ids=settings.known_ids,
        lookup_batch_size={
            SourceName.PUBMED: EFETCH_BATCH_SIZE,
            SourceName.ARXIV: ARXIV_LOOKUP_BATCH_SIZE,
        },
        references_batch_size={SourceName.ARXIV: ARXIV_REFERENCES_BATCH_SIZE},
    )
    failures: list[RequestFailure] = []
    queued: set[str] = set()
    settled: set[str] = set()

    # A fresh in-memory queue per run. Crawlee caches the default queue per process, so a
    # second run would otherwise skip every request the first run already handled.
    storage_client = MemoryStorageClient()
    queue = await RequestQueue.open(alias=f"run-{uuid4().hex}", storage_client=storage_client)
    crawler = BasicCrawler(
        request_manager=queue,
        storage_client=storage_client,
        max_request_retries=settings.max_retries,
        max_requests_per_crawl=settings.max_requests,
        request_handler_timeout=_handler_timeout(seed_list, settings),
        use_session_pool=False,
        abort_on_error=False,
        configure_logging=False,
        concurrency_settings=ConcurrencySettings(
            min_concurrency=1, desired_concurrency=1, max_concurrency=1
        ),
    )

    async def collect(context: BasicCrawlingContext, task: CrawlTask) -> list[Request]:
        if task.request is None:
            raise ValueError(f"{task.kind} task without a source request")
        request = task.request
        scraper = scrapers[task.source]
        documents = await _attempt(context, scraper.scrape, request)
        # The fallible work is done. Update the run state, then return the follow-ups;
        # Crawlee adds them only after the handler succeeds, so a failed attempt leaves
        # no trace in either.
        batches = frontier.add_documents(
            request, task.depth, documents, expand=extractors.get(task.source) is not None
        )
        return [
            _queue_request(
                CrawlTask(kind="references", source=task.source, depth=task.depth, ids=batch)
            )
            for batch in batches
        ]

    async def find_references(context: BasicCrawlingContext, task: CrawlTask) -> list[Request]:
        extractor = extractors.get(task.source)
        if extractor is None:
            raise ValueError(f"no link extractor for {task.source.value}")
        cited = await _attempt(context, extractor.cited_ids, task.ids)
        batches = frontier.add_references(task.source, cited)
        return [
            _queue_request(
                CrawlTask(
                    kind="lookup",
                    source=task.source,
                    depth=task.depth + 1,
                    request=ScrapeRequest(source=task.source, ids=batch),
                )
            )
            for batch in batches
        ]

    @crawler.router.default_handler
    async def handle(context: BasicCrawlingContext) -> None:
        task = CrawlTask.model_validate(context.request.user_data["task"])
        if task.kind == "references":
            follow_ups = await find_references(context, task)
        else:
            follow_ups = await collect(context, task)
        frontier.stats.finished_requests += 1
        settled.add(context.request.unique_key)
        if follow_ups:
            queued.update(follow_up.unique_key for follow_up in follow_ups)
            await context.add_requests(follow_ups)

    @crawler.error_handler
    async def back_off(context: BasicCrawlingContext, error: Exception) -> None:
        # Runs before each retry; `retry_count` already counts the coming retry.
        delay = _retry_after(error)
        if delay is None:
            delay = settings.retry_base_delay * 2 ** max(context.request.retry_count - 1, 0)
        delay = min(delay, settings.retry_max_delay)
        task = CrawlTask.model_validate(context.request.user_data["task"])
        logger.warning(
            "retry %d of %d in %.0f s: %s %s %s: %s",
            context.request.retry_count,
            settings.max_retries,
            delay,
            task.kind,
            task.source.value,
            _describe(task),
            _describe_error(error),
        )
        await sleep(delay)

    @crawler.failed_request_handler
    async def record_failure(context: BasicCrawlingContext, error: Exception) -> None:
        task = CrawlTask.model_validate(context.request.user_data["task"])
        failures.append(
            RequestFailure(
                kind=task.kind,
                source=task.source,
                detail=_describe(task),
                depth=task.depth,
                error=_describe_error(error),
                retries=context.request.retry_count,
                retryable=not context.request.no_retry,
            )
        )
        settled.add(context.request.unique_key)

    initial: dict[str, Request] = {}
    for seed in seed_list:
        task = CrawlTask(kind=_seed_kind(seed), source=seed.source, depth=0, request=seed)
        request = _queue_request(task)
        initial.setdefault(request.unique_key, request)
    frontier.stats.seed_requests = len(initial)
    queued.update(initial)

    # Biopython opens connections without a timeout; give them the default one.
    set_socket_timeout = socket.getdefaulttimeout() is None
    if set_socket_timeout:
        socket.setdefaulttimeout(NETWORK_TIMEOUT_SECONDS)
    run_error: str | None = None
    try:
        await crawler.run(list(initial.values()))
    except Exception as error:
        run_error = _describe_error(error)
    finally:
        if set_socket_timeout:
            socket.setdefaulttimeout(None)
        await queue.drop()

    frontier.stats.unprocessed_requests = len(queued - settled)
    return frontier.result(failures, run_error=run_error)
