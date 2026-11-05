import os
import re
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from Bio import Entrez
from pydantic import JsonValue

from crawler.models import (
    Author,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
    source_document_id,
)
from crawler.sources.base import BaseScraper
from crawler.sources.fields import bare_orcid, language_tag, normalize_doi
from crawler.sources.pmc import PmcClient

EFETCH_BATCH_SIZE = 200
"""IDs per efetch call; NCBI asks for batches and Biopython switches to POST for long lists."""
MAX_SEARCH_RESULTS = 9_999
"""PubMed returns at most this many IDs per search."""

_PMID = re.compile(r"[1-9][0-9]{0,9}")
# Biopython keeps the formatting tags and MathML of mixed-content elements (title, abstract,
# keywords, affiliations) as raw tags, but leaves the text unescaped (`p<0.05`). So only
# these tags are removed, never everything between `<` and `>`.
_MARKUP_TAG = re.compile(
    r'</?(?:b|i|u|sup|sub|DispFormula|semantics|m[a-z]+)(?:\s+[\w:-]+="[^"]*")*\s*/?>'
)
_MATH_ANNOTATION = re.compile(r"<annotation(?:-xml)?\b.*?</annotation(?:-xml)?>", re.DOTALL)
_MONTHS = {
    name: number
    for number, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1
    )
}


def is_pmid(value: str) -> bool:
    return _PMID.fullmatch(value) is not None


def inline_text(value: object) -> str:
    """Plain text of a mixed-content element: `<sup>177</sup>Lu` → `177Lu`; `p<0.05` stays."""
    text = _MARKUP_TAG.sub("", _MATH_ANNOTATION.sub("", str(value or "")))
    return " ".join(text.split())


def ncbi_credentials_from_env() -> tuple[str | None, str | None]:
    email = os.getenv("NCBI_ENTREZ_EMAIL") or ""
    return email.strip() or None, os.getenv("NCBI_API_KEY") or None


def configure_entrez(entrez: Any, email: str | None, api_key: str | None) -> None:
    """Set the NCBI identification, which Biopython keeps in module-global state.

    The scraper and the link extractor share that state, so both call this before each
    request. `max_tries=1` leaves retries to Crawlee.
    """
    entrez.email = email
    entrez.tool = "patient-journey-matcher"
    entrez.api_key = api_key or None
    entrez.max_tries = 1


def _attributes(value: Any) -> Mapping[str, Any]:
    attributes = getattr(value, "attributes", None)
    return attributes if isinstance(attributes, Mapping) else {}


def _major(value: Any) -> bool | None:
    flag = _attributes(value).get("MajorTopicYN")
    return None if flag is None else flag == "Y"


