from datetime import UTC, date, datetime
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator


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
    doi: str | None = None
    journal: str | None = None
    channel_id: str | None = None
    duration: str | None = None
    view_count: int | None = None
    keywords: list[str] = Field(default_factory=list)
    query_keywords: list[str] = Field(default_factory=list)
    retrieved_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    refresh_after: datetime | None = None


def source_document_id(source: SourceName, source_id: str) -> str:
    """Return the stable cross-run identifier retained from the legacy base scraper."""
    return f"{source.value}:{source_id}"
