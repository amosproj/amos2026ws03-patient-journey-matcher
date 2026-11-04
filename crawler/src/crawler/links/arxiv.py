import os
import time
import urllib.request
from collections.abc import Callable, Sequence
from urllib.error import HTTPError
from urllib.parse import quote

from pydantic import BaseModel, Field

from crawler.links.base import LinkExtractor
from crawler.models import SourceName
from crawler.sources.arxiv import is_arxiv_id, split_version
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT

REFERENCES_URL = (
    "https://api.semanticscholar.org/graph/v1/paper/ARXIV:{arxiv_id}/references"
    "?fields=externalIds&limit=1000"
)

Fetch = Callable[[urllib.request.Request, float], bytes]


class _CitedPaper(BaseModel):
    external_ids: dict[str, object] | None = Field(default=None, alias="externalIds")


class _Reference(BaseModel):
    cited_paper: _CitedPaper | None = Field(default=None, alias="citedPaper")


class _ReferencesPage(BaseModel):
    data: list[_Reference] | None = None


def _urlopen(request: urllib.request.Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body: bytes = response.read()
    return body


class ArxivLinkExtractor(LinkExtractor):
    """Reads the reference lists of arXiv papers from the Semantic Scholar Graph API.

    Only cited papers with an arXiv ID are returned. Papers that Semantic Scholar does not
    know yet (HTTP 404, common for new preprints) have no references.
    """

    source = SourceName.ARXIV

    def __init__(
        self,
        api_key: str | None = None,
        *,
        fetch: Fetch = _urlopen,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_interval: float = 1.0,
        timeout: float = NETWORK_TIMEOUT_SECONDS,
    ) -> None:
        self._api_key = api_key or None
        self._fetch = fetch
        self._sleep = sleep
        self._clock = clock
        self._min_interval = min_interval
        self._timeout = timeout
        self._last_call: float | None = None

    @classmethod
    def from_env(cls) -> "ArxivLinkExtractor":
        return cls(api_key=os.getenv("SEMANTIC_SCHOLAR_API_KEY"))

    def cited_ids(self, native_ids: Sequence[str]) -> dict[str, list[str]]:
        return {arxiv_id: self._references(arxiv_id) for arxiv_id in native_ids}

    def _references(self, arxiv_id: str) -> list[str]:
        url = REFERENCES_URL.format(arxiv_id=quote(arxiv_id, safe="/."))
        try:
            body = self._get(url)
        except HTTPError as error:
            if error.code == 404:
                return []
            raise
        page = _ReferencesPage.model_validate_json(body)
        cited: list[str] = []
        for reference in page.data or []:
            external_ids = reference.cited_paper.external_ids if reference.cited_paper else None
            value = (external_ids or {}).get("ArXiv")
            if not isinstance(value, str):
                continue
            cited_id, _version = split_version(value)
            if is_arxiv_id(cited_id) and cited_id != arxiv_id:
                cited.append(cited_id)
        return list(dict.fromkeys(cited))

    def _get(self, url: str) -> bytes:
        if self._last_call is not None:
            wait = self._min_interval - (self._clock() - self._last_call)
            if wait > 0:
                self._sleep(wait)
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if self._api_key:
            headers["x-api-key"] = self._api_key
        try:
            return self._fetch(urllib.request.Request(url, headers=headers), self._timeout)
        finally:
            self._last_call = self._clock()