class PubMedScraper(BaseScraper):
    """PubMed discovery and XML metadata parsing; PMC adds licence and full text."""

    source = SourceName.PUBMED

    def __init__(
        self,
        email: str | None = None,
        api_key: str | None = None,
        *,
        entrez: Any = Entrez,
        pmc: PmcClient | None = None,
    ) -> None:
        self._email = email.strip() if email else None
        self._api_key = api_key or None
        self._entrez = entrez
        self._pmc = pmc

    @classmethod
    def from_env(cls) -> "PubMedScraper":
        email, api_key = ncbi_credentials_from_env()
        return cls(email=email, api_key=api_key, pmc=PmcClient())

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source:
            raise ValueError("PubMed scraper received a request for another source")
        configure_entrez(self._entrez, self._email, self._api_key)
        identifiers = request.ids if request.is_lookup else self._search(request)
        documents = self._fetch(identifiers)
        if self._pmc is not None:
            documents = [self._pmc.enrich(document) for document in documents]
        return documents

    def _search(self, request: ScrapeRequest) -> list[str]:
        if not request.query:
            raise ValueError("PubMed search requires a query")
        search_arguments: dict[str, Any] = {
            "db": "pubmed",
            "sort": "pub date" if request.since else "relevance",
            "retmax": min(request.max_results, MAX_SEARCH_RESULTS),
            "retmode": "xml",
            "term": request.query,
        }
        if request.since:
            # Entry date: when the record reached PubMed, so late-indexed papers are not missed.
            search_arguments.update(
                mindate=request.since.strftime("%Y/%m/%d"),
                maxdate="3000/12/31",
                datetype="edat",
            )

        search_handle = self._entrez.esearch(**search_arguments)
        try:
            return [str(value) for value in self._entrez.read(search_handle)["IdList"]]
        finally:
            search_handle.close()

    def _fetch(self, identifiers: Sequence[str]) -> list[SourceDocument]:
        documents: list[SourceDocument] = []
        for offset in range(0, len(identifiers), EFETCH_BATCH_SIZE):
            batch = identifiers[offset : offset + EFETCH_BATCH_SIZE]
            fetch_handle = self._entrez.efetch(db="pubmed", id=",".join(batch), retmode="xml")
            try:
                response = self._entrez.read(fetch_handle)
            finally:
                fetch_handle.close()
            documents.extend(
                self.parse_article(article) for article in response.get("PubmedArticle", [])
            )
        return documents

    @classmethod
    def parse_article(cls, article_record: Mapping[str, Any]) -> SourceDocument:
        citation = article_record["MedlineCitation"]
        article = citation["Article"]
        pubmed_data = article_record.get("PubmedData", {})
        source_id = str(citation["PMID"])
        article_ids = cls._article_ids(pubmed_data)
        languages = article.get("Language", [])
        return SourceDocument(
            id=source_document_id(cls.source, source_id),
            source=cls.source,
            content_type="journal_article",
            source_id=source_id,
            version=_attributes(citation["PMID"]).get("Version"),
            title=inline_text(article.get("ArticleTitle")).removesuffix("."),
            url=f"https://pubmed.ncbi.nlm.nih.gov/{source_id}/",
            authors=cls._authors(article),
            abstract=cls._abstract(article) or None,
            language=language_tag(languages[0]) if languages else None,
            published_at=cls._publication_date(article),
            source_updated_at=cls._date_time(citation.get("DateRevised")),
            doi=normalize_doi(article_ids.get("doi")),
            journal=str(article.get("Journal", {}).get("Title", "")).strip() or None,
            publication_types=[
                str(value).strip()
                for value in article.get("PublicationTypeList", [])
                if str(value).strip()
            ],
            subjects=cls._subjects(citation),
            external_ids={
                name: article_ids[key]
                for key, name in (("pmc", "pmcid"), ("mid", "nihms"))
                if key in article_ids
            },
            extra=cls._extra(citation, article, pubmed_data),
        )

    @staticmethod
    def _article_ids(pubmed_data: Mapping[str, Any]) -> dict[str, str]:
        """`ArticleIdList` by `IdType`, e.g. doi, pmc, mid."""
        ids: dict[str, str] = {}
        for value in pubmed_data.get("ArticleIdList", []):
            id_type = _attributes(value).get("IdType")
            text = str(value).strip()
            if id_type and text and id_type not in ids:
                ids[str(id_type)] = text
        return ids

    @staticmethod
    def _abstract(article: Mapping[str, Any]) -> str:
        sections = article.get("Abstract", {}).get("AbstractText", [])
        rendered: list[str] = []
        for section in sections:
            text = inline_text(section)
            if not text:
                continue
            label = str(_attributes(section).get("Label", "")).strip()
            rendered.append(f"{label}: {text}" if label else text)
        return "\n".join(rendered)

    @staticmethod
    def _authors(article: Mapping[str, Any]) -> list[Author]:
        authors: list[Author] = []
        for author in article.get("AuthorList", []):
            name = inline_text(author.get("CollectiveName"))
            if not name:
                given = str(author.get("ForeName") or author.get("Initials") or "").strip()
                family = str(author.get("LastName", "")).strip()
                name = " ".join(part for part in (given, family) if part)
            if not name:
                continue
            orcid = next(
                (
                    bare_orcid(value)
                    for value in author.get("Identifier", [])
                    if _attributes(value).get("Source") == "ORCID"
                ),
                None,
            )
            affiliations = author.get("AffiliationInfo", [])
            affiliation = inline_text(affiliations[0].get("Affiliation")) if affiliations else ""
            authors.append(Author(name=name, orcid=orcid, affiliation=affiliation or None))
        return authors

    @staticmethod
    def _subjects(citation: Mapping[str, Any]) -> list[Subject]:
        subjects: list[Subject] = []
        for heading in citation.get("MeshHeadingList", []):
            descriptor = heading.get("DescriptorName")
            label = str(descriptor or "").strip()
            if not label:
                continue
            descriptor_id = _attributes(descriptor).get("UI")
            qualifiers = list(heading.get("QualifierName", []))
            # A heading is a major topic if the descriptor or one of its qualifiers is.
            flags = [_major(descriptor), *(_major(qualifier) for qualifier in qualifiers)]
            known = [flag for flag in flags if flag is not None]
            major = any(known) if known else None
            subjects.append(Subject(scheme="mesh", id=descriptor_id, label=label, major=major))
            for qualifier in qualifiers:
                qualifier_id = _attributes(qualifier).get("UI")
                subjects.append(
                    Subject(
                        scheme="mesh",
                        id=f"{descriptor_id}{qualifier_id}"
                        if descriptor_id and qualifier_id
                        else None,
                        label=f"{label}/{str(qualifier).strip()}",
                        major=_major(qualifier),
                    )
                )
        for chemical in citation.get("ChemicalList", []):
            substance = chemical.get("NameOfSubstance")
            if str(substance or "").strip():
                subjects.append(
                    Subject(
                        scheme="mesh",
                        id=_attributes(substance).get("UI"),
                        label=str(substance).strip(),
                    )
                )
        for keyword_list in citation.get("KeywordList", []):
            for keyword in keyword_list:
                label = inline_text(keyword)
                if label:
                    subjects.append(Subject(scheme="keyword", label=label, major=_major(keyword)))
        unique: dict[tuple[str, str | None, str], Subject] = {}
        for subject in subjects:
            unique.setdefault((subject.scheme, subject.id, subject.label), subject)
        return list(unique.values())

    @classmethod
    def _extra(
        cls, citation: Any, article: Mapping[str, Any], pubmed_data: Mapping[str, Any]
    ) -> dict[str, JsonValue]:
        extra: dict[str, JsonValue] = {}
        status = _attributes(citation).get("Status")
        if status:
            extra["status"] = str(status)
        for history_date in pubmed_data.get("History", []):
            status_name = _attributes(history_date).get("PubStatus")
            if status_name in {"entrez", "pmc-release"}:
                parsed = cls._date_time(history_date)
                if parsed:
                    key = "entrez_date" if status_name == "entrez" else "pmc_release_date"
                    extra[key] = parsed.date().isoformat()
        copyright_notice = str(article.get("Abstract", {}).get("CopyrightInformation", "")).strip()
        if copyright_notice:
            extra["copyright"] = copyright_notice
        return extra

    @staticmethod
    def _date_time(parts: Any) -> datetime | None:
        if not isinstance(parts, Mapping):
            return None
        try:
            return datetime(
                int(parts["Year"]), int(parts.get("Month", 1)), int(parts.get("Day", 1)), tzinfo=UTC
            )
        except (KeyError, TypeError, ValueError):
            return None

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
        return _MONTHS.get(value[:3].lower())
