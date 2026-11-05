"""Topic files: the seed queries and channels of one disease area.

They are the input of the architecture's scheduler. The files live in
`crawler/topics/<id>.yaml` and replace the keyword CSVs and the `topics.py` list copied
from the SS26 project.
"""

import logging
import re
from collections.abc import Iterable, Sequence
from datetime import date
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from crawler.models import PodcastFeed, ScrapeRequest, SourceName, validation_message
from crawler.sources.youtube import channel_lookup

TOPICS_DIR = Path(__file__).resolve().parents[2] / "topics"

_SLUG = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*")

logger = logging.getLogger(__name__)


class TopicFileError(ValueError):
    """A topic file is missing, malformed, or has no seeds for the requested source."""


class Channel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(min_length=1)
    url: str = Field(min_length=1)

    @field_validator("url")
    @classmethod
    def validate_url(cls, url: str) -> str:
        channel_lookup(url)
        return url


class Topic(BaseModel):
    """One disease area: search queries, YouTube channels, podcast feeds, filter terms."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    label: str = Field(min_length=1)
    terms: list[str] = Field(default_factory=list)
    queries: list[str] = Field(default_factory=list)
    channels: list[Channel] = Field(default_factory=list)
    podcasts: list[PodcastFeed] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_seeds(self) -> "Topic":
        if not _SLUG.fullmatch(self.id):
            raise ValueError(f"id must be lower case words joined by '_': {self.id!r}")
        if not self.queries and not self.channels and not self.podcasts:
            raise ValueError("a topic needs at least one query, channel or podcast")
        if self.queries and not self.terms:
            raise ValueError("a topic with queries needs terms for the topic filter")
        for field in ("terms", "queries"):
            values: list[str] = getattr(self, field)
            if any(not value.strip() for value in values):
                raise ValueError(f"{field} must not contain blank entries")
            if len(set(values)) != len(values):
                raise ValueError(f"{field} must not contain duplicates")
        urls = [channel.url for channel in self.channels]
        if len(set(urls)) != len(urls):
            raise ValueError("channels must not contain duplicate URLs")
        keys = [feed.key for feed in self.podcasts]
        if len(set(keys)) != len(keys):
            raise ValueError("podcasts must not contain duplicate keys")
        return self


def topic_path(reference: str | Path) -> Path:
    """Resolve a topic ID (`prostate_cancer`) or a path to a YAML file."""
    path = Path(reference)
    if path.suffix in {".yaml", ".yml"} or len(path.parts) > 1:
        return path
    return TOPICS_DIR / f"{path.name}.yaml"


def load_topic(reference: str | Path) -> Topic:
    path = topic_path(reference)
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise TopicFileError(f"topic file not found: {path}") from error
    except (OSError, UnicodeDecodeError) as error:
        raise TopicFileError(f"cannot read topic file {path}: {error}") from error
    except yaml.YAMLError as error:
        raise TopicFileError(f"{path}: invalid YAML: {error}") from error
    try:
        topic = Topic.model_validate(data)
    except ValidationError as error:
        raise TopicFileError(f"{path}: {validation_message(error)}") from error
    if topic.id != path.stem:
        raise TopicFileError(f"{path}: id {topic.id!r} does not match the file name")
    return topic


def seed_requests(
    topics: Sequence[Topic],
    source: SourceName,
    *,
    max_results: int = 10,
    since: date | None = None,
    query_mode: str = "and",
) -> list[ScrapeRequest]:
    """Turn the queries, channels (YouTube) or feeds (podcasts) of the topics into requests.

    A query, channel or feed that several topics share becomes one request for all of them.
    """
    seeds: dict[str, list[str]] = {}
    feeds: dict[str, tuple[PodcastFeed, str]] = {}
    for topic in topics:
        if source is SourceName.YOUTUBE:
            values = [channel.url for channel in topic.channels]
        elif source is SourceName.PODCAST:
            for feed in topic.podcasts:
                _add_feed(feeds, feed, topic.id)
            values = [feed.key for feed in topic.podcasts]
        else:
            values = topic.queries
        for value in values:
            topic_ids = seeds.setdefault(value, [])
            if topic.id not in topic_ids:
                topic_ids.append(topic.id)
    if not seeds:
        names = ", ".join(topic.id for topic in topics)
        raise TopicFileError(f"no {source.value} seeds in topic(s): {names}")
    common: dict[str, Any] = {"source": source, "max_results": max_results, "since": since}
    if source is SourceName.YOUTUBE:
        return [_request(url, topic_ids, channel=url, **common) for url, topic_ids in seeds.items()]
    if source is SourceName.PODCAST:
        return [
            _request(key, topic_ids, feed=feeds[key][0], **common)
            for key, topic_ids in seeds.items()
        ]
    return [
        _request(query, topic_ids, query=query, query_mode=query_mode, **common)
        for query, topic_ids in seeds.items()
    ]


def _request(seed: str, topic_ids: list[str], **fields: Any) -> ScrapeRequest:
    """A seed request; an invalid one names its topics and seed (`query has no words …`)."""
    try:
        return ScrapeRequest.model_validate({**fields, "topics": topic_ids})
    except ValidationError as error:
        raise TopicFileError(
            f"topic {', '.join(topic_ids)}, {seed!r}: {validation_message(error)}"
        ) from error


def _add_feed(feeds: dict[str, tuple[PodcastFeed, str]], feed: PodcastFeed, topic_id: str) -> None:
    """Note a topic's feed: one key must name one feed URL, as the key is in every episode ID.

    The same URL with other details (another publisher wording, say) is still the same feed;
    the first topic's entry wins and a warning shows the difference.
    """
    known, known_topic = feeds.setdefault(feed.key, (feed, topic_id))
    if known.url != feed.url:
        raise TopicFileError(
            f"podcast key {feed.key!r} names two feeds: {known.url} ({known_topic}) and "
            f"{feed.url} ({topic_id}); the key is part of every episode ID, so give each "
            "feed its own key"
        )
    differing = [
        name
        for name in ("name", "publisher", "audience", "language")
        if getattr(known, name) != getattr(feed, name)
    ]
    if differing:
        logger.warning(
            "podcast %r: %s differ between topics %s and %s; using the entry of %s",
            feed.key,
            ", ".join(differing),
            known_topic,
            topic_id,
            known_topic,
        )


def bundled_topics() -> list[Topic]:
    return [load_topic(path) for path in sorted(TOPICS_DIR.glob("*.yaml"))]


def find_podcast(key: str) -> tuple[PodcastFeed, list[str]]:
    """A curated feed by key, with the IDs of the bundled topics that list it."""
    feeds: dict[str, tuple[PodcastFeed, str]] = {}
    topic_ids: list[str] = []
    for topic in bundled_topics():
        for feed in topic.podcasts:
            if feed.key == key:
                _add_feed(feeds, feed, topic.id)
                topic_ids.append(topic.id)
    if not topic_ids:
        raise TopicFileError(f"unknown podcast feed {key!r}; add it to a topic file first")
    return feeds[key][0], topic_ids


def topic_terms(topics: Iterable[Topic]) -> list[str]:
    """All topic-filter terms of the topics, in file order and without duplicates."""
    return list(dict.fromkeys(term for topic in topics for term in topic.terms))
