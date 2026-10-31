from collections.abc import Callable
from typing import Any

from scraper.models import ScrapeRequest, SourceName
from scraper.sources.youtube import YouTubeScraper


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


class FakeYouTube:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

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
            return {"items": [{"contentDetails": {"videoId": "video-1"}}]}
        if resource == "videos":
            return {
                "items": [
                    {
                        "id": "video-1",
                        "snippet": {
                            "title": "Treatment update",
                            "description": "Official channel description",
                            "channelTitle": "Medical Channel",
                            "channelId": "UC-example",
                            "publishedAt": "2026-10-31T10:00:00Z",
                            "tags": ["oncology"],
                        },
                        "contentDetails": {"duration": "PT5M"},
                        "statistics": {"viewCount": "100"},
                    }
                ]
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
    assert len(documents) == 1
    document = documents[0]
    assert document.id == "youtube:video-1"
    assert document.description == "Official channel description"
    assert document.abstract is None
    assert document.channel_id == "UC-example"
    assert document.duration == "PT5M"
    assert document.view_count == 100
    assert document.refresh_after is not None
    assert (document.refresh_after - document.retrieved_at).days == 30


def test_resolve_handle_uses_the_official_channels_endpoint() -> None:
    service = FakeYouTube()
    scraper = YouTubeScraper("", service=service)

    assert scraper.resolve_channel_id("@medical") == "UC-example"
    assert service.calls == [("channels", {"part": "id", "forHandle": "medical"})]
