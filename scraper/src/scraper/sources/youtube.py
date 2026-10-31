import os
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from googleapiclient.discovery import build

from scraper.models import (
    ScrapeRequest,
    SourceDocument,
    SourceName,
    SourceType,
    source_document_id,
)
from scraper.sources.base import BaseScraper


class YouTubeScraper(BaseScraper):
    """YouTube metadata scraper using only the official Data API v3."""

    source = SourceName.YOUTUBE

    def __init__(self, api_key: str, *, service: Any | None = None) -> None:
        if not api_key.strip() and service is None:
            raise ValueError("YOUTUBE_API_KEY is required")
        self._service = service or build(
            "youtube", "v3", developerKey=api_key, cache_discovery=False
        )

    @classmethod
    def from_env(cls) -> "YouTubeScraper":
        api_key = os.getenv("YOUTUBE_API_KEY") or os.getenv("YOUTUBE_DATA_API_V3") or ""
        return cls(api_key)

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source or not request.channel:
            raise ValueError("YouTube requires a YouTube request with a channel")
        channel_id = self.resolve_channel_id(request.channel)
        video_ids = self.video_ids(channel_id, request.max_results)
        return self.video_details(video_ids, request.channel)

    def resolve_channel_id(self, reference: str) -> str:
        value = reference.strip().rstrip("/")
        if value.startswith("UC") and "/" not in value:
            return value

        parsed = urlparse(value if "://" in value else f"https://youtube.com/{value}")
        path_parts = [part for part in parsed.path.split("/") if part]
        if len(path_parts) >= 2 and path_parts[-2] == "channel":
            return path_parts[-1]

        lookup: dict[str, str] = {"part": "id"}
        last_part = path_parts[-1] if path_parts else value
        if len(path_parts) >= 2 and path_parts[-2] == "user":
            lookup["forUsername"] = last_part
        else:
            lookup["forHandle"] = last_part.lstrip("@")
        response = self._service.channels().list(**lookup).execute()
        items = response.get("items", [])
        if not items:
            raise ValueError(f"YouTube channel not found: {reference}")
        return str(items[0]["id"])

    def video_ids(self, channel_id: str, limit: int) -> list[str]:
        channel_response = (
            self._service.channels().list(part="contentDetails", id=channel_id).execute()
        )
        channels = channel_response.get("items", [])
        if not channels:
            raise ValueError(f"YouTube channel not found: {channel_id}")
        uploads_id = channels[0]["contentDetails"]["relatedPlaylists"]["uploads"]

        identifiers: list[str] = []
        page_token: str | None = None
        while len(identifiers) < limit:
            arguments: dict[str, Any] = {
                "part": "contentDetails",
                "playlistId": uploads_id,
                "maxResults": min(50, limit - len(identifiers)),
            }
            if page_token:
                arguments["pageToken"] = page_token
            response = self._service.playlistItems().list(**arguments).execute()
            identifiers.extend(
                str(item["contentDetails"]["videoId"]) for item in response.get("items", [])
            )
            page_token = response.get("nextPageToken")
            if not page_token:
                break
        return identifiers[:limit]

    def video_details(self, video_ids: list[str], query: str) -> list[SourceDocument]:
        documents: list[SourceDocument] = []
        retrieved_at = datetime.now(UTC)
        for offset in range(0, len(video_ids), 50):
            batch = video_ids[offset : offset + 50]
            response = (
                self._service.videos()
                .list(part="snippet,contentDetails,statistics", id=",".join(batch))
                .execute()
            )
            for item in response.get("items", []):
                snippet = item.get("snippet", {})
                statistics = item.get("statistics", {})
                source_id = str(item["id"])
                channel_title = str(snippet.get("channelTitle", "")).strip()
                keywords = [str(tag) for tag in snippet.get("tags", [])]
                view_count = statistics.get("viewCount")
                documents.append(
                    SourceDocument(
                        id=source_document_id(self.source, source_id),
                        source=self.source,
                        source_type=SourceType.VIDEO,
                        source_id=source_id,
                        title=str(snippet.get("title", "")).strip(),
                        url=f"https://www.youtube.com/watch?v={source_id}",
                        authors=[channel_title] if channel_title else [],
                        description=str(snippet.get("description", "")).strip() or None,
                        published_at=snippet.get("publishedAt"),
                        channel_id=str(snippet.get("channelId", "")).strip() or None,
                        duration=str(item.get("contentDetails", {}).get("duration", "")).strip()
                        or None,
                        view_count=int(view_count) if view_count is not None else None,
                        keywords=keywords,
                        query_keywords=[query],
                        retrieved_at=retrieved_at,
                        refresh_after=retrieved_at + timedelta(days=30),
                    )
                )
        return documents
