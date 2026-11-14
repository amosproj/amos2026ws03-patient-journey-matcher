import os
from collections.abc import Sequence
from typing import Any

from Bio import Entrez

from crawler.links.base import LinkExtractor
from crawler.models import SourceName
from crawler.sources.pubmed import (
    NCBI_REQUESTS_PER_SECOND,
    NCBI_THROTTLE,
    NcbiThrottle,
    configure_entrez,
    is_pmid,
    ncbi_credentials_from_env,
    ncbi_requests_per_second,
)

REFERENCES_LINK = "pubmed_pubmed_refs"


class PubMedLinkExtractor(LinkExtractor):
    """Reads the reference lists of PubMed records with NCBI ELink."""

    source = SourceName.PUBMED

    def __init__(
        self,
        email: str | None = None,
        api_key: str | None = None,
        *,
        entrez: Any = Entrez,
        requests_per_second: float | None = None,
        throttle: NcbiThrottle | None = None,
    ) -> None:
        self._email = email.strip() if email else None
        self._api_key = api_key or None
        self._entrez = entrez
        self._rate = requests_per_second or ncbi_requests_per_second(self._api_key, None)
        self._throttle = throttle or NCBI_THROTTLE

    @classmethod
    def from_env(cls) -> "PubMedLinkExtractor":
        email, api_key = ncbi_credentials_from_env()
        return cls(
            email=email,
            api_key=api_key,
            requests_per_second=ncbi_requests_per_second(
                api_key, os.getenv(NCBI_REQUESTS_PER_SECOND)
            ),
        )

    def cited_ids(self, native_ids: Sequence[str]) -> dict[str, list[str]]:
        cited: dict[str, list[str]] = {pmid: [] for pmid in native_ids}
        if not cited:
            return cited
        configure_entrez(self._entrez, self._email, self._api_key)
        self._throttle.wait(self._rate)
        # A list (not a comma-separated string) makes ELink return one link set per PMID.
        handle = self._entrez.elink(
            dbfrom="pubmed", db="pubmed", linkname=REFERENCES_LINK, id=list(cited)
        )
        try:
            link_sets = self._entrez.read(handle)
        finally:
            handle.close()

        for link_set in link_sets:
            source_ids = link_set.get("IdList", [])
            if not source_ids:
                continue
            citing = str(source_ids[0])
            references: list[str] = []
            for database in link_set.get("LinkSetDb", []):
                if database.get("LinkName") != REFERENCES_LINK:
                    continue
                references.extend(str(link["Id"]) for link in database.get("Link", []))
            cited[citing] = list(
                dict.fromkeys(
                    reference
                    for reference in references
                    if is_pmid(reference) and reference != citing
                )
            )
        return cited
