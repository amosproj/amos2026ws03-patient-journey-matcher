"""Local-provider workflow driver; stdout is one bounded JSON summary."""

import asyncio
import io
import json
import logging
import os
import sys
import urllib.request
from datetime import UTC, datetime
from typing import Any, cast
from urllib.parse import urlsplit

from Bio import Entrez
from Bio.Entrez import Parser

from crawler.links.pubmed import PubMedLinkExtractor
from crawler.models import PodcastFeed, ScrapeRequest, SourceName
from crawler.runner import CollectionOptions, run_requests
from crawler.sources.pmc import PmcClient
from crawler.sources.podcast import PodcastScraper
from crawler.sources.pubmed import NcbiThrottle, PubMedScraper
from crawler.sources.zenodo import ZenodoScraper
from crawler.store import RunInfo, save_result


def local_fetch(request: urllib.request.Request, timeout: float) -> bytes:
    url = urlsplit(request.full_url)
    base = urlsplit(os.environ["FIXTURE_BASE_URL"])
    if not (
        (url.hostname == "zenodo.org" and url.path == "/api/records")
        or url.hostname == "pmc-oa-opendata.s3.amazonaws.com"
        or url.netloc == base.netloc
    ):
        raise ValueError("Unexpected provider destination")
    target = os.environ["FIXTURE_BASE_URL"] + url.path + "?" + url.query
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(
        urllib.request.Request(target, headers=dict(request.header_items())), timeout=timeout
    ) as response:
        return cast(bytes, response.read())


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise ValueError("Unexpected provider redirect")


class LocalEntrez:
    @staticmethod
    def _handle(route: str) -> io.BytesIO:
        request = urllib.request.Request(os.environ["FIXTURE_BASE_URL"] + route)
        return io.BytesIO(local_fetch(request, 5))

    def esearch(self, **kwargs: Any) -> io.BytesIO:
        return self._handle("/pubmed-search.xml")

    def efetch(self, **kwargs: Any) -> io.BytesIO:
        return self._handle("/pubmed-" + str(kwargs["id"]) + ".xml")

    def elink(self, **kwargs: Any) -> io.BytesIO:
        return self._handle("/pubmed-references.xml")

    @staticmethod
    def read(handle: io.BytesIO) -> Any:
        return Entrez.read(handle)  # type: ignore[no-untyped-call]


def reject_external_dtd(*args: Any, **kwargs: Any) -> Any:
    raise ValueError("External DTD lookup forbidden; use Biopython packaged DTDs")


# Entrez still parses real XML and resolves its packaged DTDs, but cannot download one.
Parser.urlopen = reject_external_dtd  # type: ignore[attr-defined]


async def main() -> None:
    scenario = sys.argv[1]
    source = SourceName.ZENODO
    scraper: Any = ZenodoScraper(fetch=local_fetch, min_interval=0)
    extractor: Any = None
    request = ScrapeRequest(source=source, query="therapy", max_results=20)
    depth = 0
    if scenario == "podcast":
        source = SourceName.PODCAST
        scraper = PodcastScraper(fetch=local_fetch, min_interval=0)
        request = ScrapeRequest(
            source=source,
            feed=PodcastFeed(
                key="clinical",
                name="Clinical evidence",
                publisher="Synthetic",
                audience="clinicians",
                language="en",
                url=os.environ["FIXTURE_BASE_URL"] + "/podcast.xml",
            ),
        )
    elif scenario == "pubmed":
        source = SourceName.PUBMED
        adapter = LocalEntrez()
        throttle = NcbiThrottle(sleep=lambda _: None)
        scraper = PubMedScraper(
            entrez=adapter, pmc=PmcClient(fetch=local_fetch, min_interval=0), throttle=throttle
        )
        extractor = PubMedLinkExtractor(entrez=adapter, throttle=throttle)
        request = ScrapeRequest(source=source, query="therapy", max_results=20)
        depth = 1
    elif scenario not in {"zenodo", "zenodo-partial"}:
        raise ValueError("Unknown integration scenario")
    started = datetime.now(UTC)
    result = await run_requests(
        [request, ScrapeRequest(source=source, query="broken", max_results=20)]
        if scenario == "zenodo-partial"
        else [request],
        options=CollectionOptions(
            max_depth=depth, max_retries=2, retry_base_delay=0, retry_max_delay=0
        ),
        source_factory=lambda _: scraper,
        link_extractor_factory=lambda _: extractor,
    )
    report = await save_result(
        os.environ["DATABASE_URL"],
        result,
        RunInfo(
            source=source,
            topics=["therapy"],
            arguments=[],
            started_at=started,
            finished_at=datetime.now(UTC),
        ),
    )
    print(
        json.dumps(
            {
                "ids": [d.id for d in result.documents],
                "failures": len(result.failures),
                "stats": result.stats.model_dump(mode="json"),
                "store": report.model_dump(mode="json"),
            }
        )
    )


if __name__ == "__main__":
    logging.basicConfig(stream=sys.stderr)
    asyncio.run(main())
