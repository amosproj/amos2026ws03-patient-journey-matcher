from abc import ABC, abstractmethod

from crawler.models import ScrapeRequest, SourceDocument, SourceName

NETWORK_TIMEOUT_SECONDS = 60.0
"""Upper bound for one HTTP call, so a stalled connection cannot block a run."""

USER_AGENT = (
    "patient-journey-matcher/0.1 "
    "(+https://github.com/amosproj/amos2026ws03-patient-journey-matcher)"
)


class BaseScraper(ABC):
    """Source boundary separated from downloading, indexing, and persistence.

    A scraper handles three kinds of request: a search (`query`), a channel listing
    (`channel`, YouTube only) and a lookup of known records (`ids`). It only fetches and
    parses metadata; the runner decides what to fetch and records how each record was found.
    """

    source: SourceName

    @abstractmethod
    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        """Fetch and parse the source metadata for one request."""
