import os
import re
from collections.abc import Mapping, Sequence
from typing import Any

from Bio import Entrez

from scraper.models import (
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)
from scraper.sources.base import BaseScraper


class PubMedScraper(BaseScraper):
    """PubMed discovery and XML metadata parsing adapted from the legacy scraper."""

    source = SourceName.PUBMED

    def __init__(
        self,
        email: str | None = None,
        api_key: str | None = None,
        *,
        entrez: Any = Entrez,
    ) -> None:
        self._email = email.strip() if email else None
        self._api_key = api_key
        self._entrez = entrez

    @classmethod
    def from_env(cls) -> "PubMedScraper":
        email = os.getenv("NCBI_ENTREZ_EMAIL") or os.getenv("NCBI_EMAIL") or ""
        return cls(email=email or None, api_key=os.getenv("NCBI_API_KEY"))

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source or not request.query:
            raise ValueError("PubMed requires a PubMed request with a query")

        self._entrez.email = self._email
        self._entrez.tool = "patient-journey-matcher"
        self._entrez.api_key = self._api_key or None
        search_arguments: dict[str, Any] = {
            "db": "pubmed",
            "sort": "pub date" if request.since else "relevance",
            "retmax": request.max_results,
            "retmode": "xml",
            "term": request.query,
        }
        if request.since:
            search_arguments.update(
                mindate=request.since.strftime("%Y/%m/%d"),
                maxdate="3000/12/31",
                datetype="pdat",
            )

        search_handle = self._entrez.esearch(**search_arguments)
        try:
            identifiers = [str(value) for value in self._entrez.read(search_handle)["IdList"]]
        finally:
            search_handle.close()
        if not identifiers:
            return []

        fetch_handle = self._entrez.efetch(db="pubmed", id=",".join(identifiers), retmode="xml")
        try:
            response = self._entrez.read(fetch_handle)
        finally:
            fetch_handle.close()

        articles = response.get("PubmedArticle", [])
        query_keywords = [request.query]
        return [self.parse_article(article, query_keywords) for article in articles]

    @classmethod
    def parse_article(
        cls, article_record: Mapping[str, Any], query_keywords: list[str]
    ) -> SourceDocument:
        citation = article_record["MedlineCitation"]
        article = citation["Article"]
        source_id = str(citation["PMID"])
        title = str(article.get("ArticleTitle", "")).strip().removesuffix(".")
        doi = cls._doi(article_record)
        abstract = cls._abstract(article)
        authors = cls._authors(article)
        published_at = cls._publication_date(article)
        journal = str(article.get("Journal", {}).get("Title", "")).strip() or None
        keywords = cls._keywords(citation)

        return SourceDocument(
            id=source_document_id(cls.source, source_id),
            source=cls.source,
            source_type=SourceType.PAPER,
            source_id=source_id,
            title=title,
            url=f"https://pubmed.ncbi.nlm.nih.gov/{source_id}/",
            authors=authors,
            abstract=abstract or None,
            published_at=published_at,
            doi=doi,
            journal=journal,
            keywords=keywords,
            query_keywords=query_keywords,
        )

    @staticmethod
    def _doi(record: Mapping[str, Any]) -> str | None:
        pubmed_data = record.get("PubmedData", {})
        for value in pubmed_data.get("ArticleIdList", []):
            attributes = getattr(value, "attributes", {})
            if attributes.get("IdType") == "doi":
                return str(value).strip() or None
        return None

    @staticmethod
    def _abstract(article: Mapping[str, Any]) -> str:
        sections = article.get("Abstract", {}).get("AbstractText", [])
        rendered: list[str] = []
        for section in sections:
            text = str(section).strip()
            if not text:
                continue
            label = str(getattr(section, "attributes", {}).get("Label", "")).strip()
            rendered.append(f"{label}: {text}" if label else text)
        return "\n".join(rendered)

    @staticmethod
    def _authors(article: Mapping[str, Any]) -> list[str]:
        authors: list[str] = []
        for author in article.get("AuthorList", []):
            collective = str(author.get("CollectiveName", "")).strip()
            if collective:
                authors.append(collective)
                continue
            given = str(author.get("ForeName") or author.get("Initials") or "").strip()
            family = str(author.get("LastName", "")).strip()
            name = " ".join(part for part in (given, family) if part)
            if name:
                authors.append(name)
        return authors

    @staticmethod
    def _publication_date(article: Mapping[str, Any]) -> str | None:
        article_dates = article.get("ArticleDate", [])
        date_parts: Mapping[str, Any]
        if article_dates:
            date_parts = article_dates[0]
        else:
            date_parts = article.get("Journal", {}).get("JournalIssue", {}).get("PubDate", {})

        year = str(date_parts.get("Year", "")).strip()
        month = str(date_parts.get("Month", "")).strip()
        day = str(date_parts.get("Day", "")).strip()
        if not year:
            medline_date = str(date_parts.get("MedlineDate", ""))
            match = re.search(r"\b(19|20)\d{2}\b", medline_date)
            return match.group(0) if match else None

        numeric_month = PubMedScraper._month_number(month)
        if numeric_month and day.isdigit():
            return f"{year}-{numeric_month:02d}-{int(day):02d}"
        if numeric_month:
            return f"{year}-{numeric_month:02d}"
        return year

    @staticmethod
    def _month_number(value: str) -> int | None:
        if value.isdigit() and 1 <= int(value) <= 12:
            return int(value)
        months = {
            "jan": 1,
            "feb": 2,
            "mar": 3,
            "apr": 4,
            "may": 5,
            "jun": 6,
            "jul": 7,
            "aug": 8,
            "sep": 9,
            "oct": 10,
            "nov": 11,
            "dec": 12,
        }
        return months.get(value[:3].lower())

    @staticmethod
    def _keywords(citation: Mapping[str, Any]) -> list[str]:
        keywords: set[str] = set()
        for heading in citation.get("MeshHeadingList", []):
            descriptor = str(heading.get("DescriptorName", "")).strip()
            if descriptor:
                keywords.add(descriptor)
            keywords.update(
                str(value).strip()
                for value in heading.get("QualifierName", [])
                if str(value).strip()
            )
        keyword_lists: Sequence[Sequence[Any]] = citation.get("KeywordList", [])
        for keyword_list in keyword_lists:
            keywords.update(str(value).strip() for value in keyword_list if str(value).strip())
        return sorted(keywords)
