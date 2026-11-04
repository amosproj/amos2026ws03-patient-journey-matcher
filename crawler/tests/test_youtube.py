from collections.abc import Callable
from datetime import UTC, date, datetime
from typing import Any

import pytest

from crawler.models import Author, ScrapeRequest, SourceName, Subject
from crawler.sources.youtube import YouTubeScraper


class FakeCall:
    def __init__(self, response: dict[str, Any]) -> None:
        self._response = response

    def execute(self) -> dict[str, Any]:
        return self._response


class FakeResource:
    def __init__(
        self,
        name: str,
        responder: Callable[[str, dict[str, Any]], dict[str, Any]],
        calls: list[tuple[str, dict[str, Any]]],
    ) -> None:
        self._name = name
        self._responder = responder
        self._calls = calls

    def list(self, **arguments: Any) -> FakeCall:
        self._calls.append((self._name, arguments))
        return FakeCall(self._responder(self._name, arguments))


def video(video_id: str, **overrides: Any) -> dict[str, Any]:
    """Shaped like an item of videos.list with part=snippet,contentDetails,status."""
    item: dict[str, Any] = {
        "id": video_id,
        "snippet": {
            "title": "Treatment update",
            "description": "Official channel description",
            "channelTitle": "Medical Channel",
            "channelId": "UC-example",
            "publishedAt": "2026-10-31T10:00:00Z",
            "tags": ["oncology", "oncology"],
            "defaultAudioLanguage": "en-us",
            "liveBroadcastContent": "none",
            "thumbnails": {"medium": {"url": "https://i.ytimg.com/vi/x/mqdefault.jpg"}},
        },
        "contentDetails": {"duration": "PT1H2M5S"},
        "status": {
            "privacyStatus": "public",
            "license": "youtube",
            "embeddable": True,
            "madeForKids": False,
        },
    }
    for part, values in overrides.items():
        item[part] = {**item[part], **values}
    return item


class FakeYouTube:
    def __init__(self, videos: list[dict[str, Any]] | None = None) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.videos_by_id = {item["id"]: item for item in videos or [video("video-1")]}
        self.uploads = [
            {"contentDetails": {"videoId": video_id, "videoPublishedAt": published}}
            for video_id, published in zip(
                self.videos_by_id,
                ["2026-10-31T10:00:00Z", "2026-10-01T10:00:00Z", "2026-09-01T10:00:00Z"],
                strict=False,
            )
        ]

    def _response(self, resource: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if resource == "channels":
            return {
                "items": [
                    {
                        "id": "UC-example",
                        "contentDetails": {"relatedPlaylists": {"uploads": "UU-example"}},
                    }
                ]
            }
        if resource == "playlistItems":
            return {"items": self.uploads[: arguments["maxResults"]]}
        if resource == "videos":
            return {
                "items": [self.videos_by_id[video_id] for video_id in arguments["id"].split(",")]
            }
        raise AssertionError((resource, arguments))

    def channels(self) -> FakeResource:
        return FakeResource("channels", self._response, self.calls)

    def playlistItems(self) -> FakeResource:
        return FakeResource("playlistItems", self._response, self.calls)

    def videos(self) -> FakeResource:
        return FakeResource("videos", self._response, self.calls)


def test_scrape_uses_only_official_metadata_endpoints() -> None:
    service = FakeYouTube()
    scraper = YouTubeScraper("", service=service)

    documents = scraper.scrape(
        ScrapeRequest(source=SourceName.YOUTUBE, channel="UC-example", max_results=1)
    )

    assert [resource for resource, _ in service.calls] == [
        "channels",
        "playlistItems",
        "videos",
    ]
    assert service.calls[-1][1]["part"] == "snippet,contentDetails,status"
    [document] = documents
    assert document.id == "youtube:video-1"
    assert document.content_type == "video"
    assert document.authors == [Author(name="Medical Channel")]
    assert document.description == "Official channel description"
    assert document.abstract is None
    assert document.channel_id == "UC-example"
    assert document.language == "en-US"
    assert document.duration_seconds == 3725
    assert document.subjects == [Subject(scheme="youtube-tag", label="oncology")]
    assert document.licence == "youtube-standard"
    assert document.extra == {
        "thumbnail": "https://i.ytimg.com/vi/x/mqdefault.jpg",
        "embeddable": True,
        "made_for_kids": False,
    }
    assert document.refresh_after is not None
    assert (document.refresh_after - document.retrieved_at).days == 30


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": {"privacyStatus": "unlisted"}},
        {"snippet": {"liveBroadcastContent": "live"}},
        {"snippet": {"liveBroadcastContent": "upcoming"}},
    ],
)
def test_only_public_videos_that_are_not_live_are_kept(overrides: dict[str, Any]) -> None:
    item = video("video-2", **overrides)

    assert YouTubeScraper.parse_video(item, datetime.now(UTC)) is None


def test_creative_commons_videos_carry_cc_by() -> None:
    item = video("video-3", status={"license": "creativeCommon"})

    document = YouTubeScraper.parse_video(item, datetime.now(UTC))

    assert document is not None
    assert document.licence == "CC-BY-3.0"


def test_since_stops_at_the_first_older_upload() -> None:
    service = FakeYouTube([video("new"), video("middle"), video("old")])
    scraper = YouTubeScraper("", service=service)

    documents = scraper.scrape(
        ScrapeRequest(
            source=SourceName.YOUTUBE,
            channel="UC-example",
            max_results=10,
            since=date(2026, 9, 15),
        )
    )

    assert [document.source_id for document in documents] == ["new", "middle"]


def test_resolve_handle_uses_the_official_channels_endpoint() -> None:
    service = FakeYouTube()
    scraper = YouTubeScraper("", service=service)

    assert scraper.resolve_channel_id("@medical") == "UC-example"
    assert service.calls == [("channels", {"part": "id", "forHandle": "medical"})]
