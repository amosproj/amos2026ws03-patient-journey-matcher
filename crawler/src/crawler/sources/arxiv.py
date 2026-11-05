import logging
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable, Sequence
from datetime import datetime
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode

import arxiv
import requests
from pydantic import JsonValue

from crawler.http import Fetch, urlopen_bytes
from crawler.models import (
    Author,
    FullTextLocator,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
    source_document_id,
)
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT, BaseScraper
from crawler.sources.fields import creative_commons_licence, normalize_doi

logger = logging.getLogger(__name__)

LOOKUP_BATCH_SIZE = 100
"""IDs per `id_list` query; one page of the arXiv API."""
API_DELAY_SECONDS = 3.0
"""arXiv allows one request every three seconds, shared by its API and OAI-PMH."""
OAI_URL = "https://oaipmh.arxiv.org/oai"
DEFAULT_LICENCE = "arxiv-nonexclusive-1.0"
"""arXiv's own licence; also what records without a licence (1991–2003) carry."""

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


def arxiv_licence(url: str | None) -> str:
    """Map the `<license>` of an OAI-PMH record to an SPDX ID or arXiv's own licence."""
    if not url or "arxiv.org/licenses/nonexclusive-distrib" in url:
        return DEFAULT_LICENCE
    return creative_commons_licence(url) or url


def parse_licence(body: bytes) -> str | None:
    """The licence of an OAI-PMH `GetRecord` answer; None if arXiv does not know the ID."""
    root = ET.fromstring(body)
    if any(element.tag.rsplit("}", 1)[-1] == "error" for element in root.iter()):
        return None
    record = next((element for element in root.iter() if element.tag.endswith("}arXiv")), None)
    if record is None:
        return None
    licence = next((element.text for element in record if element.tag.endswith("}license")), None)
    return arxiv_licence(licence.strip() if licence else None)


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
    client = arxiv.Client(page_size=100, delay_seconds=API_DELAY_SECONDS, num_retries=0)
    client._session = _TimeoutSession(timeout)
    return client


class ArxivScraper(BaseScraper):
    """arXiv search, lookup by ID and parsing; the licence comes from OAI-PMH.

    The licence costs one extra request per paper within the same three-second budget.
    """

    source = SourceName.ARXIV

    def __init__(
        self,
        *,
        client: Any | None = None,
        licences: bool = True,
        fetch: Fetch = urlopen_bytes,
        sleep: Callable[[float], None] = time.sleep,
        now: Callable[[], datetime] = datetime.now,
        timeout: float = NETWORK_TIMEOUT_SECONDS,
    ) -> None:
        self._client = client or default_client(timeout)
        self._licences = licences
        self._fetch = fetch
        self._sleep = sleep
        self._now = now
        self._timeout = timeout
        self._last_oai_call: datetime | None = None

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source:
            raise ValueError("arXiv scraper received a request for another source")
        if request.is_lookup:
            documents = self._lookup(request.ids)
        else:
            if not request.query:
                raise ValueError("arXiv search requires a query")
            query = self.build_query(request.query, request.query_mode, request.since)
            search = arxiv.Search(
                query=query,
                max_results=request.max_results,
                sort_by=arxiv.SortCriterion.SubmittedDate,
            )
            documents = [self.parse_result(result) for result in self._client.results(search)]
        if not self._licences:
            return documents
        return [
            document.model_copy(update={"licence": self._licence(document.source_id)})
            for document in documents
        ]

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

    def _licence(self, arxiv_id: str) -> str | None:
        """Best effort: a failed lookup leaves the licence unknown instead of failing the run."""
        query = urlencode(
            {
                "verb": "GetRecord",
                "identifier": f"oai:arXiv.org:{arxiv_id}",
                "metadataPrefix": "arXiv",
            }
        )
        request = urllib.request.Request(f"{OAI_URL}?{query}", headers={"User-Agent": USER_AGENT})
        for attempt in range(2):
            self._wait_for_budget()
            try:
                return parse_licence(self._fetch(request, self._timeout))
            except HTTPError as error:
                retry_after = str(error.headers.get("Retry-After", "")) if error.headers else ""
                if attempt == 0 and error.code in {429, 503} and retry_after.isdigit():
                    self._sleep(min(float(retry_after), 30.0))
                    continue
                logger.warning("arXiv licence lookup failed for %s: %s", arxiv_id, error)
            except (OSError, ET.ParseError) as error:
                logger.warning("arXiv licence lookup failed for %s: %s", arxiv_id, error)
            finally:
                self._mark_call()
            return None
        return None

    def _wait_for_budget(self) -> None:
        """Wait until three seconds passed since the last API or OAI-PMH request."""
        calls = (self._last_oai_call, getattr(self._client, "_last_request_dt", None))
        latest = max((call for call in calls if isinstance(call, datetime)), default=None)
        if latest is not None:
            wait = API_DELAY_SECONDS - (self._now() - latest).total_seconds()
            if wait > 0:
                self._sleep(wait)

    def _mark_call(self) -> None:
        self._last_oai_call = self._now()
        if hasattr(self._client, "_last_request_dt"):
            # The arxiv client paces itself from this field; count our OAI-PMH call too.
            self._client._last_request_dt = self._last_oai_call

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
        primary = getattr(result, "primary_category", None)
        categories = sorted(set(result.categories or []))
        doi = normalize_doi(result.doi)
        versioned = f"{source_id}v{version}" if version else source_id
        extra: dict[str, JsonValue] = {}
        comment = str(getattr(result, "comment", None) or "").strip()
        if comment:
            extra["comment"] = comment
        return SourceDocument(
            id=source_document_id(cls.source, source_id),
            source=cls.source,
            content_type="preprint",
            source_id=source_id,
            version=version,
            title=" ".join(str(result.title).split()),
            url=f"https://arxiv.org/abs/{source_id}",
            authors=[
                Author(
                    name=str(author.name),
                    affiliation=str(affiliations[0])
                    if (affiliations := getattr(author, "affiliation", None))
                    else None,
                )
                for author in result.authors
            ],
            abstract=str(result.summary).strip() or None,
            published_at=result.published.isoformat() if result.published else None,
            source_updated_at=getattr(result, "updated", None),
            doi=doi,
            journal=str(result.journal_ref).strip() if result.journal_ref else None,
            subjects=[
                Subject(
                    scheme="arxiv",
                    id=category,
                    label=category,
                    major=category == primary if primary else None,
                )
                for category in categories
            ],
            full_text=[
                FullTextLocator(
                    kind="html", url=f"https://arxiv.org/html/{versioned}", media_type="text/html"
                ),
                FullTextLocator(
                    kind="pdf",
                    url=f"https://arxiv.org/pdf/{versioned}",
                    media_type="application/pdf",
                ),
            ],
            extra=extra,
        )
