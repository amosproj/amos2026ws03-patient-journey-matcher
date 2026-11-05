import asyncio
import threading
import time
from collections.abc import Sequence
from email.message import Message
from urllib.error import HTTPError

import pytest

from crawler.links.base import LinkExtractor
from crawler.models import (
    CitationProvenance,
    CollectionResult,
    QueryProvenance,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    source_document_id,
)
from crawler.runner import CollectionOptions, CollectionSetupError, run_requests
from crawler.sources.base import BaseScraper


def paper(native_id: str, title: str = "Outcomes in prostate cancer") -> SourceDocument:
    return SourceDocument(
        id=source_document_id(SourceName.PUBMED, native_id),
        source=SourceName.PUBMED,
        content_type="journal_article",
        source_id=native_id,
        title=title,
        url=f"https://pubmed.ncbi.nlm.nih.gov/{native_id}/",
    )


class FakeScraper(BaseScraper):
    """Searches return the configured PMIDs; lookups return the known records."""

    source = SourceName.PUBMED

    def __init__(
        self,
        searches: dict[str, list[str]] | None = None,
        records: dict[str, SourceDocument] | None = None,
        errors: dict[str, list[Exception]] | None = None,
    ) -> None:
        self.searches = searches or {}
        self.records = records or {}
        self.errors = errors or {}
        self.calls: list[ScrapeRequest] = []

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        self.calls.append(request)
        key = request.query or "lookup"
        if self.errors.get(key):
            raise self.errors[key].pop(0)
        if request.is_lookup:
            return [self.records[pmid] for pmid in request.ids if pmid in self.records]
        return [self.records.get(pmid, paper(pmid)) for pmid in self.searches.get(key, [])]

    @property
    def lookups(self) -> list[list[str]]:
        return [request.ids for request in self.calls if request.is_lookup]


class SlowScraper(FakeScraper):
    """Sleeps per query and records calls that start while another one still runs."""

    def __init__(self, delays: dict[str, float], **arguments: object) -> None:
        super().__init__(**arguments)  # type: ignore[arg-type]
        self.delays = delays
        self.running = 0
        self.overlaps = 0
        self._lock = threading.Lock()

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        with self._lock:
            self.overlaps += self.running > 0
            self.running += 1
        try:
            time.sleep(self.delays.get(request.query or "", 0))
            return super().scrape(request)
        finally:
            with self._lock:
                self.running -= 1


class FakeExtractor(LinkExtractor):
    source = SourceName.PUBMED

    def __init__(
        self, references: dict[str, list[str]], errors: list[Exception] | None = None
    ) -> None:
        self.references = references
        self.errors = errors or []
        self.calls: list[list[str]] = []

    def cited_ids(self, native_ids: Sequence[str]) -> dict[str, list[str]]:
        self.calls.append(list(native_ids))
        if self.errors:
            raise self.errors.pop(0)
        return {pmid: self.references.get(pmid, []) for pmid in native_ids}


class RecordingSleep:
    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


def collect(
    seeds: list[ScrapeRequest],
    scraper: FakeScraper,
    extractor: FakeExtractor | None = None,
    sleep: RecordingSleep | None = None,
    **options: object,
) -> CollectionResult:
    return asyncio.run(
        run_requests(
            seeds,
            options=CollectionOptions.model_validate(options),
            source_factory=lambda _source: scraper,
            link_extractor_factory=lambda _source: extractor,
            sleep=sleep or RecordingSleep(),
        )
    )


def search(query: str, **arguments: object) -> ScrapeRequest:
    return ScrapeRequest.model_validate({"source": "pubmed", "query": query, **arguments})


def http_error(code: int, retry_after: str | None = None) -> HTTPError:
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return HTTPError("https://eutils.ncbi.nlm.nih.gov", code, "error", headers, None)


def test_identical_seeds_are_scraped_once_and_provenance_is_merged() -> None:
    scraper = FakeScraper(searches={"a": ["1"], "b": ["1"]})

    result = collect(
        [
            search("a", topics=["prostate_cancer"]),
            search("a", topics=["prostate_cancer"]),
            search("b"),
        ],
        scraper,
        max_depth=0,
    )

    assert [request.query for request in scraper.calls] == ["a", "b"]
    assert result.ok
    [document] = result.documents
    assert document.found_by == [
        QueryProvenance(topic="prostate_cancer", query="a"),
        QueryProvenance(query="b"),
    ]
    assert result.stats.seed_requests == 2


