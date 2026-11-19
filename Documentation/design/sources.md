# Data sources

What the crawler collects and from where. The crawler stores metadata and links only; the indexer reads full texts in memory and never stores them ([architecture](architecture.md)). The stored columns: [storage](storage.md#documents). API research and measured coverage per source: [research](../../research/sources/README.md).

## Overview

| Source | What | Key in `crawler/.env` | Full text the indexer reads |
|---|---|---|---|
| PubMed | Citations and abstracts with MeSH terms | `NCBI_ENTREZ_EMAIL` (recommended), `NCBI_API_KEY` (optional) | JATS XML from the PMC bucket if it has the article, else an open-access PDF found by OpenAlex |
| PMC | Full-text links for PubMed records; no rows of its own | none | JATS XML from the PMC bucket |
| OpenAlex | Open-access PDF links for PubMed records without PMC; no rows of its own | `OPENALEX_API_KEY` (optional) | PDF on the publisher or repository site |
| arXiv | Preprints | none; `SEMANTIC_SCHOLAR_API_KEY` for references | HTML page, else the PDF |
| Zenodo | Research output of seven resource types, without peer review | none | The preview file first: PDF, XML, HTML or text |
| YouTube | Metadata of curated channels | `YOUTUBE_API_KEY` (required) | none |
| Podcasts | Episodes of curated RSS feeds | none | Transcript, else the audio with speech-to-text |

How the full texts are read: [keyword matching](keyword-matching.md#full-texts). The queries, channels and feeds are in the [topic files](../../crawler/README.md#topic-files).

## Notes per source

**PubMed**
- `NCBI_REQUESTS_PER_SECOND` sets the pace ([request budgets](#request-budgets)). The limit is per key, so machines that crawl with the same key at once share it.
- At most 9,999 IDs per query; `--since` filters by the entry date.
- Books and chapters are stored as `content_type: book` with `external_ids.bookshelf_id`.
- References (`--max-depth 1`) come from NCBI ELink.

**PMC**
- The PubMed crawler adds the JATS XML link from the PMC bucket (S3) to records with a PMCID: a non-manuscript version first, else the highest version.
- Licence codes: `CC0` becomes `CC0-1.0`, `CC BY-NC` becomes `CC-BY-NC`, `TDM` becomes `pmc-tdm`, none stays empty.
- The PMC website forbids automated downloads, so only the bucket is used.

**OpenAlex**
- For PubMed records without a PMC link, the crawler asks OpenAlex for open-access copies by DOI: 50 DOIs per request, at most 3 PDF links per record.
- Hosts that refuse automated downloads are on a blocklist (`NO_AUTOMATED_DOWNLOAD` in [`openalex.py`](../../crawler/src/crawler/sources/openalex.py)).
- Errors only warn; the record is stored without the link.

**arXiv**
- `--since` filters by the submission date, so new versions of older papers are missed.
- References come from Semantic Scholar.

**Zenodo**
- The crawler waits 2 s between requests; 25 results per page, at most 10,000 per query.
- Zenodo combines search words with OR by default, so the crawler quotes the words and joins them with AND.
- `native_id` is the concept ID, `version` the record ID.
- Files only for open records with files enabled, the preview file first; embargo date and communities go to `extra`.

**YouTube**
- Metadata only: no transcripts, no view counts. `search.list` is not used.
- Stored videos expire after 30 days. Every `--store` run refreshes the videos of its channels that expire within 15 days and deletes expired rows.
- Non-public, live and upcoming videos are skipped. Licence: `youtube-standard` or `CC-BY-3.0`.

**Podcasts**
- One plain request per feed and run; `--since` filters episodes by their publication date. Feed list: [podcasts research](../../research/sources/podcasts.md#curated-feed-list).
- An episode without a `guid` gets `enc:` plus the SHA-256 of its audio URL as ID.
- Show notes are cut to 1,000 characters, because some contain whole transcripts.
- Licence: the feed's `podcast:license`, else `all-rights-reserved` if it has a copyright notice.
- Full-text links: transcripts first, then the audio file; trailers are skipped. Audio without a transcript is read by the [transcription job](keyword-matching.md#speech-to-text); M4A and MP4 audio is not read.

## Licences

- `licence` holds an SPDX ID or an own code ([storage](storage.md#documents)); empty means unknown.
- The licence covers the full text, not the metadata: arXiv and Zenodo metadata is CC0, PubMed metadata is under NLM terms. Every record stays findable and linkable, whatever its licence.
- Licences differ per record, also within one data source: PMC mixes CC BY and NC licences in one bucket.
- The indexer checks no licence today: the keyword approach reads full texts under any licence and keeps keywords only ([keyword matching](keyword-matching.md#full-texts)). Each approach sets its own rules. The project is non-profit, so sources are used as far as their licences allow non-commercial use ([choices](architecture.md#choices)); an allow-list proposal is in [research](../../research/sources/README.md#licence-allow-list-proposal).

## Request budgets

Shared per key or host by the crawler and the indexer.

| Budget | Limit | Used by |
|---|---|---|
| NCBI E-utilities | 5 requests a second with our key, 3 without | PubMed crawler and its references |
| arXiv API and OAI-PMH | 1 request every 3 s | arXiv crawler, one licence lookup per paper included |
| arxiv.org pages | `Crawl-delay: 15` in its robots.txt | Indexer |
| Zenodo | 30 searches a minute; the indexer fetches one file a second | Crawler, indexer |
| YouTube Data API | 10,000 units a day | Crawler |
| Semantic Scholar | 1 request a second with a key | arXiv references |
| OpenAlex | Small daily budget per IP address without a key; the crawler sends one request a second | PubMed crawler, `crawler refresh` |
| PMC bucket | None published; 0.1 s between requests | Crawler, indexer |
| Podcast hosts and other hosts | None published; 3 s between requests | Crawler, indexer |

## Storage and retention

- **Stored:** the `documents` row and the index rows only. Never full texts, PDFs, audio, video or transcripts.
- **Crawler state:** the curated topics, channels and feeds in `crawler/topics/`, and the run log `crawl_runs`.
- **YouTube:** data, IDs included, is refreshed or deleted within 30 days; view counts are not stored and never used in a score.
- **Identification:** the requests that the crawler and the indexer build themselves send a User-Agent with the app name, version and repository URL. NCBI requests send `tool` and `email` instead; the arXiv search and YouTube use client libraries with their own User-Agent.
- **Attribution when results are shown:** name NLM for PubMed; credit arXiv with "Thank you to arXiv for use of its open access interoperability."; credit the authors of CC BY works; show YouTube items with their unchanged title, thumbnail and channel; no NLM, PMC or arXiv logos.

## Identity and duplicates

- `id` is stable across versions; `found_by` and `retrieved_at` record how and when a record came in.
- Records from different data sources are not merged or grouped yet; `doi` has a database index for that. YouTube items are never merged with other data.
