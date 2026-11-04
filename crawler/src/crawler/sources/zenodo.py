import html
import json
import re
import time
import urllib.request
from collections.abc import Callable, Mapping
from datetime import date
from typing import Any
from urllib.parse import urlencode

from crawler.http import Fetch, Pacer, urlopen_bytes
from crawler.models import (
    ContentType,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT, BaseScraper

SEARCH_URL = "https://zenodo.org/api/records"
PAGE_SIZE = 25
"""Largest page Zenodo serves without a token."""
RESULT_WINDOW = 10_000
"""Zenodo answers HTTP 400 when page × size goes beyond this."""

CONTENT_TYPES: dict[str, ContentType] = {
    "publication-article": "journal_article",
    "publication-preprint": "preprint",
    "publication-conferencepaper": "conference_paper",
    "publication-report": "report",
    "poster": "poster",
    "presentation": "presentation",
    "video": "video",
}
"""Zenodo resource types we collect; datasets, software and the like are skipped."""

_DATE = re.compile(r"[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?")
_LINE_BREAK = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6])\b[^>]*>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")


class ZenodoScraper(BaseScraper):
    """Zenodo search through the InvenioRDM records API, metadata only.

    Zenodo allows 30 searches a minute and 25 results a page without a token, and it
    blocks clients without an identifiable User-Agent. It has no reference lists.
    """

    source = SourceName.ZENODO

    def __init__(
        self,
        *,
        fetch: Fetch = urlopen_bytes,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_interval: float = 2.0,
        timeout: float = NETWORK_TIMEOUT_SECONDS,
    ) -> None:
        self._fetch = fetch
        self._pacer = Pacer(min_interval, sleep=sleep, clock=clock)
        self._timeout = timeout

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source:
            raise ValueError("Zenodo scraper received a request for another source")
        if not request.query:
            raise ValueError("Zenodo search requires a query")
        query = self.build_query(request.query, request.query_mode, request.since)
        sort = "newest" if request.since else "bestmatch"
        size = min(PAGE_SIZE, request.max_results)
        documents: list[SourceDocument] = []
        page = 1
        while len(documents) < request.max_results and page * size <= RESULT_WINDOW:
            records = self._search(query, sort, size, page)
            documents.extend(self.parse_record(record) for record in records)
            if len(records) < size:
                break
            page += 1
        return documents[: request.max_results]

    @staticmethod
    def build_query(query: str, mode: str, since: date | None) -> str:
        """Build an Elasticsearch query string; Zenodo's default operator is OR."""
        if mode == "raw":
            rendered = query
        else:
            terms = [term.replace('"', "") for term in query.split()]
            operator = " AND " if mode == "and" else " OR "
            rendered = operator.join(f'"{term}"' for term in terms if term)
        types = " OR ".join(CONTENT_TYPES)
        rendered = f"({rendered}) AND metadata.resource_type.id:({types})"
        if since:
            rendered += f" AND metadata.publication_date:[{since.isoformat()} TO *]"
        return rendered

    def _search(self, query: str, sort: str, size: int, page: int) -> list[dict[str, Any]]:
        parameters = urlencode({"q": query, "sort": sort, "size": size, "page": page})
        headers = {"User-Agent": USER_AGENT, "Accept": "application/vnd.inveniordm.v1+json"}
        request = urllib.request.Request(f"{SEARCH_URL}?{parameters}", headers=headers)
        with self._pacer:
            body = self._fetch(request, self._timeout)
        hits = (json.loads(body).get("hits") or {}).get("hits") or []
        return [hit for hit in hits if isinstance(hit, dict) and hit.get("id")]

    @classmethod
    def parse_record(cls, record: Mapping[str, Any]) -> SourceDocument:
        metadata = record.get("metadata") or {}
        record_id = str(record["id"])
        concept_id = str((record.get("parent") or {}).get("id") or record_id)
        resource_type = str((metadata.get("resource_type") or {}).get("id") or "")
        doi = ((record.get("pids") or {}).get("doi") or {}).get("identifier")
        journal = ((record.get("custom_fields") or {}).get("journal:journal") or {}).get("title")
        return SourceDocument(
            id=source_document_id(cls.source, concept_id),
            source=cls.source,
            source_type=SourceType.VIDEO if resource_type == "video" else SourceType.PAPER,
            content_type=CONTENT_TYPES.get(resource_type),
            source_id=concept_id,
            version=record_id,
            title=str(metadata.get("title") or "").strip(),
            url=str((record.get("links") or {}).get("self_html") or "")
            or f"https://zenodo.org/records/{record_id}",
            authors=cls._authors(metadata),
            description=cls._plain_text(metadata.get("description")),
            published_at=cls._publication_date(metadata.get("publication_date")),
            doi=str(doi).strip().lower() or None if doi else None,
            journal=str(journal).strip() or None if journal else None,
            keywords=cls._subjects(metadata),
        )

    @staticmethod
    def _authors(metadata: Mapping[str, Any]) -> list[str]:
        names = (
            str((creator.get("person_or_org") or {}).get("name") or "").strip()
            for creator in metadata.get("creators") or []
        )
        return [name for name in names if name]

    @staticmethod
    def _subjects(metadata: Mapping[str, Any]) -> list[str]:
        subjects = (
            str(subject.get("subject") or "").strip() for subject in metadata.get("subjects") or []
        )
        return list(dict.fromkeys(subject for subject in subjects if subject))

    @staticmethod
    def _plain_text(value: Any) -> str | None:
        """Turn the HTML description into plain text, one paragraph per line."""
        if not value:
            return None
        text = html.unescape(_TAG.sub(" ", _LINE_BREAK.sub("\n", str(value))))
        lines = (" ".join(line.split()) for line in text.splitlines())
        return "\n".join(line for line in lines if line) or None

    @staticmethod
    def _publication_date(value: Any) -> str | None:
        """Keep an EDTF date we can sort by: `2026`, `2026-09`, `2026-09-13`.

        Intervals (`2020/2021`) keep their start; anything else is dropped rather than
        failing the whole search.
        """
        if not value:
            return None
        start = str(value).split("/")[0].strip().rstrip("?~%")
        if not _DATE.fullmatch(start):
            return None
        try:
            SourceDocument._parse_publication_date(start)
        except ValueError:
            return None
        return start
