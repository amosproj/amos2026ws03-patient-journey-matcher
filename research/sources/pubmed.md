# PubMed

API research for #6, checked 2026-11-01 with live API calls (the E-utilities manual was behind a browser check). What the crawler implements: [data sources](../../Documentation/design/sources.md#notes-per-source); where this page differs from the code, the code is right.

41.4 M citations with abstracts, MeSH and publication types. No full text; that comes from [PMC](pmc.md) via the PMCID.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/<esearch\|efetch\|elink>.fcgi` | Optional `api_key`; send `tool`, `email` | 3 req/s, 10 with key, 429 above; 9,999 IDs per query |
| `https://pubmed.ncbi.nlm.nih.gov/<PMID>/` | none | User link only |

Use `efetch` with `retmode=xml` on batches of IDs. `esummary` lacks abstract and MeSH. Bulk baseline files are not needed.

## Findings

`MC` = `PubmedArticle/MedlineCitation`, `PD` = `PubmedArticle/PubmedData`.

Reference crawl: `PD/ReferenceList` or `elink` with `linkname=pubmed_pubmed_refs`. Both matched Europe PMC in two samples, so Europe PMC is not needed; the crawler uses `elink`.

## Indexing

PMCID: full text via PMC. Otherwise an open-access PDF found by [OpenAlex](openalex.md), if any; without one, index title, abstract, MeSH, substances, keywords and publication types from the row. DOI and PubMed page are user links, not index sources.

## To be aware of

- New since last run: `datetype=edat` (with `mindate`, `maxdate`) or `mdat`. `pdat` is the journal date.
- 10 req/s is per key across all processes; Biopython paces per process, so the crawler has its own limit, `NCBI_REQUESTS_PER_SECOND` (5 with our key).
- No MeSH yet for `Publisher`/`In-Process` records; never for non-MEDLINE journals.
- NLM terms: name NLM, keep data current or flag it, no logo or endorsement. Some abstracts are publisher-copyrighted.
- Send `tool=patient-journey-matcher` and a team `email`. Large jobs at weekends or 21:00–05:00 US Eastern.
- 2027 baseline (December 2026): `MC/@IndexingMethod` gains `NotIndexed`.

## Sources

- E-utilities: https://www.ncbi.nlm.nih.gov/books/NBK25499/
- Rate limits: https://support.nlm.nih.gov/kbArticle/?pn=KA-05510
- Data terms: https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/README.txt
- DTD: https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd
- 2027 changes: https://www.nlm.nih.gov/pubs/techbull/so26/so26_pubmed_2027_baseline.html
