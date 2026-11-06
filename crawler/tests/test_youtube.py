from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httplib2
import pytest
from googleapiclient.errors import HttpError

from crawler.models import Author, ScrapeRequest, SourceName, Subject
from crawler.sources import youtube
from crawler.sources.youtube import YouTubeScraper, channel_lookup

CHANNEL_ID = "UC" + "a" * 22


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


UPLOAD_DATES = [f"2026-{month:02d}-01T10:00:00Z" for month in range(10, 0, -1)]


class FakeYouTube:
    def __init__(
        self, videos: list[dict[str, Any]] | None = None, published: list[str] | None = None
    ) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.videos_by_id = {item["id"]: item for item in videos or [video("video-1")]}
        self.uploads = [
            {"contentDetails": {"videoId": video_id, "videoPublishedAt": date}}
            for video_id, date in zip(self.videos_by_id, published or UPLOAD_DATES, strict=False)
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
            start = int(arguments.get("pageToken") or 0)
            end = start + arguments["maxResults"]
            page: dict[str, Any] = {"items": self.uploads[start:end]}
            if end < len(self.uploads):
                page["nextPageToken"] = str(end)
            return page
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
        ScrapeRequest(source=SourceName.YOUTUBE, channel=CHANNEL_ID, max_results=1)
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
            channel=CHANNEL_ID,
            max_results=10,
            since=date(2026, 8, 15),
        )
    )

    assert [document.source_id for document in documents] == ["new", "middle"]


def test_resolve_handle_uses_the_official_channels_endpoint() -> None:
    service = FakeYouTube()
    scraper = YouTubeScraper("", service=service)

    assert scraper.resolve_channel_id("@medical") == "UC-example"
    assert service.calls == [("channels", {"part": "id", "forHandle": "medical"})]


@pytest.mark.parametrize(
    ("reference", "expected"),
    [
        (CHANNEL_ID, ("id", CHANNEL_ID)),
        (f"https://www.youtube.com/channel/{CHANNEL_ID}", ("id", CHANNEL_ID)),
        (f"youtube.com/channel/{CHANNEL_ID}/videos", ("id", CHANNEL_ID)),
        ("@TED", ("forHandle", "TED")),
        ("@ted.ed", ("forHandle", "ted.ed")),
        ("https://www.youtube.com/@TED", ("forHandle", "TED")),
        ("https://www.youtube.com/@TED/shorts", ("forHandle", "TED")),
        ("https://m.youtube.com/@ted?si=abc123", ("forHandle", "ted")),
        ("TEDtalksDirector", ("forUsername", "TEDtalksDirector")),
        (
            "https://www.youtube.com/user/TEDtalksDirector/videos",
            ("forUsername", "TEDtalksDirector"),
        ),
        ("https://www.youtube.com/@%54%45%44/videos", ("forHandle", "TED")),
    ],
)
def test_channel_references_resolve_by_id_handle_or_username(
    reference: str, expected: tuple[str, str]
) -> None:
    assert channel_lookup(reference) == expected


@pytest.mark.parametrize(
    "reference",
    [
        "https://www.youtube.com/watch?v=VC4g2l47rzc",
        "https://www.youtube.com/shorts/JOPuUlsXMso",
        "https://www.youtube.com/c/TED",
        "https://www.youtube.com/",
        "https://vimeo.com/@TED",
        "@",
        "@!!!",
        "@.",
        "@ab",
        "@TED@evil",
        "not a channel!!",
    ],
)
def test_references_that_are_no_channel_are_rejected_before_any_api_call(reference: str) -> None:
    with pytest.raises(ValueError, match="not a"):
        channel_lookup(reference)


def test_a_bare_name_is_a_legacy_username_and_the_error_suggests_the_handle() -> None:
    service = FakeYouTube()
    service._response = lambda _resource, _arguments: {"items": []}  # type: ignore[method-assign]
    scraper = YouTubeScraper("", service=service)

    with pytest.raises(ValueError, match="for a handle use @medical"):
        scraper.resolve_channel_id("medical")
    assert service.calls == [("channels", {"part": "id", "forUsername": "medical"})]


class FailingYouTube(FakeYouTube):
    def _response(self, resource: str, arguments: dict[str, Any]) -> dict[str, Any]:
        raise HttpError(
            httplib2.Response({"status": 403}),
            b'{"error": {"message": "quotaExceeded"}}',
            uri="https://youtube.googleapis.com/youtube/v3/channels?part=id&key=SECRET-KEY&alt=json",
        )


def test_api_errors_leave_the_scraper_without_the_api_key() -> None:
    scraper = YouTubeScraper("", service=FailingYouTube())

    with pytest.raises(HttpError) as error_info:
        scraper.scrape(ScrapeRequest(source=SourceName.YOUTUBE, channel="@medical"))

    assert error_info.value.status_code == 403
    assert "SECRET-KEY" not in str(error_info.value)
    assert "key=<redacted>" in str(error_info.value)


def uploads(*dates: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Videos named by their position, published at the given times, in playlist order."""
    videos = [video(f"v{index}", snippet={"publishedAt": date}) for index, date in enumerate(dates)]
    return videos, list(dates)


def scrape_channel(service: FakeYouTube, **arguments: Any) -> list[str]:
    request = ScrapeRequest(source=SourceName.YOUTUBE, channel=CHANNEL_ID, **arguments)
    return [document.source_id for document in YouTubeScraper("", service=service).scrape(request)]


def test_dropped_uploads_do_not_count_towards_max_results() -> None:
    start = datetime(2026, 10, 31, 12, tzinfo=UTC)
    dates = [(start - timedelta(hours=n)).strftime("%Y-%m-%dT%H:%M:%SZ") for n in range(53)]
    videos, published = uploads(*dates)
    for item in videos[:49]:
        item["snippet"]["liveBroadcastContent"] = "upcoming"
    service = FakeYouTube(videos, published)

    assert scrape_channel(service, max_results=3) == ["v49", "v50", "v51"]
    pages = [arguments for resource, arguments in service.calls if resource == "playlistItems"]
    assert [page.get("pageToken") for page in pages] == [None, "50"]


def test_since_keeps_uploads_made_public_late_and_puts_them_in_date_order() -> None:
    # The uploads playlist is in upload order: v2 was uploaded before v1 but made public later.
    service = FakeYouTube(
        *uploads("2026-10-01T10:00:00Z", "2026-08-01T10:00:00Z", "2026-09-15T10:00:00Z")
    )

    assert scrape_channel(service, since=date(2026, 9, 1)) == ["v0", "v2"]


def test_since_stops_after_a_run_of_earlier_uploads(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(youtube, "SINCE_LOOKAHEAD", 2)
    service = FakeYouTube(
        *uploads(
            "2026-10-01T10:00:00Z",
            "2026-08-01T10:00:00Z",
            "2026-08-02T10:00:00Z",
            "2026-09-20T10:00:00Z",
        )
    )

    assert scrape_channel(service, since=date(2026, 9, 1)) == ["v0"]


class NoUploadsYouTube(FakeYouTube):
    def _response(self, resource: str, arguments: dict[str, Any]) -> dict[str, Any]:
        if resource == "playlistItems":
            raise HttpError(
                httplib2.Response({"status": 404}),
                b'{"error": {"errors": [{"reason": "playlistNotFound"}]}}',
            )
        return super()._response(resource, arguments)


def test_a_channel_without_uploads_has_no_videos() -> None:
    assert scrape_channel(NoUploadsYouTube()) == []