def test_a_second_run_in_the_same_process_scrapes_the_same_seed_again() -> None:
    scraper = FakeScraper(searches={"same seed": ["1"]})

    first = collect([search("same seed")], scraper, max_depth=0)
    second = collect([search("same seed")], scraper, max_depth=0)

    assert len(scraper.calls) == 2
    assert [document.id for document in first.documents] == ["pubmed:1"]
    assert [document.id for document in second.documents] == ["pubmed:1"]


def test_transient_errors_are_retried_with_exponential_backoff() -> None:
    errors: list[Exception] = [ConnectionError("down"), TimeoutError("slow"), http_error(503)]
    scraper = FakeScraper(searches={"q": ["1"]}, errors={"q": errors})
    sleep = RecordingSleep()

    result = collect([search("q")], scraper, sleep=sleep, max_depth=0)

    assert len(scraper.calls) == 4
    assert sleep.delays == [2.0, 4.0, 8.0]
    assert result.ok
    assert [document.id for document in result.documents] == ["pubmed:1"]


def test_rate_limits_are_retried_and_retry_after_wins() -> None:
    scraper = FakeScraper(
        searches={"q": ["1"]}, errors={"q": [http_error(429, retry_after="7"), http_error(429)]}
    )
    sleep = RecordingSleep()

    result = collect([search("q")], scraper, sleep=sleep, max_depth=0)

    assert sleep.delays == [7.0, 4.0]
    assert result.ok


def test_backoff_is_capped() -> None:
    scraper = FakeScraper(searches={"q": ["1"]}, errors={"q": [http_error(429, "3600")]})
    sleep = RecordingSleep()

    collect([search("q")], scraper, sleep=sleep, max_depth=0, retry_max_delay=30)

    assert sleep.delays == [30.0]


def test_a_timed_out_request_is_not_retried_and_never_overlaps_the_next() -> None:
    scraper = SlowScraper({"slow": 0.6}, searches={"slow": ["1"], "fast": ["2"]})

    result = collect(
        [search("slow"), search("fast")],
        scraper,
        max_depth=0,
        handler_timeout=0.2,
        item_timeout=0,
    )

    assert [request.query for request in scraper.calls] == ["slow", "fast"]
    assert scraper.overlaps == 0
    assert [document.id for document in result.documents] == ["pubmed:2"]
    [failure] = result.failures
    assert (failure.detail, failure.retries, failure.retryable) == ("slow", 0, False)
    assert failure.error.startswith("TimeoutError")


def test_the_time_limit_grows_with_the_largest_request() -> None:
    scraper = SlowScraper({"q": 0.4}, searches={"q": ["1"]})

    result = collect(
        [search("q", max_results=10)],
        scraper,
        max_depth=0,
        handler_timeout=0.2,
        item_timeout=0.05,
    )

    assert result.ok


def test_a_failed_request_keeps_the_documents_of_the_others() -> None:
    scraper = FakeScraper(
        searches={"good": ["1"]},
        errors={"bad": [ConnectionError("source unavailable") for _ in range(4)]},
    )

    result = collect([search("good"), search("bad")], scraper, max_depth=0)

    assert [document.id for document in result.documents] == ["pubmed:1"]
    [failure] = result.failures
    assert (failure.kind, failure.detail, failure.retries, failure.retryable) == (
        "search",
        "bad",
        3,
        True,
    )
    assert result.stats.finished_requests == 1
    assert result.stats.failed_requests == 1
    assert not result.ok


def test_permanent_errors_are_not_retried() -> None:
    scraper = FakeScraper(errors={"q": [ValueError("channel not found"), ValueError("again")]})
    sleep = RecordingSleep()

    result = collect([search("q")], scraper, sleep=sleep, max_depth=0)

    assert len(scraper.calls) == 1
    assert sleep.delays == []
    [failure] = result.failures
    assert failure.retryable is False
    assert failure.error == "ValueError: channel not found"


def test_references_are_looked_up_once_and_off_topic_papers_are_dropped() -> None:
    scraper = FakeScraper(
        searches={"prostate cancer": ["1", "2"]},
        records={"3": paper("3"), "4": paper("4", "Heart failure in adults")},
    )
    extractor = FakeExtractor({"1": ["3", "4"], "2": ["3", "1"]})

    result = collect(
        [search("prostate cancer")], scraper, extractor, topic_terms=["prostate cancer"]
    )

    assert extractor.calls == [["1", "2"]]
    assert scraper.lookups == [["3", "4"]]
    documents = {document.id: document for document in result.documents}
    assert set(documents) == {"pubmed:1", "pubmed:2", "pubmed:3"}
    assert documents["pubmed:3"].found_by == [
        CitationProvenance(cited_by="pubmed:1"),
        CitationProvenance(cited_by="pubmed:2"),
    ]
    assert documents["pubmed:1"].found_by == [
        QueryProvenance(query="prostate cancer"),
        CitationProvenance(cited_by="pubmed:2"),
    ]
    assert result.stats.references_found == 4
    assert result.stats.lookups_queued == 2
    assert result.stats.skipped_duplicate == 2
    assert result.stats.skipped_off_topic == 1


