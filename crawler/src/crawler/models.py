from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

PublishedPrecision = Literal["day", "month", "year"]
RequestKind = Literal["search", "channel", "lookup", "references"]
ContentType = Literal[
    "journal_article",
    "preprint",
    "conference_paper",
    "poster",
    "presentation",
    "report",
    "video",
]


class SourceName(StrEnum):
    PUBMED = "pubmed"
    ARXIV = "arxiv"
    YOUTUBE = "youtube"
    ZENODO = "zenodo"


class SourceType(StrEnum):
    PAPER = "paper"
    VIDEO = "video"


class QueryProvenance(BaseModel):
    """The record was returned by a seed search or channel listing."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    topic: str | None = None
    query: str


class CitationProvenance(BaseModel):
    """The record was cited by another record collected in the same run."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    cited_by: str


FoundBy = QueryProvenance | CitationProvenance


class ScrapeRequest(BaseModel):
    """One unit of source work: a search, a channel listing, or a lookup by IDs."""

    source: SourceName
    query: str | None = None
    channel: str | None = None
    ids: list[str] = Field(default_factory=list)
    topics: list[str] = Field(default_factory=list)
    max_results: int = Field(default=10, ge=1, le=10_000)
    since: date | None = None
    query_mode: str = Field(default="and", pattern="^(and|or|raw)$")

    @model_validator(mode="after")
    def validate_source_input(self) -> "ScrapeRequest":
        if self.source is SourceName.YOUTUBE:
            if not self.channel:
                raise ValueError("channel is required for YouTube")
            if self.query or self.ids:
                raise ValueError("YouTube requests take a channel only")
            return self
        if self.channel:
            raise ValueError("channel is only valid for YouTube")
        if self.source is SourceName.ZENODO and self.ids:
            raise ValueError("Zenodo requests take a query only")
        if not self.query and not self.ids:
            raise ValueError("query or ids is required for PubMed, arXiv and Zenodo")
        if self.query and self.ids:
            raise ValueError("a request takes either a query or ids, not both")
        return self

    @property
    def is_lookup(self) -> bool:
        return bool(self.ids)


class SourceDocument(BaseModel):
    """Metadata shared with the matcher through the future documents table."""

    id: str
    source: SourceName
    source_type: SourceType
    content_type: ContentType | None = None
    source_id: str
    version: str | None = None
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
    found_by: list[FoundBy] = Field(default_factory=list)
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


class ScrapeRunError(RuntimeError):
    """Raised by `CollectionResult.raise_for_failures` when a run had failures."""


class RequestFailure(BaseModel):
    """A queued request that failed permanently or ran out of retries."""

    kind: RequestKind
    source: SourceName
    detail: str
    depth: int
    error: str
    retries: int
    retryable: bool


class CollectionStats(BaseModel):
    """Counters for one collection run."""

    seed_requests: int = 0
    finished_requests: int = 0
    failed_requests: int = 0
    unprocessed_requests: int = 0
    documents: int = 0
    references_found: int = 0
    lookups_queued: int = 0
    lookups_missing: int = 0
    skipped_duplicate: int = 0
    skipped_known: int = 0
    skipped_invalid: int = 0
    skipped_off_topic: int = 0


class CollectionResult(BaseModel):
    """Documents of one run plus everything that went wrong on the way."""

    documents: list[SourceDocument]
    failures: list[RequestFailure] = Field(default_factory=list)
    stats: CollectionStats = Field(default_factory=CollectionStats)
    citations: dict[str, list[str]] = Field(default_factory=dict)
    """Cited document ID to citing document IDs, for collected and already known documents."""
    run_error: str | None = None

    @property
    def ok(self) -> bool:
        return not self.failures and self.run_error is None

    def raise_for_failures(self) -> None:
        if self.run_error is not None:
            raise ScrapeRunError(f"collection run aborted: {self.run_error}")
        if not self.failures:
            return
        permanent = [failure for failure in self.failures if not failure.retryable]
        exhausted = [failure for failure in self.failures if failure.retryable]
        messages = []
        if permanent:
            messages.append(
                f"{len(permanent)} request(s) failed without retry: {permanent[0].error}"
            )
        if exhausted:
            messages.append(
                f"{len(exhausted)} request(s) failed after "
                f"{exhausted[0].retries} retries: {exhausted[0].error}"
            )
        raise ScrapeRunError("; ".join(messages))


def source_document_id(source: SourceName, source_id: str) -> str:
    """Return the stable cross-run identifier retained from the legacy base scraper."""
    return f"{source.value}:{source_id}"
