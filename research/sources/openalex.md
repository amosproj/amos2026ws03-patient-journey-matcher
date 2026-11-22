# OpenAlex

API research for #6, checked 2026-11-11. What the crawler implements: [data sources](../../Documentation/design/sources.md#notes-per-source); where this page differs from the code, the code is right.

Full-text route for [PubMed](pubmed.md) rows that [PMC](pmc.md) does not hold (#57). No rows of its own; fills `full_text`, `licence` (if PMC gave none) and `external_ids.openalex` of the PubMed row. OpenAlex lists, per DOI, where a paper can be read: publisher sites, repositories and preprint servers, each with a licence. In the seed crawl (`make seed`, 11.11.2026) the PubMed rows with a full-text link went from 195 of 586 (33 %, PMC) to 275 of 588 (47 %); [coverage](README.md#seed-crawl-2026-11-11-57). In an earlier 50-paper sample, 3 of 4 new PDFs downloaded; the fourth site answered with an HTML page.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| `https://api.openalex.org/works?filter=doi:<a>\|<b>…&select=id,doi,best_oa_location,locations` | optional `api_key` | Up to 100 values per filter; $0.0001 per request. Without a key one $0.10 budget per day shared by the IP address (`x-ratelimit-limit: 1000` on 11.11.2026), with a free key $1 per day |

The crawler asks for 50 DOIs per request and waits one second between requests, its own choice. `OPENALEX_API_KEY` in `crawler/.env` is optional; the key goes in the query string, and `redact_secrets` hides it in error messages.

## Findings

Left out:

- Locations without `pdf_url`: their `landing_page_url` is an article page, not a file.
- PDFs on hosts in `NO_AUTOMATED_DOWNLOAD`, with their subdomains: the PMC website (its terms forbid automated downloads; PMC full text comes from the [S3 bucket](pmc.md)), and hosts confirmed to answer automated PDF downloads with HTTP 403. The 14.11.2026 seed measurement found 33 such PDFs across 22 additional hosts, all confirmed on a second download attempt, with no successes on those hosts in the same sample. ScienceDirect was also confirmed in the earlier 50-paper check. The list lives beside the client, so it can be updated as host behavior changes; transient 503/520 failures are not blocklisted.
- `content_urls` (OpenAlex's own PDF and GROBID XML): downloading them needs an API key, which a stored URL must not hold, and the indexers would need it too.

## Indexing

1. The indexers try the locators in their order ([keyword matching](../../Documentation/design/keyword-matching.md#full-texts)); they are read as PDFs, with the default budget of 3 s per host.
2. Other publisher sites may refuse automated downloads too, or answer with an HTML page; such documents keep their metadata only. Measure the readable share with the Index › Keyword screen of the [debug UI](../../debug/README.md), and add hosts that always fail to `NO_AUTOMATED_DOWNLOAD`.

## To be aware of

- `is_oa` includes "bronze" copies: free to read on the publisher site without an open licence (e.g. NEJM), so `licence` stays empty and each approach decides by its own rules.
- An OpenAlex error (budget used up, 429, server error) only logs a warning: the records keep the PMC result, and the next run of a search asks again. Use `crawler refresh --source pubmed` to enrich stored cited papers and remove previously stored blocked locators without a fresh database.
- The first locator may be a different version than the PubMed record (`version`: submitted, accepted or published).

## Sources

- API: https://help.openalex.org/
- Rate limits and keys: https://help.openalex.org/access/pricing/
- Work object, locations: https://help.openalex.org/data/works/attributes/
