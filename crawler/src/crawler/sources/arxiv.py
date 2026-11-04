import re
from collections.abc import Sequence
from typing import Any

import arxiv
import requests

from crawler.models import (
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, BaseScraper

LOOKUP_BATCH_SIZE = 100
"""IDs per `id_list` query; one page of the arXiv API."""

_NEW_STYLE_ID = re.compile(r"[0-9]{4}\.[0-9]{4,5}")
_OLD_STYLE_ID = re.compile(r"[a-z]+(?:-[a-z]+)*(?:\.[A-Z]{2})?/[0-9]{7}")
_VERSION_SUFFIX = re.compile(r"(?P<base>.+?)v(?P<version>[0-9]+)")


def split_version(arxiv_id: str) -> tuple[str, str | None]:
    """Split `2610.12345v2` into the stable ID `2610.12345` and the version `2`."""
    value = arxiv_id.strip()
    match = _VERSION_SUFFIX.fullmatch(value)
    if match is None:
        return value, None
    return match["base"], match["version"]


def is_arxiv_id(value: str) -> bool:
    """Accept version-less new-style (`2610.12345`) and old-style (`hep-th/9901001`) IDs."""
    return bool(_NEW_STYLE_ID.fullmatch(value) or _OLD_STYLE_ID.fullmatch(value))


class _TimeoutSession(requests.Session):
    """The arxiv client sends requests without a timeout, which can block a run forever."""

    def __init__(self, timeout: float) -> None:
        super().__init__()
        self._timeout = timeout

    def request(self, *args: Any, **kwargs: Any) -> requests.Response:
        kwargs.setdefault("timeout", self._timeout)
        return super().request(*args, **kwargs)


def default_client(timeout: float = NETWORK_TIMEOUT_SECONDS) -> arxiv.Client:
    """One shared client keeps arXiv's three-second delay; Crawlee does the retries."""
    client = arxiv.Client(page_size=100, delay_seconds=3, num_retries=0)
    client._session = _TimeoutSession(timeout)
    return client


class ArxivScraper(BaseScraper):
    """arXiv search, lookup by ID, and parsing with one reusable rate-limited client."""

    source = SourceName.ARXIV

    def __init__(self, *, client: Any | None = None) -> None:
        self._client = client or default_client()

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source:
            raise ValueError("arXiv scraper received a request for another source")
        if request.is_lookup:
            return self._lookup(request.ids)
        if not request.query:
            raise ValueError("arXiv search requires a query")

        query = self.build_query(request.query, request.query_mode, request.since)
        search = arxiv.Search(
            query=query,
            max_results=request.max_results,
            sort_by=arxiv.SortCriterion.SubmittedDate,
        )
        return [self.parse_result(result) for result in self._client.results(search)]

    def _lookup(self, identifiers: Sequence[str]) -> list[SourceDocument]:
        documents: list[SourceDocument] = []
        for offset in range(0, len(identifiers), LOOKUP_BATCH_SIZE):
            batch = list(identifiers[offset : offset + LOOKUP_BATCH_SIZE])
            search = arxiv.Search(id_list=batch, max_results=len(batch))
            try:
                for result in self._client.results(search):
                    documents.append(self.parse_result(result))
            except arxiv.UnexpectedEmptyPageError:
                # arXiv leaves out unknown IDs, so the client asks for one more page and
                # finds it empty. The results before that page are complete.
                continue
        return documents

    @staticmethod
    def build_query(query: str, mode: str, since: Any | None) -> str:
        if mode == "raw":
            rendered = query
        else:
            terms = query.split()
            operator = " AND " if mode == "and" else " OR "
            rendered = operator.join(f'all:"{term}"' for term in terms)
        if since:
            compact_date = since.strftime("%Y%m%d")
            rendered = f"({rendered}) AND submittedDate:[{compact_date}0000 TO 300012312359]"
        return rendered

    @classmethod
    def parse_result(cls, result: Any) -> SourceDocument:
        source_id, version = split_version(str(result.get_short_id()))
        categories = sorted(set(result.categories or []))
        doi = str(result.doi).strip() if result.doi else None
        return SourceDocument(
            id=source_document_id(cls.source, source_id),
            source=cls.source,
            source_type=SourceType.PAPER,
            content_type="preprint",
            source_id=source_id,
            version=version,
            title=str(result.title).strip(),
            url=f"https://arxiv.org/abs/{source_id}",
            authors=[str(author.name) for author in result.authors],
            abstract=str(result.summary).strip() or None,
            published_at=result.published.isoformat() if result.published else None,
            doi=doi,
            journal=str(result.journal_ref).strip() if result.journal_ref else None,
            keywords=categories,
        )
