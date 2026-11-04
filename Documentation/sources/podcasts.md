# Podcasts (RSS feeds)

Checked 01.11.2026 against the specs and the live feeds. Shared rules: [README](README.md).

RSS 2.0 file per show, one `<item>` per episode. No API, key or quota; one GET per feed. Hand-curated [feed list](#curated-feed-list), no discovery. Namespaces read: RSS core, `itunes:`, `podcast:` (`guid`, `transcript`, `chapters`, `person`, `license`), `content:encoded`, `atom:link rel="self"`.

| Feed | Publisher | Episodes | Transcripts |
|---|---|---|---|
| [JCO Podcast](https://jcopodcast.libsyn.com/rss) | ASCO | 470 | In show notes of 30 of newest 50 |
| [Cancer.Net Podcast](https://cancernet.libsyn.com/rss) | ASCO (patients) | 175, dormant since 13.03.2024 | In show notes |
| [ASCO Daily News](https://ascodailynews.libsyn.com/rss) | ASCO | 100 | In show notes of 26 of newest 50 |
| [Lancet Oncology in conversation with](https://feed.podbean.com/lancetonc/feed.xml) | The Lancet Group | 82 | `podcast:transcript` on 5 (SRT, "AI-generated") |
| [NEJM This Week](https://podcast.nejm.org/nejm_audio_summaries.xml) | NEJM Group | 22 (latest only) | none |
| [Medicine and Science from The BMJ](https://feed.podbean.com/thebmjpodcast/feed.xml) | BMJ | 1,070 | none |

All English, unique `guid` on every item, 304 on conditional GET. None uses `podcast:guid`, `license`, `person` or `chapters`. None grants a licence.

## Connectors

**crawler** `crawler/src/crawler/sources/podcast.py`: the fields below, read with the standard library (feedparser garbles `podcast:*` tags). The feeds are listed in the topic files (`podcasts:`). Conditional GET and redirect handling need the feed state table and are not done yet.

## Fields

Feed state (crawler table): feed key, current URL, `ETag`, `Last-Modified`, last status.

| Schema field | RSS tag | Note |
|---|---|---|
| `native_id` | `{feed key}:{guid}` | `id` = `podcast:{feed key}:{guid}` |
| `content_type` | constant `podcast_episode` | |
| `title` | `item/title` | |
| `authors` | `podcast:person`, item `itunes:author` | Often missing |
| `venue` | `channel/title` | |
| `summary` | `content:encoded`, else `description` | Plain text, cut at 1,000 characters |
| `language` | `channel/language` | |
| `published_at` | `pubDate` | RFC 822 |
| `duration_seconds` | `itunes:duration` | `401` or `22:15` |
| `canonical_url` | `item/link` | Must be http(s) |
| `external_ids.feed_key` | curated list | |
| `licence` | `podcast:license`, else `channel/copyright` | `all-rights-reserved` for all six |
| `full_text` | every `podcast:transcript` (`@url`, `@type`, `@language`, `@rel`), then enclosure (`@url`, `@type`, `@length`) | Several transcript formats possible |
| `extra` | `podcast:chapters@url`, `itunes:episodeType` (skip trailers), DOIs in show notes | 48 of newest 50 JCO episodes cite a DOI |

- **guid:** keep exactly as sent (case-sensitive), only trim; never parse. Formats are mixed (`Buzzsprout-6186427`, `22990 at https://www.cancer.net`). No guid: `enc:` + SHA-256 of the enclosure URL (weak: ASCO URLs pass a tracking redirect that changes with the host). Neither: skip.
- **Show notes can be transcripts:** ASCO's run 1,240–3,960 words (median), so the crawler cuts them; the indexer reads full notes from the feed.
- **HTTP:** store `ETag`/`Last-Modified` as received, send both back (Podbean sends only ETag, ASCO Daily News only Last-Modified). 301, 308 or differing `itunes:new-feed-url`: store new URL, tell a maintainer. 302, 307: keep listed URL. 410: stop and flag.

## Indexing

`download()` tries in memory:

1. `podcast:transcript`: VTT, then SRT, JSON, HTML, text. Strip timecodes, keep speakers. Match types loosely (Lancet declares `application/srt`, serves `application/x-subrip`).
2. Show notes (`content:encoded`, else `description`): full text for ASCO; others 60–190 words. Feeds are not archives (NEJM keeps 22), so notes are re-readable only while listed. Other ASCO transcripts are on ascopubs.org (terms not checked).
3. Speech-to-text: undecided. About 715 h back catalogue, 66 h new a year; $0.003–0.006/min (OpenAI) = $130–260 once, $12–24 a year. A transcript is a copy, see [open questions](open-questions.md).

## Curated feed list

One hand-edited YAML file in the crawler, like the topic files:

```yaml
- key: jco                    # stable and unique; used in episode IDs, never reused
  url: https://jcopodcast.libsyn.com/rss
  publisher: American Society of Clinical Oncology (ASCO)
  audience: clinicians        # clinicians | patients
  topics: [oncology]          # disease areas, same names as the topic files
  language: en
  trusted_because: Official podcast of ASCO's peer-reviewed Journal of Clinical Oncology.
```

`publisher` replaces the unreliable `itunes:author`; `topics` replaces `itunes:category` ("Medicine" for all six).

## To be aware of

- feedparser: several `podcast:transcript` keep only the last (#301); attribute tags lose text (`podcast:person` name, `podcast:license` ID); `itunes:summary` overwrites `description` (#324); permalink guid without `<link>` becomes `entry.link`.
- Libsyn ASCO feeds embed `<string-array><item>`, giving empty entries (757 for 470 in JCO); skip entries without guid and enclosure.
- Dormant feeds still answer; review the list periodically.
- Crawlee 1.11 passes 304 to the handler, raises on 410; not verified whether it exposes 301 vs 302.
- No host publishes a rate limit; the crawler evaluation's 20 req/min is our own politeness limit.

## Sources

- RSS 2.0: https://www.rssboard.org/rss-specification
- Apple requirements: https://podcasters.apple.com/support/823-podcast-requirements
- Podcasting 2.0: https://github.com/Podcastindex-org/podcast-namespace/blob/main/docs/1.0.md
- HTTP caching: https://www.rfc-editor.org/rfc/rfc9110, https://www.rfc-editor.org/rfc/rfc9111
- feedparser issues: https://github.com/kurtmckee/feedparser/issues/301, https://github.com/kurtmckee/feedparser/issues/324
- Prices: https://developers.openai.com/api/docs/pricing
