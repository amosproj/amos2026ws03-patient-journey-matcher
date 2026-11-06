# YouTube

Checked 01.11.2026 (API pages and Developer Policies dated 15.10.2026). Shared rules: [README](README.md).

Data API v3: metadata of public videos and channels. No transcripts of others' videos, no video files. API key only, so all data is "Non-Authorized Data".

## Access

| Call | Use | Quota |
|---|---|---|
| `channels.list` | Uploads playlist ID of a curated channel | 1 unit |
| `playlistItems.list` | Uploads in upload order, so a video made public late sits deeper; no date filter: skip uploads with an earlier `contentDetails.videoPublishedAt`, stop after 50 in a row | 1 unit per 50 |
| `videos.list` | Metadata, 50 IDs per call | 1 unit |
| `search.list` | Not needed for curated channels | Own 100 calls/day since 01.06.2026; 500 videos per channel search |
| `captions.list`, `captions.download` | Need OAuth and edit rights | Not usable |

Default 10,000 units/day plus the 100 `search.list` calls, reset at midnight Pacific. More needs a compliance audit.

## Connectors

- **SS26** `backend/scrapers/…/YouTube`: captions via the internal player API (scraping, III.E.6, III.I.8); stores transcripts and view counts forever. Drop that part.
- **crawler** `crawler/src/crawler/sources/youtube.py`: official API, the fields below, no statistics. The refresh-or-delete job is #41.

## Fields

Request `videos.list?part=snippet,contentDetails,status&id=…`. Every stored value, IDs included, is refreshed or deleted within 30 days (III.E.4.d); refresh costs 1 unit per 50 videos. Gone videos are deleted with their index rows; treat index rows as API Data that expires with the document.

| Schema field | Path | Note |
|---|---|---|
| `native_id` | `id` | `id` = `youtube:<videoId>` |
| `content_type` | constant `video` | |
| `title` | `snippet.title` | Shown unmodified |
| `authors`, `venue` | `snippet.channelTitle` | Shown unmodified |
| `summary` | `snippet.description` | Main index text; `00:00` timestamps = chapters |
| `subjects` | `snippet.tags[]` | Often empty |
| `language` | `snippet.defaultAudioLanguage`, else `defaultLanguage` | Often missing |
| `published_at` | `snippet.publishedAt` | |
| `duration_seconds` | `contentDetails.duration` | ISO 8601 |
| `canonical_url` | `https://www.youtube.com/watch?v={id}` | |
| `external_ids.channel_id` | `snippet.channelId` | |
| `licence` | `status.license` | `youtube` → `youtube-standard`; `creativeCommon` = CC BY. Not about our storage rights |
| `expires_at` | `retrieved_at` + 30 days | |
| `extra` | `status.privacyStatus` (keep `public`), `status.embeddable`, `status.madeForKids`, `snippet.liveBroadcastContent` (skip `live`, `upcoming`), `snippet.thumbnails.medium.url` | Thumbnail shown with each result |

Don't store `statistics`: unneeded, max 30 days, never in a score (III.E.4.b, III.E.4.h).

## Indexing

- No transcripts: captions need edit rights; scraping breaks the terms. Index title, description, tags and parsed chapters.
- Gemini on Vertex AI takes a public YouTube URL as `fileUri` (one per request, about 45 min with audio); nothing kept. Not verified whether summarising third-party videos for our index is allowed.

## To be aware of

- Label every YouTube item as YouTube, each with its own attribution (III.F.2.a); never merge with other data. Title, thumbnail and channel unmodified, with a YouTube icon.
- No popularity ranking (III.E.4.h).
- Embeds: `https://www.youtube.com/embed/{id}?start={seconds}`, at least 200 × 200 px, HTTP `Referer` required (empty in app WebViews), tracking off for made-for-kids.
- High-risk clause III.I.10 (death or injury); AIlixir to confirm educational videos are outside it.
- YouTube health labels are not in the API; trust rests on the curated channel list.

## Sources

- Developer Policies: https://developers.google.com/youtube/terms/developer-policies
- Policies guide: https://developers.google.com/youtube/terms/developer-policies-guide
- Quota costs: https://developers.google.com/youtube/v3/determine_quota_cost
- Videos: https://developers.google.com/youtube/v3/docs/videos/list
- Vertex AI video: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/video-understanding
