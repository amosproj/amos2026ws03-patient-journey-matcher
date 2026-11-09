# Keyword matching

The keyword baseline (#8): `match_journey` with `algorithm: keyword` ranks the stored documents by [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) on the words they share with the patient journey, in their metadata and full texts. It is one of the interchangeable approaches ([adding an approach](../matcher/algorithms/README.md)). Code: [`matcher/algorithms/keyword/`](../matcher/algorithms/keyword/src/), downloads: [`matcher/download/`](../matcher/download/src/). How to run it: [build and run](build.md#run-the-matcher-locally).

## How it works

**Indexing.** `make index` ([`matcher/indexer/`](../matcher/indexer/src/main.ts)) reads the new and changed documents ([storage](storage.md#reading)) and writes two tables in the schema `keyword`, each with a BM25 index of [pg_textsearch](https://github.com/timescale/pg_textsearch) (PostgreSQL License; English stemming and stop words):

- `keyword.documents`: title, abstract or description, and subject labels (MeSH for PubMed);
- `keyword.full_texts`: the [keywords](#keywords) of the downloaded [full text](#full-texts), for English texts.

Nothing else writes the schema. Deleting a document deletes its index rows.

**Query.** The latest event up to `as_of` is the focus, older events are context ([MCP interface](mcp-interface.md#match_journey-input)). From each event the matcher takes the label, the text parameters and the names of `true` flags (`bone_mets` → bone metastases). German words become English through [`german-terms.json`](../matcher/algorithms/keyword/data/german-terms.json) (`Knochenmetastasen` → bone metastases, `RPE` → radical prostatectomy); drug names and abbreviations pass unchanged (Olaparib, PSA); common function words, units and numbers are dropped. No LLM or outside service sees the journey.

**Ranking.** Focus terms count three times, context terms once. Each index returns its best 100 documents, and [reciprocal rank fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) merges the two rankings with equal weight. A document without a full text counts its metadata rank for both. `score` is relative to the best hit (1). `matched_terms` lists the query terms found in a document; one without any is not returned.

## Full texts

[`@matcher/download`](../matcher/download/src/downloader.ts) tries up to three `full_text` locators in their stored order ([sources §2](sources/README.md#2-metadata-schema)) and reads the first that gives text, in memory only.

| Source | File read | Read as |
|---|---|---|
| PubMed with a PMCID | JATS XML from the PMC bucket | `<body>`, without front matter and references |
| arXiv | HTML page, else the PDF (PDF-only uploads have no HTML) | HTML without page parts, formulas and references; PDF text |
| Zenodo | The preview file first: PDF, XML, HTML or text | As above; Word files, images, archives and unknown types are skipped |
| Podcasts | Transcript: WebVTT, SRT, JSON or text | Speakers and spoken text, without timings |
| YouTube | none | — |

PDFs are read with [unpdf](https://github.com/unjs/unpdf) (MIT, Mozilla's pdf.js), XML and HTML with [htmlparser2](https://github.com/fb55/htmlparser2) (MIT). Text after a "References" or "Bibliography" heading in the second half is dropped, so cited titles do not match. Downloads keep the [request budgets](sources/README.md#5-storage-limits-and-retention) per host: arxiv.org 15 s (its `robots.txt`), Zenodo 1 s, the PMC bucket 0.1 s, others 3 s; different hosts in parallel. A server error or 429 is retried twice, after `Retry-After` if sent; files over 50 MB are skipped.

`keyword.full_texts` has one row per document, also without a text:

| Column | Content |
|---|---|
| `status` | `indexed`; `skipped` (nothing readable, not English or no keywords; tried again when the document changes); `failed` (tried again in the next `make index`) |
| `detail` | Why skipped or failed, e.g. `HTTP 404`, `no readable format: audio/mpeg`, `no text` (a scanned PDF), `not English` |
| `terms` | The keywords in alphabetical order, each as often as it occurs: what BM25 ranks. The text cannot be read back from it |
| `lexemes` | The distinct English stems of `terms`, for `matched_terms` |
| `words`, `url`, `media_type`, `fetched_at`, `document_changed_at` | Number of keywords (at most 50,000), the file read, when, and the document version it was built from |

Check a run with `SELECT status, detail, count(*) FROM keyword.full_texts GROUP BY 1, 2 ORDER BY 3 DESC`.

**Licences.** This approach reads full texts under any licence, also "all rights reserved": the project is non-profit and keeps keywords only. Other approaches decide for themselves ([sources §3](sources/README.md#3-indexing)).

## Keywords

Full texts keep their medical words, even those named once; numbers and basic words go. Basic words are the 5,000 most frequent English words of [wordfreq](https://github.com/rspeer/wordfreq), except single-word MeSH terms in branches A–H, M and N (surgery, patients), words of longer MeSH terms outside the top 1,000 (failure, survival), two- and three-letter words outside the top 2,000 (PSA, DRE), and the words of the journey terms with a plural "s". On 50 texts this keeps 42 % of the words; of 80 medical test words it drops only "doctor".

[`basic-words.ts`](../matcher/algorithms/keyword/scripts/basic-words.ts) builds [`basic-words.json`](../matcher/algorithms/keyword/data/basic-words.json) from wordfreq and the MeSH descriptors (`desc2026.gz` from [NLM](https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/)). For a new MeSH year: `node matcher/algorithms/keyword/scripts/basic-words.ts desc2026.gz`. A new list applies to changed documents; for all, [rebuild the index](build.md#limitations).

**English only.** A text counts as English if at least 12 % of its words are among the 100 most frequent English words (English texts: about 30 %, others: under 10 %). Other texts keep only their metadata (`not English`).

**Credits.** MeSH 2026, courtesy of the U.S. National Library of Medicine; NLM does not endorse this project. Word frequencies: wordfreq v3.2 by Robyn Speer (CC BY-SA 4.0), including SUBTLEX by Marc Brysbaert et al. (freely available data), OpenSubtitles and the other sources wordfreq lists. `basic-words.json` is CC BY-SA 4.0 too.

## Known limitations

**Matching**

- **Words, not meaning.** A paper on olaparib for breast cancer matches a prostate cancer patient on olaparib.
- **History can outweigh the focus.** Late in a journey the many terms of older events beat the few of the current step. The weights (focus 3, full text 1) and the choice of context are guesses, to be tuned in #11.
- **Filler terms.** Parameters add generic words ("stable", `is_terminal` → "is"), and German words outside the term list stay German. The list covers only the synthetic journeys (#44).
- **No negation or values.** "Keine Fernmetastasen" becomes "distant metastases"; PSA values are ignored.
- **Keyword filter.** It drops a few medical words ("doctor", "rising" for "rise") and keeps rare non-medical ones (names, typos).
- **Scores** compare within one list only, not between journeys or algorithms.

**Downloader and extractor** ([`@matcher/download`](../matcher/download/src/))

- **No video or audio.** YouTube gives captions only to a video's owner, and audio is not transcribed (speech-to-text is undecided): videos and podcasts without a transcript have metadata only.
- **Text files only:** PDF, XML, HTML, plain text and transcripts. Not read: Word and PowerPoint files, images, archives, podcast show notes and scanned PDFs (no OCR).
- **PubMed needs a PMCID** for a full text.
- **One file per document:** the first of up to three that gives text, at most 50 MB.
- **English only.** Other texts keep their metadata only, and the references cut needs an English heading.
- **PDFs keep page headers, footers and formulas;** XML and HTML drop them.
- **arXiv is slow:** one request every 15 s, over four hours for 1,000 papers.
- **Sources are trusted:** downloads follow redirects to any address, and PDF parsing has no time limit.
