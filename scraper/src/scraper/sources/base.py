from abc import ABC, abstractmethod

from scraper.models import ScrapeRequest, SourceDocument, SourceName


class BaseScraper(ABC):
    """Source boundary separated from downloading, indexing, and persistence."""

    source: SourceName

    @abstractmethod
    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        """Discover and parse source metadata for one request."""
