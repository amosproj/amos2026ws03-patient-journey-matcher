"""PubMed Central: licence and full-text location for PubMed records with a PMCID.

PMC has no records of its own here. Its public S3 bucket holds the article versions that
allow text mining, with a small JSON file per version.
"""

import json
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode

from pydantic import JsonValue

from crawler.http import Fetch, Pacer, urlopen_bytes
from crawler.models import FullTextLocator, SourceDocument
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT

BUCKET_URL = "https://pmc-oa-opendata.s3.amazonaws.com"
_S3 = "{http://s3.amazonaws.com/doc/2006-03-01/}"
_VERSION_PREFIX = re.compile(r"PMC[0-9]+\.(?P<version>[0-9]+)/")
_LICENCES = {"CC0": "CC0-1.0", "TDM": "pmc-tdm"}


def pmc_licence(code: object) -> str | None:
    """`CC BY-NC` → `CC-BY-NC` (PMC gives no version); `TDM` (text mining only) → `pmc-tdm`;
    none → unknown."""
    if not code:
        return None
    value = str(code).strip()
    return _LICENCES.get(value, value.replace(" ", "-").upper())


class PmcClient:
    """Two anonymous requests per PMCID: list the versions, then read one version's JSON."""

    def __init__(
        self,
        *,
        fetch: Fetch = urlopen_bytes,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_interval: float = 0.1,
        timeout: float = NETWORK_TIMEOUT_SECONDS,
    ) -> None:
        self._fetch = fetch
        self._pacer = Pacer(min_interval, sleep=sleep, clock=clock)
        self._timeout = timeout

    def enrich(self, document: SourceDocument) -> SourceDocument:
        """Add licence, full-text locator and PMC IDs; unchanged if PMC does not have it."""
        pmcid = document.external_ids.get("pmcid")
        if not pmcid:
            return document
        metadata = self._metadata(pmcid)
        if metadata is None:
            return document
        version = str(metadata.get("version") or "")
        external_ids = {**document.external_ids, "pmc_version": version}
        if metadata.get("mid"):
            external_ids["nihms"] = str(metadata["mid"])
        extra: dict[str, JsonValue] = dict(document.extra)
        for key in ("is_manuscript", "is_retracted", "is_historical_ocr"):
            if key in metadata:
                extra[key] = bool(metadata[key])
        return document.model_copy(
            update={
                "licence": pmc_licence(metadata.get("license_code")),
                "full_text": [*self._locators(metadata), *document.full_text],
                "external_ids": external_ids,
                "extra": extra,
            }
        )

    def _metadata(self, pmcid: str) -> dict[str, Any] | None:
        """Prefer a version that is not an author manuscript, then the highest number."""
        versions = self._versions(pmcid)
        fallback: dict[str, Any] | None = None
        for version in versions:
            metadata = self._get_json(f"{BUCKET_URL}/metadata/{pmcid}.{version}.json")
            if metadata is None:
                continue
            if not metadata.get("is_manuscript"):
                return metadata
            fallback = fallback or metadata
        return fallback

    def _versions(self, pmcid: str) -> list[int]:
        query = urlencode({"list-type": "2", "prefix": f"{pmcid}.", "delimiter": "/"})
        body = self._get(f"{BUCKET_URL}/?{query}")
        if body is None:
            return []
        prefixes = (element.text or "" for element in ET.fromstring(body).iter(f"{_S3}Prefix"))
        versions = {
            int(match["version"]) for p in prefixes if (match := _VERSION_PREFIX.fullmatch(p))
        }
        return sorted(versions, reverse=True)

    @staticmethod
    def _locators(metadata: dict[str, Any]) -> list[FullTextLocator]:
        xml_url = str(metadata.get("xml_url") or "")
        if not xml_url.startswith("s3://pmc-oa-opendata/"):
            return []
        key, _, query = xml_url.removeprefix("s3://pmc-oa-opendata/").partition("?")
        md5 = query.removeprefix("md5=") if query.startswith("md5=") else None
        return [
            FullTextLocator(
                kind="jats",
                url=f"{BUCKET_URL}/{key}",
                media_type="application/xml",
                checksum=f"md5:{md5}" if md5 else None,
            )
        ]

    def _get_json(self, url: str) -> dict[str, Any] | None:
        body = self._get(url)
        if body is None:
            return None
        data = json.loads(body)
        return data if isinstance(data, dict) else None

    def _get(self, url: str) -> bytes | None:
        """None for 403 and 404: the article is not (or no longer) in the bucket."""
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with self._pacer:
                return self._fetch(request, self._timeout)
        except HTTPError as error:
            if error.code in {403, 404}:
                return None
            raise
