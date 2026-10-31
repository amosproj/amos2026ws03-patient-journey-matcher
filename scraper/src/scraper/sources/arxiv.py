from typing import Any

import arxiv

from scraper.models import (
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)
from scraper.sources.base import BaseScraper


class ArxivScraper(BaseScraper):
    """arXiv search and parsing with one reusable rate-limited client."""

    source = SourceName.ARXIV

    def __init__(self, *, client: Any | None = None) -> None:
        self._client = client or arxiv.Client(page_size=100, delay_seconds=3, num_retries=3)

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source or not request.query:
            raise ValueError("arXiv requires an arXiv request with a query")

        query = self.build_query(request.query, request.query_mode, request.since)
        search = arxiv.Search(
            query=query,
            max_results=request.max_results,
            sort_by=arxiv.SortCriterion.SubmittedDate,
        )
        query_keywords = [request.query]
        return [
            self.parse_result(result, query_keywords) for result in self._client.results(search)
        ]

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
    def parse_result(cls, result: Any, query_keywords: list[str]) -> SourceDocument:
        source_id = str(result.get_short_id())
        categories = sorted(set(result.categories or []))
        doi = str(result.doi).strip() if result.doi else None
        return SourceDocument(
            id=source_document_id(cls.source, source_id),
            source=cls.source,
            source_type=SourceType.PAPER,
            source_id=source_id,
            title=str(result.title).strip(),
            url=str(result.entry_id),
            authors=[str(author.name) for author in result.authors],
            abstract=str(result.summary).strip() or None,
            published_at=result.published.isoformat() if result.published else None,
            doi=doi,
            journal=str(result.journal_ref).strip() if result.journal_ref else None,
            keywords=categories,
            query_keywords=query_keywords,
        )
