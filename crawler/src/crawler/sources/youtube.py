import os
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from googleapiclient.discovery import build
from pydantic import JsonValue

from crawler.models import (
    Author,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
    source_document_id,
)
from crawler.sources.base import BaseScraper
from crawler.sources.fields import iso8601_duration_seconds, language_tag

LICENCES = {"youtube": "youtube-standard", "creativeCommon": "CC-BY-3.0"}
"""`status.license`: YouTube's standard licence, or the CC BY licence uploaders can pick."""
RETENTION = timedelta(days=30)
"""YouTube data, IDs included, must be refreshed or deleted within 30 days."""


class YouTubeScraper(BaseScraper):
    """Metadata of the latest public uploads of a curated channel, official Data API v3 only.

    No transcripts (captions need the owner's OAuth) and no statistics (not needed, and
    never allowed in a ranking).
    """

    source = SourceName.YOUTUBE

    def __init__(self, api_key: str, *, service: Any | None = None) -> None:
        if not api_key.strip() and service is None:
            raise ValueError("YOUTUBE_API_KEY is required")
        self._service = service or build(
            "youtube", "v3", developerKey=api_key, cache_discovery=False
        )

    @classmethod
    def from_env(cls) -> "YouTubeScraper":
        api_key = os.getenv("YOUTUBE_API_KEY") or ""
        return cls(api_key)

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        if request.source is not self.source or not request.channel:
            raise ValueError("YouTube requires a YouTube request with a channel")
        channel_id = self.resolve_channel_id(request.channel)
        video_ids = self.video_ids(channel_id, request.max_results, request.since)
        return self.video_details(video_ids)

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

    def video_ids(self, channel_id: str, limit: int, since: date | None = None) -> list[str]:
        """The newest uploads first; with `since`, stop at the first older video."""
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
            for item in response.get("items", []):
                details = item["contentDetails"]
                published = str(details.get("videoPublishedAt") or "")
                if since and published and published[:10] < since.isoformat():
                    return identifiers[:limit]
                identifiers.append(str(details["videoId"]))
            page_token = response.get("nextPageToken")
            if not page_token:
                break
        return identifiers[:limit]

    def video_details(self, video_ids: list[str]) -> list[SourceDocument]:
        documents: list[SourceDocument] = []
        retrieved_at = datetime.now(UTC)
        for offset in range(0, len(video_ids), 50):
            batch = video_ids[offset : offset + 50]
            response = (
                self._service.videos()
                .list(part="snippet,contentDetails,status", id=",".join(batch))
                .execute()
            )
            for item in response.get("items", []):
                document = self.parse_video(item, retrieved_at)
                if document is not None:
                    documents.append(document)
        return documents

    @classmethod
    def parse_video(cls, item: dict[str, Any], retrieved_at: datetime) -> SourceDocument | None:
        """None for videos that are not public, and for live or upcoming streams."""
        snippet = item.get("snippet", {})
        status = item.get("status", {})
        if status.get("privacyStatus", "public") != "public":
            return None
        if snippet.get("liveBroadcastContent", "none") in {"live", "upcoming"}:
            return None
        source_id = str(item["id"])
        channel_title = str(snippet.get("channelTitle", "")).strip()
        thumbnails = snippet.get("thumbnails", {})
        thumbnail = (thumbnails.get("medium") or thumbnails.get("default") or {}).get("url")
        extra: dict[str, JsonValue] = {
            key: value
            for key, value in (
                ("thumbnail", thumbnail),
                ("embeddable", status.get("embeddable")),
                ("made_for_kids", status.get("madeForKids")),
            )
            if value is not None
        }
        return SourceDocument(
            id=source_document_id(cls.source, source_id),
            source=cls.source,
            content_type="video",
            source_id=source_id,
            title=str(snippet.get("title", "")).strip(),
            url=f"https://www.youtube.com/watch?v={source_id}",
            authors=[Author(name=channel_title)] if channel_title else [],
            description=str(snippet.get("description", "")).strip() or None,
            language=language_tag(
                snippet.get("defaultAudioLanguage") or snippet.get("defaultLanguage")
            ),
            published_at=snippet.get("publishedAt"),
            channel_id=str(snippet.get("channelId", "")).strip() or None,
            duration_seconds=iso8601_duration_seconds(
                item.get("contentDetails", {}).get("duration")
            ),
            subjects=[
                Subject(scheme="youtube-tag", label=str(tag).strip())
                for tag in dict.fromkeys(snippet.get("tags", []))
                if str(tag).strip()
            ],
            licence=LICENCES.get(str(status.get("license", ""))),
            extra=extra,
            retrieved_at=retrieved_at,
            refresh_after=retrieved_at + RETENTION,
        )