def test_cited_papers_are_looked_up_in_batches() -> None:
    cited = [str(pmid) for pmid in range(100, 550)]
    scraper = FakeScraper(searches={"q": ["1"]}, records={pmid: paper(pmid) for pmid in cited})

    result = collect([search("q")], scraper, FakeExtractor({"1": cited}))

    assert [len(batch) for batch in scraper.lookups] == [200, 200, 50]
    assert result.stats.documents == 451


def test_known_documents_are_not_fetched_but_keep_their_citation() -> None:
    scraper = FakeScraper(searches={"q": ["1"]}, records={"3": paper("3")})

    result = collect(
        [search("q")],
        scraper,
        FakeExtractor({"1": ["3", "9"]}),
        known_ids=frozenset({"pubmed:9"}),
    )

    assert scraper.lookups == [["3"]]
    assert result.citations == {"pubmed:3": ["pubmed:1"], "pubmed:9": ["pubmed:1"]}
    assert result.stats.skipped_known == 1


def test_depth_zero_collects_the_seeds_only() -> None:
    scraper = FakeScraper(searches={"q": ["1"]})
    created: list[SourceName] = []

    def no_extractor(source: SourceName) -> LinkExtractor | None:
        created.append(source)
        return None

    result = asyncio.run(
        run_requests(
            [search("q")],
            options=CollectionOptions(max_depth=0),
            source_factory=lambda _source: scraper,
            link_extractor_factory=no_extractor,
        )
    )

    assert created == []
    assert [document.id for document in result.documents] == ["pubmed:1"]


@pytest.mark.parametrize(("max_depth", "expected"), [(1, {"1", "3"}), (2, {"1", "3", "5"})])
def test_references_are_followed_up_to_the_maximum_depth(
    max_depth: int, expected: set[str]
) -> None:
    scraper = FakeScraper(searches={"q": ["1"]}, records={"3": paper("3"), "5": paper("5")})
    extractor = FakeExtractor({"1": ["3"], "3": ["5"]})

    result = collect([search("q")], scraper, extractor, max_depth=max_depth)

    assert {document.source_id for document in result.documents} == expected
    assert len(extractor.calls) == max_depth


def test_a_failing_link_extractor_keeps_the_seed_documents_without_scraping_again() -> None:
    scraper = FakeScraper(searches={"q": ["1", "2"]})
    extractor = FakeExtractor({}, errors=[ValueError("bad response")])

    result = collect([search("q")], scraper, extractor)

    assert len(scraper.calls) == 1
    assert {document.id for document in result.documents} == {"pubmed:1", "pubmed:2"}
    [failure] = result.failures
    assert (failure.kind, failure.detail) == ("references", "2 ID(s): 1, 2")


def test_link_extractor_errors_are_retried_like_source_errors() -> None:
    scraper = FakeScraper(searches={"q": ["1"]}, records={"3": paper("3")})
    extractor = FakeExtractor({"1": ["3"]}, errors=[http_error(429)])

    result = collect([search("q")], scraper, extractor)

    assert result.ok
    assert len(extractor.calls) == 2
    assert {document.id for document in result.documents} == {"pubmed:1", "pubmed:3"}


def test_max_requests_reports_what_was_left_in_the_queue() -> None:
    scraper = FakeScraper(searches={"a": ["1"], "b": ["2"], "c": ["3"]})

    result = collect([search("a"), search("b"), search("c")], scraper, max_depth=0, max_requests=1)

    assert len(scraper.calls) == 1
    assert result.stats.unprocessed_requests == 2


def test_missing_credentials_fail_before_the_crawl() -> None:
    def missing_key(_source: SourceName) -> BaseScraper:
        raise ValueError("YOUTUBE_API_KEY is required")

    with pytest.raises(CollectionSetupError, match="YOUTUBE_API_KEY"):
        asyncio.run(run_requests([search("q")], source_factory=missing_key))
