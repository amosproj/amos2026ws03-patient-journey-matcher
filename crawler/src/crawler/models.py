from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, model_validator

PublishedPrecision = Literal["day", "month", "year"]


class SourceName(StrEnum):
    PUBMED = "pubmed"
    ARXIV = "arxiv"
    YOUTUBE = "youtube"


class SourceType(StrEnum):
    PAPER = "paper"
    VIDEO = "video"


class ScrapeRequest(BaseModel):
    """One deduplicated unit of work for Crawlee."""

    source: SourceName
    query: str | None = None
    channel: str | None = None
    max_results: int = Field(default=10, ge=1, le=10_000)
    since: date | None = None
    query_mode: str = Field(default="and", pattern="^(and|or|raw)$")

    @model_validator(mode="after")
    def validate_source_input(self) -> "ScrapeRequest":
        if self.source is SourceName.YOUTUBE:
            if not self.channel:
                raise ValueError("channel is required for YouTube")
        elif not self.query:
            raise ValueError("query is required for PubMed and arXiv")
        return self


class SourceDocument(BaseModel):
    """Metadata shared with the matcher through the future documents table."""

    id: str
    source: SourceName
    source_type: SourceType
    source_id: str
    title: str
    url: str
    authors: list[str] = Field(default_factory=list)
    abstract: str | None = None
    description: str | None = None
    published_at: str | None = None
    published_on: date | None = None
    published_precision: PublishedPrecision | None = None
    doi: str | None = None
    journal: str | None = None
    channel_id: str | None = None
    duration: str | None = None
    view_count: int | None = None
    keywords: list[str] = Field(default_factory=list)
    query_keywords: list[str] = Field(default_factory=list)
    retrieved_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    refresh_after: datetime | None = None

    @model_validator(mode="after")
    def normalize_publication_date(self) -> "SourceDocument":
        if self.published_at is None:
            self.published_on = None
            self.published_precision = None
            return self

        self.published_on, self.published_precision = self._parse_publication_date(
            self.published_at
        )
        return self

    @staticmethod
    def _parse_publication_date(value: str) -> tuple[date, PublishedPrecision]:
        try:
            if len(value) == 4:
                return date.fromisoformat(f"{value}-01-01"), "year"
            if len(value) == 7:
                return date.fromisoformat(f"{value}-01"), "month"
            if len(value) == 10:
                return date.fromisoformat(value), "day"
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date(), "day"
        except ValueError as error:
            raise ValueError(
                "published_at must be ISO 8601 year, month, date, or datetime"
            ) from error


def source_document_id(source: SourceName, source_id: str) -> str:
    """Return the stable cross-run identifier retained from the legacy base scraper."""
    return f"{source.value}:{source_id}"
