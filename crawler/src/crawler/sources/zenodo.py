import json
import re
import time
import urllib.request
from collections.abc import Callable, Mapping
from datetime import date
from typing import Any
from urllib.parse import quote, urlencode

from pydantic import JsonValue

from crawler.http import Fetch, Pacer, urlopen_bytes
from crawler.models import (
    Author,
    ContentType,
    FullTextLocator,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
    source_document_id,
)
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT, BaseScraper
from crawler.sources.fields import bare_orcid, language_tag, normalize_doi, plain_text

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


def zenodo_licence(rights_id: object) -> str | None:
    """`cc-by-4.0` → SPDX `CC-BY-4.0`; other SPDX IDs stay as Zenodo sends them."""
    value = str(rights_id or "").strip()
    if not value:
        return None
    return value.upper() if value.lower().startswith("cc") else value


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
            documents.extend(
                document
                for record in records
                if (document := self.parse_record(record)) is not None
            )
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
            # Changed since: new uploads and new versions, including copies of older papers.
            rendered += f" AND updated:[{since.isoformat()} TO *]"
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
    def parse_record(cls, record: Mapping[str, Any]) -> SourceDocument | None:
        """None for resource types we do not collect."""
        metadata = record.get("metadata") or {}
        resource_type = str((metadata.get("resource_type") or {}).get("id") or "")
        content_type = CONTENT_TYPES.get(resource_type)
        if content_type is None:
            return None
        parent = record.get("parent") or {}
        record_id = str(record["id"])
        concept_id = str(parent.get("id") or record_id)
        doi = normalize_doi(((record.get("pids") or {}).get("doi") or {}).get("identifier"))
        concept_doi = normalize_doi(((parent.get("pids") or {}).get("doi") or {}).get("identifier"))
        journal = ((record.get("custom_fields") or {}).get("journal:journal") or {}).get("title")
        rights = metadata.get("rights") or []
        languages = metadata.get("languages") or []
        return SourceDocument(
            id=source_document_id(cls.source, concept_id),
            source=cls.source,
            content_type=content_type,
            source_id=concept_id,
            version=record_id,
            title=str(metadata.get("title") or "").strip(),
            url=str((record.get("links") or {}).get("self_html") or "")
            or f"https://zenodo.org/records/{record_id}",
            authors=cls._authors(metadata),
            description=plain_text(metadata.get("description")),
            language=language_tag(languages[0].get("id")) if languages else None,
            published_at=cls._publication_date(metadata.get("publication_date")),
            source_updated_at=record.get("updated"),
            doi=doi,
            journal=str(journal).strip() or None if journal else None,
            subjects=cls._subjects(metadata),
            licence=zenodo_licence(rights[0].get("id")) if rights else None,
            full_text=cls._files(record, record_id),
            external_ids={"concept_doi": concept_doi} if concept_doi else {},
            extra=cls._extra(record),
        )

    @staticmethod
    def _authors(metadata: Mapping[str, Any]) -> list[Author]:
        authors: list[Author] = []
        for creator in metadata.get("creators") or []:
            person = creator.get("person_or_org") or {}
            name = str(person.get("name") or "").strip()
            if not name:
                continue
            orcid = next(
                (
                    bare_orcid(identifier.get("identifier"))
                    for identifier in person.get("identifiers") or []
                    if str(identifier.get("scheme") or "").lower() == "orcid"
                ),
                None,
            )
            affiliations = creator.get("affiliations") or []
            affiliation = str(affiliations[0].get("name") or "").strip() if affiliations else ""
            authors.append(Author(name=name, orcid=orcid, affiliation=affiliation or None))
        return authors

    @staticmethod
    def _subjects(metadata: Mapping[str, Any]) -> list[Subject]:
        """Free keywords, or controlled terms such as `{id: mesh:D016875, scheme: MeSH}`."""
        subjects: dict[tuple[str, str | None, str], Subject] = {}
        for subject in metadata.get("subjects") or []:
            label = str(subject.get("subject") or "").strip()
            if not label:
                continue
            raw_id = str(subject.get("id") or "").strip() or None
            prefix, _, local_id = (raw_id or "").partition(":")
            scheme = str(subject.get("scheme") or (prefix if local_id else "keyword")).lower()
            subject_id = local_id or raw_id
            subjects.setdefault(
                (scheme, subject_id, label), Subject(scheme=scheme, id=subject_id, label=label)
            )
        return list(subjects.values())

    @staticmethod
    def _files(record: Mapping[str, Any], record_id: str) -> list[FullTextLocator]:
        """Files of open records, the preview file first; restricted or embargoed: none."""
        files = record.get("files") or {}
        if (record.get("access") or {}).get("status") != "open" or not files.get("enabled"):
            return []
        entries = files.get("entries") or {}
        values = list(entries.values()) if isinstance(entries, Mapping) else list(entries)
        preview = files.get("default_preview")
        values.sort(key=lambda entry: entry.get("key") != preview)
        return [
            FullTextLocator(
                kind="file",
                url=f"{SEARCH_URL}/{record_id}/files/{quote(str(entry['key']), safe='')}/content",
                media_type=entry.get("mimetype"),
                size=entry.get("size"),
                checksum=entry.get("checksum"),
            )
            for entry in values
            if entry.get("key")
        ]

    @staticmethod
    def _extra(record: Mapping[str, Any]) -> dict[str, JsonValue]:
        access = record.get("access") or {}
        extra: dict[str, JsonValue] = {}
        if access.get("status"):
            extra["access_status"] = str(access["status"])
        embargo = access.get("embargo") or {}
        if embargo.get("active") and embargo.get("until"):
            extra["embargo_until"] = str(embargo["until"])
        communities = [
            str(entry.get("slug"))
            for entry in ((record.get("parent") or {}).get("communities") or {}).get("entries")
            or []
            if entry.get("slug")
        ]
        if communities:
            extra["communities"] = list(communities)
        related: list[JsonValue] = [
            {
                "identifier": str(item.get("identifier")),
                "scheme": str(item.get("scheme") or ""),
                "relation": str((item.get("relation_type") or {}).get("id") or ""),
            }
            for item in (record.get("metadata") or {}).get("related_identifiers") or []
            if item.get("identifier")
        ]
        if related:
            extra["related_identifiers"] = related
        return extra

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
