# Keyword matching

The keyword baseline: `match_journey` with `algorithm: keyword` ranks the stored documents by [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) on the words they share with the patient journey, in their metadata and full texts. It is one of the interchangeable approaches ([adding an approach](../../matcher/algorithms/README.md)). Code: [`matcher/algorithms/keyword/`](../../matcher/algorithms/keyword/src/), downloads: [`matcher/download/`](../../matcher/download/src/). How to run it: [build and run](../build-deploy/build.md#run-the-matcher-locally).

How the ranking was tuned and measured: [keyword tuning](../../research/keyword-tuning.md). The Matcher screen of the [debug UI](../../debug/crawler/README.md) shows every step below for a synthetic journey, and its Index screen what the index holds per source.

## How it works

**Indexing.** `make index` ([`matcher/indexer/`](../../matcher/indexer/src/main.ts)) reads the new and changed documents ([storage](storage.md#reading)) and writes two tables in the schema `keyword`, each with a BM25 index of [pg_textsearch](https://github.com/timescale/pg_textsearch) (PostgreSQL License; English stemming and stop words):

- `keyword.documents`: title, abstract or description, and subject labels (MeSH for PubMed);
- `keyword.full_texts`: the [keywords](#keywords) of the downloaded [full text](#full-texts), for English texts.

Deleting a document deletes its index rows.

**Query.** The latest event up to `as_of` is the focus, older events are context ([MCP interface](../user/mcp-interface.md#match_journey-input)). From each event the matcher takes the label, the text parameters except the participants of a tumor board, and the names of `true` flags (`bone_mets` → bone metastases). [`german-terms.json`](../../matcher/algorithms/keyword/data/german-terms.json) makes English search terms of them:

| List | Holds | Example |
|---|---|---|
| `translations` | German words, codes and abbreviations | `Knochenmetastasen` → bone metastases, `RPE` → radical prostatectomy, `ADT` → androgen deprivation therapy, `R1` → positive margins |
| `skip` | Function words, units, time spans, codes of absent findings and a stable PSA trend | `nach`, `ng`, `Wochen`, `R0`, `stable` |
| `negations` | Words and phrases that negate a finding: `following` up to the end of its clause, `clause` the whole clause, `next` the next searched word | "Lokalrezidiv, keine Fernmetastasen" → local recurrence; "Lymphknoten unauffällig" and "Lymphknoten nicht befallen" → nothing; "PSA nicht mehr nachweisbar" → PSA |
| `generic` | English terms that say little about a patient | initial, follow up, urology |

Drug names and other words without an entry pass unchanged (Olaparib, PSA); numbers are dropped. No LLM or outside service sees the journey.

The query holds the medical focus terms twelve times, the generic focus terms once and the 10 context terms that weigh most once. A context term weighs more the more events name it; of two that weigh the same, the one named more recently comes first. Generic terms of older events are left out.

**Ranking.** Each index returns its best 100 documents for the query. Their BM25 scores cannot be compared, as abstracts are short and full texts long, so only the ranks are merged, by [reciprocal rank fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

```math
\mathrm{score}(d) = \sum_{i \in \{\text{metadata},\ \text{full text}\}} \frac{1}{k + \mathrm{rank}_i(d)}, \qquad k = 60
```

A document that is first in both indexes scores 2/61, one that is 30th in both 2/90, and one that only one index finds first 1/61: being found by both counts more than a top place in one. The constant k = 60, the value of the paper, keeps the first places close together. Three details:

- An index adds to a document's score only if it finds one of the query terms in it.
- Without a full text (videos, and papers or episodes without a readable one), the metadata rank is used for the full-text part too, so such a document does not rank below those that have one.
- `score` in the answer is relative to the best hit (1). `matched_terms` lists the query terms found in a document; one without a medical term is not returned.

**New journey data.** A word outside the lists is searched as it is, so a German one finds nothing. The Matcher screen of the [debug UI](../../debug/crawler/README.md) shows what became of each word of a journey. [`terms.test.ts`](../../matcher/algorithms/keyword/src/terms.test.ts) lists the words of the synthetic journeys that pass unchanged and fails for a new one: translate or skip it, or add an English word to the test.

## Full texts

[`@matcher/download`](../../matcher/download/src/downloader.ts) skips the `full_text` locators ([storage](storage.md#documents)) in a format it cannot read, tries up to three of the others in their stored order, and reads the first that gives text, in memory only.

| Source | File read | Read as |
|---|---|---|
| PubMed in the PMC bucket | JATS XML from the PMC bucket | `<body>`, without front matter and references |
| Other PubMed records | Open-access PDF that [OpenAlex](../../research/sources/openalex.md) knows, if its host allows the download | PDF text |
| arXiv | HTML page, else the PDF (PDF-only uploads have no HTML) | HTML without page parts, formulas and references; PDF text |
| Zenodo | The preview file first: PDF, XML, HTML or text | As above; Word files, images, archives and unknown types are skipped |
| Podcasts | Transcript: WebVTT, SRT, JSON, HTML or text; else the audio file, read by the [transcription job](#speech-to-text) | Speakers and spoken text, without timings; what Whisper hears |
| YouTube | none | — |

PDFs are read with [unpdf](https://github.com/unjs/unpdf) (MIT, Mozilla's pdf.js), XML and HTML with [htmlparser2](https://github.com/fb55/htmlparser2) (MIT). Text after a "References" or "Bibliography" heading in the second half is dropped, so cited titles do not match. Downloads keep the [request budgets](sources.md#request-budgets) per host: arxiv.org 15 s (its `robots.txt`), Zenodo 1 s, the PMC bucket 0.1 s, others 3 s; different hosts in parallel. A server error or 429 is retried twice, after `Retry-After` if sent; files over 50 MB are skipped, audio over 150 MB.

Both metadata and full-text indexing skip documents whose `extra.metadata_language` is known and non-English. Unknown stays eligible; `language` is not used because it may describe the article rather than its English abstract. Already indexed non-English content is cleared on the next index run. Skipped documents still have an index bookkeeping row, avoiding repeated downloads.

`keyword.full_texts` has one row per document, also without a text:

| Column | Content |
|---|---|
| `status` | `indexed`; `skipped` (nothing readable, not English or no keywords; tried again when the document changes); `failed` (tried again in the next `make index`) |
| `detail` | Why skipped or failed, e.g. `HTTP 404`, `no readable format: audio/x-m4a`, `no text` (a scanned PDF), `not English`; `audio, and speech-to-text is off` waits for the transcription job |
| `terms` | The keywords in alphabetical order, each as often as it occurs: what BM25 ranks. The text cannot be read back from it |
| `lexemes` | The distinct English stems of `terms`, for `matched_terms` |
| `words`, `url`, `media_type`, `fetched_at`, `document_changed_at` | Number of keywords (at most 50,000), the file read, when, and the document version it was built from |

Check a run on the Index screen of the [debug UI](../../debug/crawler/README.md), or with `SELECT status, detail, count(*) FROM keyword.full_texts GROUP BY 1, 2 ORDER BY 3 DESC`.

**Licences.** This approach reads full texts under any licence, also "all rights reserved": the project is non-profit and keeps keywords only; the transcript of an audio file is kept only until every index has read it. Other approaches decide for themselves ([licences](sources.md#licences)).

### Speech-to-text

The indexer reads podcast audio as its transcript. An episode without a transcript file waits as `audio, and speech-to-text is off` until the transcription job ([`matcher/transcriber`](../../matcher/transcriber/src/main.ts), `make transcribe`) has read its audio: newest first, if the episode's metadata is English or of unknown language, until it is stopped; `make index` and the crawls never wait for it. The job downloads each audio file into memory, transcribes it offline with Whisper ([`scripts/transcribe.py`](../../scripts/transcribe.py), model from `WHISPER_MODEL`) and stores the text in the table `transcripts`. The next `make index` reads it like a downloaded text; once every index has read it, the text is dropped, and the keywords stay as long as the episode keeps its audio file. How many files it reads at once is set on the Index screen of the [debug UI](../../debug/crawler/README.md), also while it runs (none at first), or with `make transcribe WORKERS=2`; the table `transcription` holds that number and the job's last report. M4A and MP4 audio is not read. Model choice: [Whisper models](../../research/sources/podcasts.md#whisper-models); on the VM the job runs as a service ([transcription](../build-deploy/deployment.md#transcription)).

## Keywords

Full texts keep their medical words, even those named once; numbers and basic words go. Basic words are the 5,000 most frequent English words of [wordfreq](https://github.com/rspeer/wordfreq), except single-word MeSH terms in branches A–H, M and N (surgery, patients), words of longer MeSH terms in branches A, C, D and E outside the top 1,000 (failure, survival), two- and three-letter words outside the top 2,000 (PSA, DRE), and the words of the journey terms with a plural "s".

[`basic-words.ts`](../../matcher/algorithms/keyword/scripts/basic-words.ts) builds [`basic-words.json`](../../matcher/algorithms/keyword/data/basic-words.json) from wordfreq and the MeSH descriptors (`desc2026.gz` from [NLM](https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/)). For a new MeSH year: `node matcher/algorithms/keyword/scripts/basic-words.ts desc2026.gz`. A new list applies to changed documents; for all, [rebuild the index](../build-deploy/build.md#limitations).

**English only.** A text counts as English if at least 12 % of its words are among the 100 most frequent English words (English texts: about 30 %, others: under 10 %). Other texts keep only their metadata (`not English`).

**Credits.** MeSH 2026, courtesy of the U.S. National Library of Medicine; NLM does not endorse this project. Word frequencies: wordfreq v3.2 by Robyn Speer (CC BY-SA 4.0), including SUBTLEX by Marc Brysbaert et al. (freely available data), OpenSubtitles and the other sources wordfreq lists. `basic-words.json` is CC BY-SA 4.0 too.

## Known limitations

**Matching by words.** What this approach cannot do, whatever its constants:

- **Words, not what a text is about.** The matcher counts shared words. A paper that names PSA ranks like a paper about PSA, and olaparib for breast cancer matches a prostate cancer patient on olaparib.
- **No relation between words.** A term of several words is searched word by word ("bone density" also finds bone metastases), and nothing ties a finding to its setting: "PSA rising after surgery" is three words, each also found in a paper on something else.
- **Only what the journey names.** Synonyms and paraphrases outside the term list are missed, and so is what matters at a step without being written down: continence after surgery, the side effects of a therapy.
- **No numbers.** A PSA of 0.4 and one of 40 give the same query.
- **No sense of disease or phase.** Nothing tells the matcher which disease a journey is about or which older events still matter. A term that fits several diseases finds them all, and a long series of check-ups outweighs one surgery in the context.
- **Little to search at the start of a journey:** one common term and no context.
- **The order among matching papers is the ceiling.** Most good sources hold every focus term, and word counts decide which of them comes first. A better order needs meaning, the job of the other approaches ([measured](../../research/keyword-tuning.md#results)).
- **One vote per index.** A paper that the metadata index ranks first can land outside the first 10 when its full text ranks low. Other weights ranked no better.

**This version**

- **Hand-made term lists.** They cover the 20 synthetic journeys. An unknown German word finds nothing, and an unknown generic word counts as medical. To be extended for AIlixir's data.
- **Negation by listed words, not grammar.** How far a negation reaches is a rule per word or phrase. Not covered:
  - a finding negated in an unlisted way ("o. B.", "noch nie") is searched as if present;
  - a finding named before "nicht" is dropped only in a listed phrase: "Lymphknoten nicht befallen" yes, "Lymphknoten nicht tastbar" no, and inflected forms ("nicht befallenen") no;
  - "nicht nur" (not only) wrongly drops the next word;
  - "not detected in lymph nodes" still searches the lymph nodes.

  The synthetic journeys negate with "kein" and "negative" only, so the rules for "nicht" are checked by examples, not measured.
- **Tuned on synthetic prostate cancer journeys with LLM grades.** Real journeys may need other constants.
- **Keyword filter.** It drops a few medical words ("doctor", "rising" for "rise") and keeps rare non-medical ones (names, typos).
- **Scores** compare within one list only, not between journeys or approaches.

**Downloader and extractor** ([`@matcher/download`](../../matcher/download/src/))

- **Most papers have no full text.** A PubMed paper needs a PMCID or an open-access PDF whose host allows the download ([measured coverage](../../research/sources/README.md)).
- **No video; audio only with speech-to-text.** YouTube gives captions only to a video's owner. Podcast audio is read only by `make transcribe` ([speech-to-text](#speech-to-text)); until it has read an episode without a transcript and the next `make index` ran, that episode has metadata only.
- **Text files only:** PDF, XML, HTML, plain text and transcripts. Not read: Word and PowerPoint files, images, archives, podcast show notes and scanned PDFs (no OCR).
- **One file per document:** the first of up to three that gives text, at most 50 MB.
- **English only.** Other texts keep their metadata only, and the references cut needs an English heading.
- **PDFs keep page headers, footers and formulas;** XML and HTML drop them.
- **arXiv is slow:** one request every 15 s, over four hours for 1,000 papers.
- **Sources are trusted:** downloads follow redirects to any address, and PDF parsing has no time limit.
