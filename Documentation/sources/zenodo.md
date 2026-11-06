# Zenodo

Checked 01.11.2026 with live calls (official docs are outdated). Shared rules: [README](README.md).

CERN's general repository (InvenioRDM). Anything can be uploaded, nothing is reviewed. Useful: preprints, conference papers, posters, presentations, reports, videos; many journal-article copies. Metadata CC0; licence and access status per record.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| Search `GET https://zenodo.org/api/records` | none; token raises page size 25 → 100 | 30 req/min, also with token; 10,000 results per query |
| `/api/records/{id}`, `/api/records/{id}/files/{key}/content` | none for open files | 133 req/min (live header; docs say 60) |
| OAI-PMH `https://zenodo.org/oai2d`, dumps `https://zenodo.org/api/exporter` | none | First full load only |

`X-RateLimit-*` and `Retry-After` on every response; 429 over the limit. Terms: non-military use, respect each licence. Needs an identifiable User-Agent; generic `curl`/`python-requests` may be blocked.

## Connectors

**crawler** `crawler/src/crawler/sources/zenodo.py`: search, the fields and resource types below; `--since` by `updated`.

## Fields

Send `Accept: application/vnd.inveniordm.v1+json` (the legacy format lacks MeSH subjects and file media types). Search results already include the file list of open records.

| Schema field | Path | Note |
|---|---|---|
| `native_id` | `parent.id` | Concept ID, same across versions; `id` = `zenodo:<parent.id>` |
| `version` | `id` | Version record ID; builds file URLs |
| `content_type` | `metadata.resource_type.id` | `publication-article` → `journal_article`, `publication-preprint` → `preprint`, `publication-conferencepaper` → `conference_paper`, `publication-report` → `report`, `poster`, `presentation`, `video`; skip others |
| `title` | `metadata.title` | |
| `authors` | `metadata.creators[].person_or_org.name`, `.identifiers` (`orcid`), `affiliations[].name` | |
| `summary` | `metadata.description` | HTML; strip tags |
| `language` | `metadata.languages[].id` | ISO 639-3; missing on about 60 % |
| `subjects` | `metadata.subjects[]`: `{subject}` or `{id, subject, scheme}` (e.g. `mesh:D016875`) | |
| `published_at` | `metadata.publication_date` | EDTF: `2026`, `2026-09`, `2026-09-13` or interval |
| `source_updated_at` | `updated` | |
| `canonical_url` | `links.self_html` | |
| `doi` | `pids.doi.identifier` | Zenodo's version DOI, not the journal DOI |
| `external_ids.concept_doi` | `parent.pids.doi.identifier` | Resolves to latest version |
| `licence` | `metadata.rights[].id` | `cc-by-4.0` → `CC-BY-4.0` |
| `full_text` | `files.entries.<key>`: `key`, `size`, `mimetype`, `checksum` (`md5:…`) | Allowed types only |
| `extra` | `access.status`, `access.embargo.until`, `files.enabled`, `parent.communities.entries[].slug`, `metadata.related_identifiers[]` | `related_identifiers` may hold the journal DOI |

Search:

- `q` is an Elasticsearch query string; **default operator OR** (`prostate cancer` 71,090 hits, `"prostate cancer"` 2,757). Use `AND` or phrases.
- New since last run: `updated:[2026-10-01 TO *]` in `q`.
- Type filter: `metadata.resource_type.id:(…)` in `q` or `type=publication&subtype=preprint`. `resource_type=publication-preprint` returns 0.
- Only the latest version per record is returned, so upserting on `parent.id` keeps the newest.

## Indexing

1. Skip unless `access.status` = `open`, `files.enabled`, and licence, media type and size are allowed. All from the row.
2. `GET https://zenodo.org/api/records/{id}/files/{url-encoded key}/content`. `Content-Type` is always `application/octet-stream`; use the stored type. Check MD5.
3. Allow-list proposal: PDF, DOCX, PPTX, MP4 with a size cap per type (up to 100 files and 50 GB per record; videos 9–518 MB).
4. Several files: `files.default_preview` from `GET /api/records/{id}/files`, else the first allowed file.
5. MP4 needs speech-to-text (undecided) or metadata only. PDF, DOCX, PPTX need a TypeScript extractor.

## To be aware of

- Page × size above 10,000 returns 400; slice by `updated` or `publication_date`.
- No review; AI-generated series appear (1,139 records in one `prostate cancer` facet). Filter by type; communities and journal DOIs signal quality.
- Most articles are probably also in PubMed under another DOI; they match only via `related_identifiers` or title hash.
- Licences (3,241 `prostate AND cancer` records): CC BY 4.0 2,470, NC 245 (8 %), SA 27, CC0 82; all had one.
- Embargoed files go public on `access.embargo.until` without a new version; re-check them.

## Sources

- API: https://developers.zenodo.org/
- InvenioRDM records API: https://inveniordm.docs.cern.ch/reference/rest_api_drafts_records/
- Search syntax: https://help.zenodo.org/guides/search/
- Terms: https://about.zenodo.org/terms/
- User-Agent rules: https://blog.zenodo.org/2026/09/15/2026-09-15-stability-and-performance-updates/
