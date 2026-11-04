import hashlib
import urllib.request
from datetime import date

import pytest

from crawler.models import (
    Author,
    FullTextLocator,
    PodcastFeed,
    ScrapeRequest,
    SourceName,
    SourceType,
)
from crawler.sources.podcast import SUMMARY_LIMIT, PodcastScraper

FEED = PodcastFeed(
    key="lancet_oncology",
    name="The Lancet Oncology in conversation with",
    url="https://feed.example.test/lancetonc.xml",
    publisher="The Lancet Group",
    audience="clinicians",
    language="en",
)

LONG_NOTES = (
    "Transcript: "
    + "word " * 400
    + "See doi 10.1016/S1470-2045(26)00001-2."
    + ' <a href="https://ascopubs.org/doi/10.1200/JCO-26-00042?af=R&amp;x=1">article</a>'
)

RSS = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:podcast="https://podcastindex.org/namespace/1.0"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>The Lancet Oncology in conversation with</title>
    <link>https://lancetonc.podbean.com</link>
    <language>en-gb</language>
    <copyright>© 2026 The Lancet Group</copyright>
    <string-array><item>junk entry inside a Libsyn string array</item></string-array>
    <item>
      <title>Iberdomide in multiple myeloma</title>
      <link>https://lancetonc.podbean.com/e/iberdomide</link>
      <guid isPermaLink="false">lancetonc.podbean.com/6cf59b4a</guid>
      <pubDate>Mon, 26 Oct 2026 23:28:00 +0100</pubDate>
      <itunes:duration>401</itunes:duration>
      <itunes:episodeType>full</itunes:episodeType>
      <description>&lt;p&gt;Short &amp;amp; sweet&lt;/p&gt;</description>
      <content:encoded><![CDATA[<p>{LONG_NOTES}</p>]]></content:encoded>
      <podcast:transcript url="https://cdn.test/t.srt" type="application/srt" language="en"/>
      <podcast:chapters url="https://cdn.test/chapters.json" type="application/json+chapters"/>
      <enclosure url="https://cdn.test/iberdomide.mp3" length="9661180" type="audio/mpeg"/>
    </item>
    <item>
      <title>An episode without guid</title>
      <link>mailto:someone@example.test</link>
      <pubDate>Mon, 12 Oct 2026 08:00:00 +0000</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
      <enclosure url="https://cdn.test/no-guid.mp3" length="0" type="audio/mpeg"/>
    </item>
    <item>
      <title>Trailer</title>
      <guid>trailer-1</guid>
      <itunes:episodeType>trailer</itunes:episodeType>
      <enclosure url="https://cdn.test/trailer.mp3" type="audio/mpeg"/>
    </item>
    <item>
      <title>Neither guid nor enclosure</title>
    </item>
  </channel>
</rss>
""".encode()


class FakeFeed:
    def __init__(self, body: bytes = RSS) -> None:
        self.body = body
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
        self.requests.append(request)
        return self.body


def scrape(fetch: FakeFeed, **arguments: object) -> list:  # type: ignore[type-arg]
    scraper = PodcastScraper(fetch=fetch, sleep=lambda _seconds: None)
    return scraper.scrape(ScrapeRequest(source=SourceName.PODCAST, feed=FEED, **arguments))  # type: ignore[arg-type]


def test_episode_fields_follow_the_feed() -> None:
    fetch = FakeFeed()

    first, second = scrape(fetch)

    assert fetch.requests[0].full_url == FEED.url
    assert fetch.requests[0].get_header("User-agent", "").startswith("patient-journey-matcher")
    assert first.id == "podcast:lancet_oncology:lancetonc.podbean.com/6cf59b4a"
    assert first.source is SourceName.PODCAST
    assert first.source_type is SourceType.AUDIO
    assert first.content_type == "podcast_episode"
    assert first.title == "Iberdomide in multiple myeloma"
    assert first.url == "https://lancetonc.podbean.com/e/iberdomide"
    assert first.authors == [Author(name="The Lancet Group")]
    assert first.journal == "The Lancet Oncology in conversation with"
    assert first.language == "en-GB"
    assert first.published_on == date(2026, 10, 26)
    assert first.duration_seconds == 401
    assert first.licence == "all-rights-reserved"
    assert first.external_ids == {"feed_key": "lancet_oncology"}
    assert first.full_text == [
        FullTextLocator(
            kind="transcript",
            url="https://cdn.test/t.srt",
            media_type="application/srt",
            language="en",
        ),
        FullTextLocator(
            kind="audio",
            url="https://cdn.test/iberdomide.mp3",
            media_type="audio/mpeg",
            size=9661180,
        ),
    ]
    assert first.extra == {
        "audience": "clinicians",
        "episode_type": "full",
        "chapters_url": "https://cdn.test/chapters.json",
        "dois": ["10.1016/S1470-2045(26)00001-2", "10.1200/JCO-26-00042"],
    }


def test_long_show_notes_are_cut_to_1000_characters() -> None:
    first, _second = scrape(FakeFeed())

    assert first.description is not None
    assert len(first.description) <= SUMMARY_LIMIT
    assert first.description.startswith("Transcript: word word")
    assert first.description.endswith("…")


def test_episodes_without_guid_use_the_enclosure_and_noise_is_skipped() -> None:
    episodes = scrape(FakeFeed())

    second = episodes[1]
    digest = hashlib.sha256(b"https://cdn.test/no-guid.mp3").hexdigest()
    assert second.source_id == f"lancet_oncology:enc:{digest}"
    assert second.url == "https://cdn.test/no-guid.mp3"
    assert second.duration_seconds == 3723
    assert second.full_text[0].size is None
    assert [episode.title for episode in episodes] == [
        "Iberdomide in multiple myeloma",
        "An episode without guid",
    ]


def test_newest_episodes_first_with_since_and_max_results() -> None:
    assert [episode.title for episode in scrape(FakeFeed(), max_results=1)] == [
        "Iberdomide in multiple myeloma"
    ]
    assert [episode.title for episode in scrape(FakeFeed(), since=date(2026, 10, 20))] == [
        "Iberdomide in multiple myeloma"
    ]


def test_a_broken_feed_is_a_permanent_error() -> None:
    with pytest.raises(ValueError, match="not valid XML"):
        scrape(FakeFeed(b"<html>Moved</html"))
