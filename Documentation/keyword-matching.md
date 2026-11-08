# Keyword matching

The keyword baseline (#8): `match_journey` with `algorithm: keyword` ranks the stored documents by [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) on the words they share with the patient journey, in their metadata and their full texts. It is one of the interchangeable approaches ([adding an approach](../matcher/algorithms/README.md)). Code: [`matcher/algorithms/keyword/`](../matcher/algorithms/keyword/src/), downloads: [`matcher/download/`](../matcher/download/src/).

## How it works

**Metadata index.** `make index` runs the indexer ([`matcher/indexer/`](../matcher/indexer/src/index.ts)). It reads the new and changed rows of `documents` with `documentsToIndex` ([storage](storage.md#reading)) and writes one row per document to `keyword.documents`: title, abstract or description, and subject labels (MeSH for PubMed). The [pg_textsearch](https://github.com/timescale/pg_textsearch) extension (PostgreSQL License) keeps a BM25 index on that text, with English stemming and stop words. The indexer creates the schema `keyword` itself; nothing else writes it. Deleting a document deletes its index rows.

**Full-text index.** Then the indexer downloads the full text of the same documents ([full texts](#full-texts)) and writes one row per document to `keyword.full_texts`, with its own BM25 index.

**Query.** The server cuts the journey at `as_of` ([MCP interface](mcp-interface.md#match_journey-input)): the latest event is the focus, every older event is context. For each event, the matcher takes the label, the text parameters and the names of `true` flags (`bone_mets` → bone metastases), and turns them into English terms:

- German words of the synthetic journeys come from a term list in [`terms.ts`](../matcher/algorithms/keyword/src/terms.ts): `Knochenmetastasen` → bone metastases, `RPE` → radical prostatectomy.
- Drug names and abbreviations pass unchanged (Olaparib, PSA, BRCA2). German function words, units and numbers are dropped.
- No LLM or outside service sees the journey.

The focus terms go into the BM25 query three times and the context terms once, so the current situation outweighs the history. Each index ranks its best 100 documents; [reciprocal rank fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) merges the two rankings with equal weight. A document without a full text counts its metadata rank for both, so lacking one does not rank it down. `score` is the fused value relative to the best hit of the list (1). `matched_terms` lists the query terms found in the metadata or the full text; a document without any is not returned.

## Full texts

[`@matcher/download`](../matcher/download/src/index.ts) tries the `full_text` locators of a document in their stored order ([sources §2](sources/README.md#2-metadata-schema)), at most three, and reads the first one that gives text. It keeps the text in memory only.

| Source | File read | Read as |
|---|---|---|
| PubMed with a PMCID | JATS XML from the PMC bucket | `<body>`; front matter and references left out |
| arXiv | HTML page, else the PDF (PDF-only uploads have no HTML) | HTML without page parts, formulas and references; PDF text |
| Zenodo | The preview file first: PDF, XML, HTML or text | As for the other sources; Word files, images, archives and unknown types are skipped |
| Podcasts | Transcript: WebVTT, SRT, JSON or text | Speakers and spoken text, without timings |
| YouTube | none | — |

PDFs are read with [unpdf](https://github.com/unjs/unpdf) (MIT, Mozilla's pdf.js), XML and HTML with [htmlparser2](https://github.com/fb55/htmlparser2) (MIT). In PDF, HTML and text files, everything after a "References" or "Bibliography" heading in the second half is dropped, as the cited titles would match like the paper's own words.

Downloads keep the [request budgets](sources/README.md#5-storage-limits-and-retention) per host: one request every 15 s to arxiv.org (its `robots.txt`), 1 s to Zenodo, 0.1 s to the PMC bucket, 3 s to podcast and other hosts. Different hosts are downloaded in parallel. A server error or 429 is retried twice, after `Retry-After` if sent. Files over 50 MB are skipped.

**What is stored.** One row per document in `keyword.full_texts`, also without a text:

| Column | Content |
|---|---|
| `status` | `indexed`; `skipped`: nothing readable, tried again when the document changes; `failed`: the download failed, tried again in the next `make index` |
| `detail` | Why skipped or failed, e.g. `HTTP 404`, `no readable format: audio/mpeg`, `no text` (a scanned PDF) |
| `url`, `media_type` | The file the words come from, or the last one tried |
| `words` | Number of words read; at most 50,000 count |
| `terms` | The words in alphabetical order, each as often as it occurs: what BM25 ranks. The text cannot be read back from it |
| `lexemes` | The distinct English word stems of `terms`, for `matched_terms` |
| `fetched_at` | When the file was downloaded |
| `document_changed_at` | The `changed_at` of the document it was built from |

Check a run with `SELECT status, detail, count(*) FROM keyword.full_texts GROUP BY 1, 2 ORDER BY 3 DESC`.

**Licences.** The project stays non-profit and the index keeps word counts only, so it reads the full text whatever the licence, also "all rights reserved" and unknown ([sources §3](sources/README.md#3-indexing)).

## Run it

```sh
make db       # Postgres with pg_textsearch (db/Dockerfile)
make seed     # or crawl with --store
make index    # after every crawl; reads only new and changed documents
make start    # MCP server, uses the database from the root .env
```

`make index APPROACHES=keyword` indexes this approach only. The first `make index` on the seed data took 26 minutes, mostly waiting for arxiv.org, and stored 33 MB of word counts; later runs read only new and changed documents. The database tests (`make test`) create a database of their own per test file, because the index lives in the fixed schema `keyword`; their downloads are faked.

## Results

A run on the seed data (1,303 documents, 430 on prostate cancer) at four evaluation points of [#11](https://github.com/amosproj/amos2026ws03-patient-journey-matcher/tree/feature/11-matching-evaluation), top 5:

| Point | Focus | What came back |
|---|---|---|
| `patient-1-e07` | Follow-up under active surveillance | "Active Surveillance for Prostate Cancer" (1st; 4th with metadata only), MRI and PI-RADS papers, a paper on MRI during active surveillance |
| `patient-3-e10` | PSA check after radical prostatectomy | 4 papers on radical prostatectomy (technique, long-term outcomes) and an overview from screening to treatment |
| `patient-5-e15` | Biochemical recurrence | "Management of Biochemical Recurrence" (1st; 3rd with metadata only), docetaxel for rising PSA after prostatectomy, recurrence-free survival after prostatectomy |
| `patient-10-e12` | Progression under a PARP inhibitor | Genomic and germline testing in mCRPC, "Olaparib for mCRPC" (5th), one on lymph-node salvage radiotherapy |

Full texts: 728 of 1,303 documents (arXiv 54 of 54, PubMed 190 of 584, Zenodo 463 of 495, podcasts 21 of 170), none failed. A query takes about 100 ms.

Only 6 of the 56 papers graded in #11 are in the seed data, so these are not yet metrics. Crawl prostate cancer deeper, then run the #11 evaluation.

## Known limitations

- **Shared words are not shared meaning.** Olaparib for breast cancer shares "olaparib" and "BRCA" with a prostate cancer patient on olaparib. A paper on a phase the patient already left still matches its words. Full texts add more of these: a drug named once in a discussion counts.
- **History can outweigh the focus.** Context includes every older event. A patient on active surveillance still gets the MRI papers of his diagnosis. The focus weight (3), the full-text weight (1) and the choice of context are guesses, to be tuned in #11.
- **No negation or values.** "Keine Fernmetastasen" (no distant metastases) becomes "distant metastases". "PSA rising" and "PSA falling" differ in one word; PSA values are ignored.
- **The term list only covers the synthetic journeys.** Other German words pass through and match nothing. The format of the real app is still open (#44).
- **Full texts for some documents only.** PubMed without a PMCID, most podcasts and all videos have metadata only. Not read yet: Word and PowerPoint files, audio and video (speech-to-text is undecided), podcast show notes. Scanned PDFs without a text layer give no text. The references cut needs an English heading.
- **English only.** Documents in other languages rank poorly.
- **Scores compare within one list only**, not between journeys or algorithms.
