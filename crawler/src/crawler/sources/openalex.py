"""OpenAlex: open-access copies of papers that PMC does not hold, found by DOI.

OpenAlex has no records of its own here. For a batch of DOIs it lists where each paper can
be read: publisher sites, repositories and preprint servers, with a licence per copy. Only
direct PDF links are kept; OpenAlex's own copies (`content_urls`) need an API key to download,
which a stored URL must not hold.
"""

import json
import os
import time
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from typing import Any
from urllib.parse import urlencode

from pydantic import BaseModel

from crawler.http import Fetch, Pacer, urlopen_bytes
from crawler.models import FullTextLocator
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT
from crawler.sources.fields import normalize_doi

API_URL = "https://api.openalex.org/works"
BATCH_SIZE = 50
"""DOIs per request; OpenAlex allows 100 values in one filter."""
MIN_INTERVAL_SECONDS = 1.0
"""OpenAlex allows one request per second for filters of more than five values without a key."""
MAX_LOCATORS = 3
"""The indexers try at most three locators."""
_FIELDS = "id,doi,best_oa_location,locations"


class OpenAccessCopy(BaseModel):
    """Where a paper can be read, best first, and the licence of the first copy."""

    full_text: list[FullTextLocator]
    licence: str | None = None
    openalex_id: str | None = None


def openalex_licence(code: object) -> str | None:
    """`cc-by-nc` → `CC-BY-NC` like PMC's codes (no version); `cc0` → `CC0-1.0`; other
    codes (`publisher-specific-oa`, `other-oa`) say too little and count as unknown."""
    value = str(code or "").strip().lower()
    if value == "cc0":
        return "CC0-1.0"
    if value.startswith("cc-"):
        return value.upper()
    return None


class OpenAlexClient:
    """One request per `BATCH_SIZE` DOIs, at most one request per second."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        fetch: Fetch = urlopen_bytes,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_interval: float = MIN_INTERVAL_SECONDS,
        timeout: float = NETWORK_TIMEOUT_SECONDS,
    ) -> None:
        self._api_key = api_key or None
        self._fetch = fetch
        self._pacer = Pacer(min_interval, sleep=sleep, clock=clock)
        self._timeout = timeout

    @classmethod
    def from_env(cls) -> "OpenAlexClient":
        """`OPENALEX_API_KEY` is optional: without it, OpenAlex shares a small daily budget
        among everyone on the same IP address."""
        return cls(api_key=os.getenv("OPENALEX_API_KEY") or None)

    def open_access(self, dois: Iterable[str]) -> dict[str, OpenAccessCopy]:
        """The open-access copies by normalized DOI; DOIs without a readable copy are left out.

        Network and HTTP errors are raised: the caller decides whether to go on without.
        """
        normalized = (normalize_doi(doi) for doi in dois)
        wanted = list(dict.fromkeys(doi for doi in normalized if doi and _searchable(doi)))
        copies: dict[str, OpenAccessCopy] = {}
        for offset in range(0, len(wanted), BATCH_SIZE):
            for work in self._works(wanted[offset : offset + BATCH_SIZE]):
                doi = normalize_doi(work.get("doi"))
                copy = self._copy(work)
                if doi and copy is not None:
                    copies[doi] = copy
        return copies

    def _works(self, dois: Sequence[str]) -> list[dict[str, Any]]:
        parameters = {
            "filter": "doi:" + "|".join(dois),
            "select": _FIELDS,
            "per_page": str(len(dois)),
        }
        if self._api_key:
            parameters["api_key"] = self._api_key
        request = urllib.request.Request(
            f"{API_URL}?{urlencode(parameters)}", headers={"User-Agent": USER_AGENT}
        )
        with self._pacer:
            body = self._fetch(request, self._timeout)
        data = json.loads(body)
        results = data.get("results") if isinstance(data, dict) else None
        return [work for work in results or [] if isinstance(work, dict)]

    @staticmethod
    def _copy(work: dict[str, Any]) -> OpenAccessCopy | None:
        locations = [work.get("best_oa_location"), *(work.get("locations") or [])]
        locators: list[FullTextLocator] = []
        licence: str | None = None
        for location in locations:
            if not isinstance(location, dict) or not location.get("is_oa"):
                continue
            url = str(location.get("pdf_url") or "").strip()
            if not url.startswith(("https://", "http://")):
                continue
            if any(locator.url == url for locator in locators):
                continue
            if not locators:
                licence = openalex_licence(location.get("license"))
            locators.append(FullTextLocator(kind="pdf", url=url, media_type="application/pdf"))
        if not locators:
            return None
        work_id = str(work.get("id") or "").rsplit("/", 1)[-1] or None
        return OpenAccessCopy(
            full_text=locators[:MAX_LOCATORS], licence=licence, openalex_id=work_id
        )


def _searchable(doi: str) -> bool:
    """`|` separates the values of a filter and `,` the filters, so such DOIs cannot be asked."""
    return "|" not in doi and "," not in doi
