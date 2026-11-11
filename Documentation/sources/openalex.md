# OpenAlex

Checked 11.11.2026. Shared rules: [README](README.md).

Full-text route for [PubMed](pubmed.md) rows that [PMC](pmc.md) does not hold (#57). No rows of its own; fills `full_text`, `licence` (if PMC gave none) and `external_ids.openalex` of the PubMed row. OpenAlex lists, per DOI, where a paper can be read: publisher sites, repositories and preprint servers, each with a licence. In a 50-paper sample ("prostate cancer", by relevance) the PubMed rows with a full-text link went from 9 (PMC) to 17.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| `https://api.openalex.org/works?filter=doi:<a>\|<b>…&select=id,doi,best_oa_location,locations` | optional `api_key` | Up to 100 values per filter; $0.0001 per request. Without a key one $0.10 budget per day shared by the IP address (`x-ratelimit-limit: 1000` on 11.11.2026), with a free key $1 per day |

The crawler asks for 50 DOIs per request and waits one second between requests, which stays below the per-second limits of the help pages. `OPENALEX_API_KEY` in `crawler/.env` is optional; the key goes in the query string, and `redact_secrets` hides it in error messages.

## Connectors

- **crawler** `crawler/src/crawler/sources/openalex.py`, called from `sources/pubmed.py` after PMC: one batch request for the records of a PubMed request that have a DOI but no full text.

## Fields

| Schema field | Source | Note |
|---|---|---|
| `full_text` | `best_oa_location`, then `locations[]`: `pdf_url` of locations with `is_oa` | `kind: pdf`, `media_type: application/pdf`; duplicates dropped, at most three |
| `licence` | `license` of the first kept location | `cc-by-nc` → `CC-BY-NC` (no version, like PMC); `cc0` → `CC0-1.0`; `publisher-specific-oa`, `other-oa` and none → empty |
| `external_ids.openalex` | `id` | e.g. `W4309…` |

Left out:

- Locations without `pdf_url`: their `landing_page_url` is an article page, not a file.
- `content_urls` (OpenAlex's own PDF and GROBID XML): downloading them needs an API key, which a stored URL must not hold, and the indexers would need it too.

## Indexing

1. The indexers try the locators in their order ([keyword matching](../keyword-matching.md#full-texts)); they are read as PDFs, with the default budget of 3 s per host.
2. Publisher sites may refuse automated downloads (403) or answer with an HTML page; such documents keep their metadata only. Measure the readable share with the Index screen of the [debug UI](../../debug/crawler/README.md).

## To be aware of

- `is_oa` includes "bronze" copies: free to read on the publisher site without an open licence (e.g. NEJM), so `licence` stays empty and each approach decides by its own rules.
- An OpenAlex error (budget used up, 429, server error) only logs a warning: the records keep the PMC result, and the next run of a search asks again. Stored cited papers are not asked again.
- The first locator may be a different version than the PubMed record (`version`: submitted, accepted or published).

## Sources

- API: https://help.openalex.org/
- Rate limits and keys: https://help.openalex.org/access/pricing/
- Work object, locations: https://help.openalex.org/data/works/attributes/
