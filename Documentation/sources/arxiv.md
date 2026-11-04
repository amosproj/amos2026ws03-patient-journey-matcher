# arXiv

Checked 01.11.2026; "tested" = own requests. Shared rules: [README](README.md).

Open preprint server, over 3 M articles, metadata CC0. Licence per paper: a third of recent medical papers carry only arXiv's own licence, 16 % an NC one. About 8,300 medical papers a year ([categories](#medical-categories)).

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| Query API `https://export.arxiv.org/api/query` (Atom) | none | 1 req per 3 s, one connection, shared with OAI-PMH across all machines; 2,000 per page, 30,000 per query |
| OAI-PMH `https://oaipmh.arxiv.org/oai` (replaced `export.arxiv.org/oai2`, 03.2025) | none | Same budget. Only API with the licence |
| `https://arxiv.org/html/{id}v{n}`, `/pdf/{id}v{n}` | none | `Crawl-delay: 15`; `/src`, `/e-print` disallowed |
| Semantic Scholar `https://api.semanticscholar.org/graph/v1/paper/ARXIV:{id}/references` | `x-api-key` | 1 req/s with a new key |

Terms: show "Thank you to arXiv for use of its open access interoperability."; no logo or implied endorsement. E-prints may be stored for personal or research use, not served from our servers unless the licence allows it. Commercial use is not covered.

## Connectors

Both use the `arxiv` package (4.0.2 current; #27 pins it).

- **SS26** `backend/scrapers/…/Archive`: stores PDF text; new client per call, so the 3 s delay is lost.
- **#27** `crawler/src/crawler/sources/arxiv.py` (not merged): metadata only, one shared client, concurrency 1.
- **Both:** no `updated`, no licence. SS26 keeps `vN` in the row ID; the crawler strips it since #23.

## Fields

| Schema field | Atom path | Note |
|---|---|---|
| `native_id`, `version` | `<id>` split into bare ID and `vN` | `id` = `arxiv:2610.16047` |
| `content_type` | constant `preprint` | |
| `title` | `<title>` | Collapse whitespace; may contain LaTeX |
| `authors` | `<author><name>`, `<arxiv:affiliation>` | Affiliations rare |
| `summary` | `<summary>` | |
| `subjects` | `<category term>`, `<arxiv:primary_category>` | |
| `published_at` | `<published>` | v1 date |
| `source_updated_at` | `<updated>` | Date of the returned version |
| `canonical_url` | `https://arxiv.org/abs/{id}` | |
| `doi` | `<arxiv:doi>` | Journal DOI if added; DataCite DOI `10.48550/arXiv.{id}` always exists |
| `licence` | OAI-PMH `GetRecord`, `metadataPrefix=arXiv`, `<license>` | Mapping below |
| `full_text` | `https://arxiv.org/html/{id}v{n}`, then `/pdf/{id}v{n}` | Build the HTML URL |
| `extra` | `<arxiv:journal_ref>`, `<arxiv:comment>` | `journal_ref` = published version |

No language field (mostly English).

| `<license>` | `licence` | Share of 298 papers |
|---|---|---|
| `http://arxiv.org/licenses/nonexclusive-distrib/1.0/`, or none (1991–2003) | `arxiv-nonexclusive-1.0` | 35 % |
| `http://creativecommons.org/licenses/by/4.0/` | `CC-BY-4.0` | 45 % |
| `…/by-nc-nd/4.0/`, `…/by-nc-sa/4.0/` | `CC-BY-NC-ND-4.0`, `CC-BY-NC-SA-4.0` | 16 % |
| `…/by-sa/4.0/`, `…/publicdomain/zero/1.0/` | `CC-BY-SA-4.0`, `CC0-1.0` | 4 % |

Sample: q-bio and physics.med-ph, OAI-PMH `ListRecords` for 01.–10.10.2026, harvested 02.11.2026.

Query facts (tested):

- Fields `ti`, `au`, `abs`, `cat`, `all`; `AND`, `OR`, `ANDNOT`; phrases in double quotes.
- New since last run: `submittedDate:[YYYYMMDDHHMM TO YYYYMMDDHHMM]` (GMT, v1 date). `lastUpdatedDate` silently acts as `submittedDate`, so new versions of older papers are missed.
- `id_list=2610.16047` returns the latest version; `…v1` returns v1.
- Licence: one `GetRecord` per new paper, or daily `ListRecords&from=` on the medical sets (about 25 a day). Version dates: `arXivRaw` (in `arXiv`, `<created>` is the latest version's date).

### Medical categories

| Category | OAI set | Papers 01.11.2025–01.11.2026 |
|---|---|---|
| q-bio | `q-bio` | 4,978 |
| physics.med-ph | `physics:physics:med-ph` | 984 |
| eess.IV (much medical imaging) | `eess:eess:IV` | 2,621 |
| All three, cross-lists once | | 8,325 |

Topic queries are narrower: `all:"prostate cancer"` 102 a year, `"breast cancer"` 334, `"bladder cancer"` 12. Much of q-bio is not clinical; check results against the topic.

## Indexing

1. HTML first (LaTeXML). 99 % of LaTeX submissions have it since 08.2026; PDF-only uploads 404 (2 of 5 medical samples).
2. Else PDF; needs a TypeScript text extractor (not chosen).
3. Request the stored version. Keep 15 s per request on arxiv.org (`export.arxiv.org` disallows all in `robots.txt`).

MCP passes the file on only where its CC licence allows; arXiv default licence: abstract page link.

## To be aware of

- Commercial use (AIlixir later) needs arXiv's consent or its affiliate programme; the university project is research use.
- HTTP 500 on some valid requests and past the 30,000 cap; keep retries.
- No peer review; `journal_ref` and `doi` are the only signs of publication.
- Semantic Scholar data includes CC BY-NC sources.

## Sources

- API manual: https://info.arxiv.org/help/api/user-manual.html
- API terms: https://info.arxiv.org/help/api/tou.html
- OAI-PMH: https://info.arxiv.org/help/oa/index.html
- Licences: https://info.arxiv.org/help/license/index.html
- HTML papers: https://info.arxiv.org/about/accessible_HTML.html
- Semantic Scholar: https://www.semanticscholar.org/product/api/license
