# Zenodo

API research for #6, checked 2026-11-01 with live calls (official docs are outdated). What the crawler implements: [data sources](../../Documentation/design/sources.md#notes-per-source); where this page differs from the code, the code is right.

CERN's general repository (InvenioRDM). Anything can be uploaded, nothing is reviewed. Useful: preprints, conference papers, posters, presentations, reports, videos; many journal-article copies. Metadata CC0; licence and access status per record.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| Search `GET https://zenodo.org/api/records` | none; token raises page size 25 → 100 | 30 req/min, also with token; 10,000 results per query |
| `/api/records/{id}`, `/api/records/{id}/files/{key}/content` | none for open files | 133 req/min (live header; docs say 60) |
| OAI-PMH `https://zenodo.org/oai2d`, dumps `https://zenodo.org/api/exporter` | none | First full load only |

`X-RateLimit-*` and `Retry-After` on every response; 429 over the limit. Terms: non-military use, respect each licence. Needs an identifiable User-Agent; generic `curl`/`python-requests` may be blocked.

## Findings

Send `Accept: application/vnd.inveniordm.v1+json` (the legacy format lacks MeSH subjects and file media types). Search results already include the file list of open records.

Search:

- `q` is an Elasticsearch query string; **default operator OR** (`prostate cancer` 71,090 hits, `"prostate cancer"` 2,757). Use `AND` or phrases.
- New since last run: `updated:[2026-10-01 TO *]` in `q`.
- Type filter: `metadata.resource_type.id:(…)` in `q` or `type=publication&subtype=preprint`. `resource_type=publication-preprint` returns 0.
- Only the latest version per record is returned, so upserting on `parent.id` keeps the newest.

## Indexing proposal

Proposed in #6; the keyword indexer reads open files of the types listed in [keyword matching](../../Documentation/design/keyword-matching.md#full-texts), without a licence or checksum check, up to 50 MB.

1. Skip unless `access.status` = `open`, `files.enabled`, and licence, media type and size are allowed. All from the row.
2. `GET https://zenodo.org/api/records/{id}/files/{url-encoded key}/content`. `Content-Type` is always `application/octet-stream`; use the stored type. Check MD5.
3. Allow-list proposal: PDF, DOCX, PPTX, MP4 with a size cap per type (up to 100 files and 50 GB per record; videos 9–518 MB).
4. Several files: `files.default_preview` from `GET /api/records/{id}/files`, else the first allowed file.
5. MP4 needs speech-to-text (undecided) or metadata only. PDF is read with unpdf ([keyword matching](../../Documentation/design/keyword-matching.md#full-texts)); DOCX and PPTX need an extractor.

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
