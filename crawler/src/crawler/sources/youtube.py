import os
import re
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import unquote, urlparse

from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from pydantic import JsonValue

from crawler.models import (
    Author,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
    source_document_id,
)
from crawler.sources.base import BaseScraper, redact_secrets
from crawler.sources.fields import iso8601_duration_seconds, language_tag

LICENCES = {"youtube": "youtube-standard", "creativeCommon": "CC-BY-3.0"}
"""`status.license`: YouTube's standard licence, or the CC BY licence uploaders can pick."""
RETENTION = timedelta(days=30)
"""YouTube data, IDs included, must be refreshed or deleted within 30 days."""
PAGE_SIZE = 50
"""Most items playlistItems.list and videos.list return per call; a call costs one unit."""
SINCE_LOOKAHEAD = 50
"""With `since`, scanning stops after this many earlier uploads in a row, not at the first:
the uploads playlist is in upload order, so a video made public weeks after its upload sits
deeper than its publication date suggests."""
YOUTUBE_HOSTS = frozenset(
    {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
)

_CHANNEL_ID = re.compile(r"UC[0-9A-Za-z_-]{22}")
_HANDLE = re.compile(r"@(?P<handle>[\w.-]{3,30})(?:[/?#].*)?")
"""`@name` (3–30 letters, digits, `_`, `-`, `.`), maybe with a channel tab or parameters."""
_USERNAME = re.compile(r"[0-9A-Za-z]+")


def channel_lookup(reference: str) -> tuple[str, str]:
    """How to find a channel: `("id", ID)`, `("forHandle", handle)` or `("forUsername", name)`.

    Accepts a channel ID, a channel URL (`/channel/ID`, `/@handle`, `/user/NAME`, also with a
    tab such as `/videos`), an `@handle` or a legacy username. Video, playlist and custom
    (`/c/NAME`) URLs and other hosts raise a ValueError: the Data API cannot resolve them,
    and guessing a handle from them can find another channel.
    """
    value = reference.strip()
    if _CHANNEL_ID.fullmatch(value):
        return "id", value
    if handle := _HANDLE.fullmatch(value):
        return "forHandle", handle["handle"]
    if _USERNAME.fullmatch(value):
        return "forUsername", value
    if value.startswith("@"):
        raise ValueError(f"not a YouTube handle: {reference!r}")
    if "/" not in value and "." not in value:
        raise ValueError(f"not a YouTube channel: {reference!r}")
    url = urlparse(value if "://" in value else f"https://{value}")
    if (url.hostname or "") not in YOUTUBE_HOSTS:
        raise ValueError(f"not a YouTube URL: {reference!r}")
    # Browsers copy handles in other scripts percent-encoded: `/@%E5%B0%8F…`.
    parts = [part for part in unquote(url.path).split("/") if part]
    if len(parts) >= 2 and parts[0] == "channel" and _CHANNEL_ID.fullmatch(parts[1]):
        return "id", parts[1]
    if len(parts) >= 2 and parts[0] == "user" and _USERNAME.fullmatch(parts[1]):
        return "forUsername", parts[1]
    if parts and (handle := _HANDLE.fullmatch(parts[0])):
        return "forHandle", handle["handle"]
    raise ValueError(
        f"not a channel URL: {reference!r}; use the channel ID or a /channel/, /@handle "
        "or /user/ URL"
    )


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
        try:
            channel_id = self.resolve_channel_id(request.channel)
            return self.latest_videos(channel_id, request.max_results, request.since)
        except HttpError as error:
            # Its message shows the request URL, API key included; every log would print it.
            if error.uri:
                error.uri = redact_secrets(error.uri)
            raise

    def resolve_channel_id(self, reference: str) -> str:
        kind, value = channel_lookup(reference)
        if kind == "id":
            return value
        response = self._service.channels().list(part="id", **{kind: value}).execute()
        items = response.get("items", [])
        if not items:
            hint = ""
            if kind == "forUsername" and "/" not in reference:
                hint = f" (a name without @ is a legacy username; for a handle use @{value})"
            raise ValueError(f"YouTube channel not found: {reference}{hint}")
        return str(items[0]["id"])

    def latest_videos(
        self, channel_id: str, limit: int, since: date | None = None
    ) -> list[SourceDocument]:
        """The newest public uploads, newest first.

        With `since`, earlier uploads are skipped until `SINCE_LOOKAHEAD` come in a row.
        Uploads that `parse_video` drops (not public, live, upcoming) do not count towards
        `limit`: later uploads fill their place.
        """
        documents: list[SourceDocument] = []
        for video_ids in self._upload_pages(self._uploads_playlist(channel_id), since):
            documents.extend(self.video_details(video_ids))
            if len(documents) >= limit:
                break
        # Uploads made public late are out of order; `publishedAt` is ISO 8601 in UTC.
        documents.sort(key=lambda document: document.published_at or "", reverse=True)
        return documents[:limit]

    def _uploads_playlist(self, channel_id: str) -> str:
        response = self._service.channels().list(part="contentDetails", id=channel_id).execute()
        channels = response.get("items", [])
        if not channels:
            raise ValueError(f"YouTube channel not found: {channel_id}")
        return str(channels[0]["contentDetails"]["relatedPlaylists"]["uploads"])

    def _upload_pages(self, uploads_id: str, since: date | None) -> Iterator[list[str]]:
        """The video IDs of the uploads playlist, page by page, without earlier uploads."""
        page_token: str | None = None
        earlier_in_a_row = 0
        while True:
            arguments: dict[str, Any] = {
                "part": "contentDetails",
                "playlistId": uploads_id,
                "maxResults": PAGE_SIZE,
            }
            if page_token:
                arguments["pageToken"] = page_token
            try:
                response = self._service.playlistItems().list(**arguments).execute()
            except HttpError as error:
                # A channel without uploads has no uploads playlist: no videos, no error.
                if page_token is None and error.status_code == 404:
                    return
                raise
            video_ids: list[str] = []
            for item in response.get("items", []):
                details = item["contentDetails"]
                published = str(details.get("videoPublishedAt") or "")
                if since and published and published[:10] < since.isoformat():
                    earlier_in_a_row += 1
                    if earlier_in_a_row >= SINCE_LOOKAHEAD:
                        break
                    continue
                earlier_in_a_row = 0
                video_ids.append(str(details["videoId"]))
            yield video_ids
            page_token = response.get("nextPageToken")
            if earlier_in_a_row >= SINCE_LOOKAHEAD or not page_token:
                return

    def video_details(self, video_ids: list[str]) -> list[SourceDocument]:
        """The public videos among the IDs, in the order of the IDs."""
        documents: list[SourceDocument] = []
        retrieved_at = datetime.now(UTC)
        for offset in range(0, len(video_ids), PAGE_SIZE):
            batch = video_ids[offset : offset + PAGE_SIZE]
            response = (
                self._service.videos()
                .list(part="snippet,contentDetails,status", id=",".join(batch))
                .execute()
            )
            parsed = [self.parse_video(item, retrieved_at) for item in response.get("items", [])]
            position = {video_id: index for index, video_id in enumerate(batch)}
            documents.extend(
                sorted(
                    (document for document in parsed if document is not None),
                    key=lambda document: position.get(document.source_id, len(batch)),
                )
            )
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
