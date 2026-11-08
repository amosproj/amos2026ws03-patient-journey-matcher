# Keyword matching

The keyword baseline (#8): `match_journey` with `algorithm: keyword` ranks the stored documents by [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) on the words they share with the patient journey. Code: [`matcher/algorithms/keyword/`](../matcher/algorithms/keyword/src/).

## How it works

**Index.** `make index` runs the indexer ([`matcher/indexer/`](../matcher/indexer/src/index.ts)). It reads the new and changed rows of `documents` with `documentsToIndex` ([storage](storage.md#reading)) and writes one row per document to `keyword.documents`: title, abstract or description, and subject labels (MeSH for PubMed). The [pg_textsearch](https://github.com/timescale/pg_textsearch) extension (PostgreSQL License) keeps a BM25 index on that text, with English stemming and stop words. The indexer creates the schema `keyword` itself; nothing else writes it. Deleting a document deletes its index row.

**Query.** The server cuts the journey at `as_of` ([MCP interface](mcp-interface.md#match_journey-input)): the latest event is the focus, every older event is context. For each event, the matcher takes the label, the text parameters and the names of `true` flags (`bone_mets` → bone metastases), and turns them into English terms:

- German words of the synthetic journeys come from a term list in [`terms.ts`](../matcher/algorithms/keyword/src/terms.ts): `Knochenmetastasen` → bone metastases, `RPE` → radical prostatectomy.
- Drug names and abbreviations pass unchanged (Olaparib, PSA, BRCA2). German function words, units and numbers are dropped.
- No LLM or outside service sees the journey.

The focus terms go into the BM25 query three times and the context terms once, so the current situation outweighs the history. `score` is BM25 relative to the best hit of the list (1). `matched_terms` lists the query terms found in the document.

## Run it

```sh
make db       # Postgres with pg_textsearch (db/Dockerfile)
make seed     # or crawl with --store
make index    # after every crawl; indexes only new and changed documents
make start    # MCP server, uses the database from the root .env
```

The database tests (`make test`) create a database of their own per test file, because the index lives in the fixed schema `keyword`.

## Results

A sample run on the seed data (1,303 documents, 430 on prostate cancer), at four evaluation points of [#11](https://github.com/amosproj/amos2026ws03-patient-journey-matcher/tree/feature/11-matching-evaluation), top 5:

| Point | Focus | What came back |
|---|---|---|
| `patient-1-e07` | Follow-up under active surveillance | 3 MRI and PI-RADS diagnostic papers, then "Active Surveillance for Prostate Cancer" (4th) |
| `patient-3-e10` | PSA check after radical prostatectomy | 4 papers on radical prostatectomy (technique, survivorship, anaesthesia) and an overview from screening to treatment |
| `patient-5-e15` | Biochemical recurrence | Recurrence-free survival after prostatectomy, docetaxel for rising PSA, "Management of Biochemical Recurrence" (3rd) |
| `patient-10-e12` | Progression under a PARP inhibitor | Genomic and germline testing in mCRPC, "Olaparib for mCRPC" (5th), one on lymph-node salvage radiotherapy |

Only 6 of the 56 papers graded in #11 are in the seed data, so these are not yet metrics. Crawl prostate cancer deeper, then run the #11 evaluation.

## Known limitations

- **Shared words are not shared meaning.** Olaparib for breast cancer shares "olaparib" and "BRCA" with a prostate cancer patient on olaparib. A paper on a phase the patient already left still matches its words.
- **History can outweigh the focus.** Context includes every older event. A patient on active surveillance still gets the MRI papers of his diagnosis. The focus weight (3) and the choice of context are guesses, to be tuned in #11.
- **No negation or values.** "Keine Fernmetastasen" (no distant metastases) becomes "distant metastases". "PSA rising" and "PSA falling" differ in one word; PSA values are ignored.
- **The term list only covers the synthetic journeys.** Other German words pass through and match nothing. The format of the real app is still open (#44).
- **Metadata only.** Full texts are not indexed yet (`download()` does not exist). Videos and podcasts have only their description. Title words count like abstract words.
- **English only.** Documents in other languages rank poorly.
- **Scores compare within one list only**, not between journeys or algorithms.
