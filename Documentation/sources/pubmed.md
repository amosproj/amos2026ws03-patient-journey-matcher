# PubMed

Checked 01.11.2026 with live API calls (the E-utilities manual was behind a browser check). Shared rules: [README](README.md).

41.4 M citations with abstracts, MeSH and publication types. No full text; that comes from [PMC](pmc.md) via the PMCID.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/<esearch\|efetch\|elink>.fcgi` | Optional `api_key`; send `tool`, `email` | 3 req/s, 10 with key, 429 above; 9,999 IDs per query |
| `https://pubmed.ncbi.nlm.nih.gov/<PMID>/` | none | User link only |

Use `efetch` with `retmode=xml`, batched via the History server (`usehistory=y`). `esummary` lacks abstract and MeSH. Bulk baseline files are not needed.

## Connectors

- **SS26** `backend/scrapers/…/PubMed`: stores publisher PDF text (breaks metadata-only); keeps only the first abstract section; fails on `CollectiveName`; reads keywords from the wrong element; filters by `pdat`.
- **crawler** `crawler/src/crawler/sources/pubmed.py`: the fields below; `--since` by entry date; PMC adds licence and full text.

## Fields

`MC` = `PubmedArticle/MedlineCitation`, `PD` = `PubmedArticle/PubmedData`.

| Schema field | Path | Note |
|---|---|---|
| `native_id` | `MC/PMID` | Never reused; `id` = `pubmed:<PMID>` |
| `version` | `MC/PMID/@Version` | Usually 1 |
| `content_type` | `journal_article`; `book` for `PubmedBookArticle` | Books and chapters of NCBI Bookshelf (StatPearls, PDQ): `BookDocument` instead of `MC`, venue `Book/BookTitle`, date `ContributionDate`, `bookaccession` → `external_ids.bookshelf_id` |
| `publication_types` | `MC/Article/PublicationTypeList/PublicationType` | Match on `@UI` (MeSH 2026 renamed some) |
| `title` | `MC/Article/ArticleTitle` | Strip inline tags |
| `authors` | `MC/Article/AuthorList/Author`: `LastName` + `ForeName` or `CollectiveName`; `Identifier[@Source="ORCID"]`; `AffiliationInfo` | |
| `venue` | `MC/Article/Journal/Title` | |
| `summary` | `MC/Article/Abstract/AbstractText`, all sections with `@Label` | |
| `language` | `MC/Article/Language` | ISO 639-2, convert |
| `subjects` | `MC/MeshHeadingList` (`@UI`, `@MajorTopicYN`), `MC/ChemicalList`, `MC/KeywordList` | |
| `published_at` | `MC/Article/ArticleDate[@DateType="Electronic"]`, else `JournalIssue/PubDate` | Months `Dec` or `12`; `MedlineDate` is free text |
| `source_updated_at` | `MC/DateRevised` | |
| `canonical_url` | `https://pubmed.ncbi.nlm.nih.gov/<PMID>/` | |
| `doi` | `PD/ArticleIdList/ArticleId[@IdType="doi"]` | |
| `external_ids` | `ArticleId[@IdType="pmc"]` → `pmcid`, `[@IdType="mid"]` → `nihms` | PMCID is the full-text key |
| `licence`, `full_text` | from [PMC](pmc.md) | Empty without PMCID |
| `extra` | `MC/@Status`, entry date (`PubMedPubDate[@PubStatus="entrez"]`), `pmc-release` date, `Abstract/CopyrightInformation` | |

Reference crawl: `PD/ReferenceList` or `elink` with `linkname=pubmed_pubmed_refs`. Both matched Europe PMC in two samples, so Europe PMC is not needed.

## Indexing

PMCID: full text via PMC. Otherwise index title, abstract, MeSH, substances, keywords and publication types from the row. DOI and PubMed page are user links, not index sources.

## To be aware of

- New since last run: `datetype=edat` (with `mindate`, `maxdate`) or `mdat`. `pdat` is the journal date.
- 10 req/s is per key across all processes; Biopython paces per process, so set the shared limit in Crawlee.
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
