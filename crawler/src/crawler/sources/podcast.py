"""Podcast episodes from the RSS feeds of a hand-curated list (no discovery, no API key).

The standard library reads the XML: feedparser garbles the `podcast:*` tags we need.
"""

import hashlib
import html
import re
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Callable
from datetime import date
from email.utils import parsedate_to_datetime
from typing import Any

from pydantic import JsonValue

from crawler.http import Fetch, Pacer, urlopen_bytes
from crawler.models import (
    Author,
    FullTextLocator,
    PodcastFeed,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)
from crawler.sources.base import NETWORK_TIMEOUT_SECONDS, USER_AGENT, BaseScraper
from crawler.sources.fields import clock_duration_seconds, language_tag, plain_text, truncate

NAMESPACES = {
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "podcast": "https://podcastindex.org/namespace/1.0",
    "content": "http://purl.org/rss/1.0/modules/content/",
}
SUMMARY_LIMIT = 1_000
"""Show notes can be full transcripts (ASCO), so the crawler keeps only the start."""

_DOI = re.compile(r"\b10\.[0-9]{4,9}/[^\s\"'<>]+")


class PodcastScraper(BaseScraper):
    """One GET per feed, at most one every three seconds (our own politeness limit)."""

    source = SourceName.PODCAST

    def __init__(
        self,
        *,
        fetch: Fetch = urlopen_bytes,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        min_interval: float = 3.0,
        timeout: float = NETWORK_TIMEOUT_SECONDS,
    ) -> None:
        self._fetch = fetch
        self._pacer = Pacer(min_interval, sleep=sleep, clock=clock)
        self._timeout = timeout

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source or request.feed is None:
            raise ValueError("podcast scraper requires a podcast request with a feed")
        feed = request.feed
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
        }
        with self._pacer:
            body = self._fetch(urllib.request.Request(feed.url, headers=headers), self._timeout)
        try:
            channel = ET.fromstring(body).find("channel")
        except ET.ParseError as error:
            raise ValueError(f"podcast feed {feed.key} is not valid XML: {error}") from error
        if channel is None:
            raise ValueError(f"podcast feed {feed.key} has no channel")
        episodes = [
            episode
            for item in channel.findall("item")
            if (episode := self.parse_episode(item, channel, feed)) is not None
        ]
        if request.since:
            episodes = [
                episode
                for episode in episodes
                if episode.published_on and episode.published_on >= request.since
            ]
        # Newest first; episodes without a date go last.
        episodes.sort(key=lambda episode: episode.published_on or date.min, reverse=True)
        return episodes[: request.max_results]

    @classmethod
    def parse_episode(
        cls, item: ET.Element, channel: ET.Element, feed: PodcastFeed
    ) -> SourceDocument | None:
        """None for trailers and for entries without guid and enclosure (feed noise)."""
        text = _text
        if text(item, "itunes:episodeType").lower() == "trailer":
            return None
        enclosure = item.find("enclosure")
        enclosure_url = enclosure.get("url", "").strip() if enclosure is not None else ""
        guid = text(item, "guid")
        if not guid:
            if not enclosure_url:
                return None
            guid = "enc:" + hashlib.sha256(enclosure_url.encode("utf-8")).hexdigest()
        native_id = f"{feed.key}:{guid}"
        raw_notes = text(item, "content:encoded") or text(item, "description")
        notes = plain_text(raw_notes)
        link = text(item, "link")
        url = next(
            (
                candidate
                for candidate in (link, enclosure_url, text(channel, "link"))
                if candidate.startswith(("http://", "https://"))
            ),
            feed.url,
        )
        extra: dict[str, JsonValue] = {"audience": feed.audience}
        episode_type = text(item, "itunes:episodeType")
        if episode_type:
            extra["episode_type"] = episode_type
        chapters = item.find("podcast:chapters", NAMESPACES)
        if chapters is not None and chapters.get("url"):
            extra["chapters_url"] = chapters.get("url")
        # DOIs usually sit in links of the show notes, so search the HTML, not the text.
        dois: list[JsonValue] = list(dict.fromkeys(map(_clean_doi, _DOI.findall(raw_notes))))
        if dois:
            extra["dois"] = dois
        return SourceDocument(
            id=source_document_id(cls.source, native_id),
            source=cls.source,
            source_type=SourceType.AUDIO,
            content_type="podcast_episode",
            source_id=native_id,
            title=text(item, "title"),
            url=url,
            authors=cls._authors(item, feed),
            description=truncate(notes, SUMMARY_LIMIT) if notes else None,
            language=language_tag(text(channel, "language") or feed.language),
            published_at=cls._published_at(text(item, "pubDate")),
            journal=text(channel, "title") or feed.name,
            duration_seconds=clock_duration_seconds(text(item, "itunes:duration")),
            licence=cls._licence(item, channel),
            full_text=cls._locators(item, enclosure),
            external_ids={"feed_key": feed.key},
            extra=extra,
        )

    @staticmethod
    def _authors(item: ET.Element, feed: PodcastFeed) -> list[Author]:
        """`podcast:person` if the feed names people; else the curated publisher."""
        people = [
            (person.text or "").strip()
            for person in item.findall("podcast:person", NAMESPACES)
            if (person.text or "").strip()
        ]
        return [Author(name=name) for name in people] or [Author(name=feed.publisher)]

    @staticmethod
    def _published_at(value: str) -> str | None:
        """RFC 822 (`Mon, 26 Oct 2026 11:00:00 +0000`) → ISO 8601."""
        if not value:
            return None
        try:
            return parsedate_to_datetime(value).isoformat()
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _licence(item: ET.Element, channel: ET.Element) -> str | None:
        """`podcast:license`, else a copyright notice means all rights reserved."""
        for element in (item, channel):
            licence = element.find("podcast:license", NAMESPACES)
            if licence is not None and (licence.text or "").strip():
                return (licence.text or "").strip()
        return "all-rights-reserved" if _text(channel, "copyright") else None

    @staticmethod
    def _locators(item: ET.Element, enclosure: ET.Element | None) -> list[FullTextLocator]:
        """Every transcript first, then the audio file."""
        locators = [
            FullTextLocator(
                kind="transcript",
                url=transcript.get("url", "").strip(),
                media_type=transcript.get("type"),
                language=language_tag(transcript.get("language")),
            )
            for transcript in item.findall("podcast:transcript", NAMESPACES)
            if transcript.get("url", "").strip()
        ]
        if enclosure is not None and enclosure.get("url", "").strip():
            length = enclosure.get("length", "")
            locators.append(
                FullTextLocator(
                    kind="audio",
                    url=enclosure.get("url", "").strip(),
                    media_type=enclosure.get("type"),
                    size=int(length) if length.isdigit() and int(length) > 0 else None,
                )
            )
        return locators


def _clean_doi(value: str) -> str:
    """Drop link parameters and sentence punctuation; keep brackets that belong to the DOI."""
    value = html.unescape(value).split("?")[0].split("#")[0].rstrip(".,;:")
    while value.endswith(")") and value.count(")") > value.count("("):
        value = value[:-1].rstrip(".,;:")
    return value


def _text(element: ET.Element, path: str) -> str:
    found: Any = element.find(path, NAMESPACES)
    return str(found.text or "").strip() if found is not None else ""
