# Keyword matching

The keyword baseline (#8): `match_journey` with `algorithm: keyword` ranks the stored documents by [BM25](https://en.wikipedia.org/wiki/Okapi_BM25) on the words they share with the patient journey, in their metadata and full texts. It is one of the interchangeable approaches ([adding an approach](../matcher/algorithms/README.md)). Code: [`matcher/algorithms/keyword/`](../matcher/algorithms/keyword/src/), downloads: [`matcher/download/`](../matcher/download/src/). How to run it: [build and run](build.md#run-the-matcher-locally).

This page describes [how it works](#how-it-works), [how we improved it by measurement](#how-we-improved-it), the [results](#results) and what it [cannot do](#known-limitations).

## How it works

**Indexing.** `make index` ([`matcher/indexer/`](../matcher/indexer/src/main.ts)) reads the new and changed documents ([storage](storage.md#reading)) and writes two tables in the schema `keyword`, each with a BM25 index of [pg_textsearch](https://github.com/timescale/pg_textsearch) (PostgreSQL License; English stemming and stop words):

- `keyword.documents`: title, abstract or description, and subject labels (MeSH for PubMed);
- `keyword.full_texts`: the [keywords](#keywords) of the downloaded [full text](#full-texts), for English texts.

Nothing else writes the schema. Deleting a document deletes its index rows.

**Query.** The latest event up to `as_of` is the focus, older events are context ([MCP interface](mcp-interface.md#match_journey-input)). From each event the matcher takes the label, the text parameters except the participants of a tumor board, and the names of `true` flags (`bone_mets` → bone metastases). [`german-terms.json`](../matcher/algorithms/keyword/data/german-terms.json) makes English search terms of them:

| List | Holds | Example |
|---|---|---|
| `translations` | German words, codes and abbreviations | `Knochenmetastasen` → bone metastases, `RPE` → radical prostatectomy, `ADT` → androgen deprivation therapy, `R1` → positive margins |
| `skip` | Function words, units, time spans, codes of absent findings and a stable PSA trend | `nach`, `ng`, `Wochen`, `R0`, `stable` |
| `negations` | Words that negate a finding: `following` up to the end of its clause, `clause` the whole clause | "Lokalrezidiv, keine Fernmetastasen" → local recurrence; "Lymphknoten unauffällig" → nothing |
| `generic` | English terms that say little about a patient | initial, follow up, urology |

Drug names and other words without an entry pass unchanged (Olaparib, PSA); numbers are dropped. No LLM or outside service sees the journey.

The query holds the medical focus terms twelve times, the generic focus terms once and the 10 context terms that weigh most once. A context term weighs more the more events name it; of two that weigh the same, the one named more recently comes first. Generic terms of older events are left out.

**Ranking.** Each index returns its best 100 documents for the query. Their BM25 scores cannot be compared, as abstracts are short and full texts long, so only the ranks are merged, by [reciprocal rank fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

```math
\mathrm{score}(d) = \sum_{i \in \{\text{metadata},\ \text{full text}\}} \frac{1}{k + \mathrm{rank}_i(d)}, \qquad k = 60
```

A document that is first in both indexes scores 2/61, one that is 30th in both 2/90, and one that only one index finds first 1/61: being found by both counts more than a top place in one. The constant k = 60, the value of the paper, keeps the first places close together. Three details:

- An index adds to a document's score only if it finds one of the query terms in it.
- Without a full text (two thirds of the documents: most papers, videos, most podcast episodes), the metadata rank is used for the full-text part too, so such a document does not rank below those that have one.
- `score` in the answer is relative to the best hit (1). `matched_terms` lists the query terms found in a document; one without a medical term is not returned.

**New journey data.** A word outside the lists is searched as it is, so a German one finds nothing. The Matcher screen of the [debug UI](../debug/crawler/README.md) shows what became of each word of a journey. [`terms.test.ts`](../matcher/algorithms/keyword/src/terms.test.ts) lists the words of the synthetic journeys (#14) that pass unchanged and fails for a new one: translate or skip it, or add an English word to the test.

## Full texts

[`@matcher/download`](../matcher/download/src/downloader.ts) tries up to three `full_text` locators in their stored order ([sources §2](sources/README.md#2-metadata-schema)) and reads the first that gives text, in memory only.

| Source | File read | Read as |
|---|---|---|
| PubMed with a PMCID | JATS XML from the PMC bucket | `<body>`, without front matter and references |
| PubMed without a PMCID | Open-access PDF that [OpenAlex](sources/openalex.md) knows, if its host allows the download | PDF text |
| arXiv | HTML page, else the PDF (PDF-only uploads have no HTML) | HTML without page parts, formulas and references; PDF text |
| Zenodo | The preview file first: PDF, XML, HTML or text | As above; Word files, images, archives and unknown types are skipped |
| Podcasts | Transcript: WebVTT, SRT, JSON or text; else the MP3, with [speech-to-text](sources/podcasts.md#indexing) | Speakers and spoken text, without timings; what Whisper hears |
| YouTube | none | — |

PDFs are read with [unpdf](https://github.com/unjs/unpdf) (MIT, Mozilla's pdf.js), XML and HTML with [htmlparser2](https://github.com/fb55/htmlparser2) (MIT). Text after a "References" or "Bibliography" heading in the second half is dropped, so cited titles do not match. Downloads keep the [request budgets](sources/README.md#5-storage-limits-and-retention) per host: arxiv.org 15 s (its `robots.txt`), Zenodo 1 s, the PMC bucket 0.1 s, others 3 s; different hosts in parallel. A server error or 429 is retried twice, after `Retry-After` if sent; files over 50 MB are skipped, audio over 150 MB.

Both metadata and full-text indexing skip documents whose `extra.metadata_language` is known and non-English. Unknown stays eligible; `language` is not used because it may describe the article rather than its English abstract. Already indexed non-English content is cleared on the next index run, including indexes created before this filtering was added. Skipped documents still have an index bookkeeping row, avoiding repeated downloads.

Audio skips written by the old indexer (`no readable format: audio/mpeg`, etc.) are retried when speech-to-text is enabled too.

`keyword.full_texts` has one row per document, also without a text:

| Column | Content |
|---|---|
| `status` | `indexed`; `skipped` (nothing readable, not English or no keywords; tried again when the document changes, audio also once speech-to-text is on); `failed` (tried again in the next `make index`) |
| `detail` | Why skipped or failed, e.g. `HTTP 404`, `no readable format: audio/x-m4a`, `audio, and speech-to-text is off`, `no text` (a scanned PDF), `not English` |
| `terms` | The keywords in alphabetical order, each as often as it occurs: what BM25 ranks. The text cannot be read back from it |
| `lexemes` | The distinct English stems of `terms`, for `matched_terms` |
| `words`, `url`, `media_type`, `fetched_at`, `document_changed_at` | Number of keywords (at most 50,000), the file read, when, and the document version it was built from |

Check a run on the Index screen of the [debug UI](../debug/crawler/README.md), or with `SELECT status, detail, count(*) FROM keyword.full_texts GROUP BY 1, 2 ORDER BY 3 DESC`.

**Licences.** This approach reads full texts under any licence, also "all rights reserved": the project is non-profit and keeps keywords only, also of the audio it transcribes. Other approaches decide for themselves ([sources §3](sources/README.md#3-indexing)).

## Keywords

Full texts keep their medical words, even those named once; numbers and basic words go. Basic words are the 5,000 most frequent English words of [wordfreq](https://github.com/rspeer/wordfreq), except single-word MeSH terms in branches A–H, M and N (surgery, patients), words of longer MeSH terms outside the top 1,000 (failure, survival), two- and three-letter words outside the top 2,000 (PSA, DRE), and the words of the journey terms with a plural "s". On 50 texts this keeps 42 % of the words; of 80 medical test words it drops only "doctor".

[`basic-words.ts`](../matcher/algorithms/keyword/scripts/basic-words.ts) builds [`basic-words.json`](../matcher/algorithms/keyword/data/basic-words.json) from wordfreq and the MeSH descriptors (`desc2026.gz` from [NLM](https://nlmpubs.nlm.nih.gov/projects/mesh/MESH_FILES/xmlmesh/)). For a new MeSH year: `node matcher/algorithms/keyword/scripts/basic-words.ts desc2026.gz`. A new list applies to changed documents; for all, [rebuild the index](build.md#limitations).

**English only.** A text counts as English if at least 12 % of its words are among the 100 most frequent English words (English texts: about 30 %, others: under 10 %). Other texts keep only their metadata (`not English`).

**Credits.** MeSH 2026, courtesy of the U.S. National Library of Medicine; NLM does not endorse this project. Word frequencies: wordfreq v3.2 by Robyn Speer (CC BY-SA 4.0), including SUBTLEX by Marc Brysbaert et al. (freely available data), OpenSubtitles and the other sources wordfreq lists. `basic-words.json` is CC BY-SA 4.0 too.

## How we improved it

#58 changed the ranking by measurement, in a loop:

1. **Measure** the ranking on a fixed set of journey points whose results are graded.
2. **Read the failures:** the points that score worst, and what the poor sources in their first 10 have in common.
3. **Change one thing,** as a variant of the ranking, and run all points again.
4. **Grade** every source that is new in a first 10, so that no variant is judged by missing grades.
5. **Keep the change only if it holds:** on the journeys it was chosen on and on those it was not, beyond chance, and without burying good sources.

About 150 variants went through this loop. The script that runs them is not in the repository; it reproduces the matcher (identical lists on all points) and changes one thing per option. The grades are in the repository ([checking a change](#checking-a-change)).

**Test set.** 129 points from 10 synthetic journeys, one per pathway ([evaluation points](matching-evaluation.md#evaluation-points)): every event as the focus, as `match_journey` cuts the journey. Of a run of identical check-ups only the first and the last count, and none after the patient died. Five journeys (67 points) are the sample on which a change is chosen, the other five (62 points) the holdout on which it must hold.

**Relevance grades.** A source gets a grade for a point: 3 fits the focus, 2 fits the context, 1 is the right disease but generic or another setting, 0 is the wrong disease or a setting that does not apply ([scale and rules](matching-evaluation.md#what-makes-a-match-relevant)). An LLM graded every source that a variant put in a first 10, from the journey up to the focus and the source's title, abstract and subjects: 9,028 grades. Two LLM judges agree with each other and with the 58 judgments of #11 within one grade (weighted kappa 0.89). That shows consistency, not truth: no clinician has checked the grades.

**Measurements.**

| Measurement | What it tells |
|---|---|
| nDCG@10 | The main number: do the best known sources stand at the top of the first 10? |
| Grade 0 in the first 10 | Sources on the wrong disease or setting, the ones that confuse a patient |
| First three events against later ones | The start of a journey has little to search |
| Place of the metadata index's best hit | A guard: a change must not push it out of the first 10 more often |
| Grade-3 sources that fall below place 20, and points that lose 0.15 or more | Read one by one before a change is kept |

**nDCG@10** (normalized discounted cumulative gain at 10) is the usual measure for a ranked list with graded relevance. Each of the first 10 results earns a gain for its grade g (7, 3, 1 or 0), which counts less the further down it stands, and the sum is divided by that of the best possible order of all graded sources:

```math
\mathrm{DCG@10} = \sum_{i=1}^{10} \frac{2^{g_i} - 1}{\log_2(i + 1)}, \qquad \mathrm{nDCG@10} = \frac{\mathrm{DCG@10}}{\mathrm{DCG@10}\ \text{of the best order}}
```

It runs from 0 to 1, and 1 means the ten best known sources in the best order. If ten sources of grade 3 are known, a list with five of them on top and grade-1 sources below scores 0.70. More: our [metrics](matching-evaluation.md#metrics), [Wikipedia](https://en.wikipedia.org/wiki/Discounted_cumulative_gain), and Järvelin and Kekäläinen, "Cumulated gain-based evaluation of IR techniques" (2002), which introduced it.

**Chance.** A difference between two rankings is the mean of the differences per point, with a 95 % interval from 4,000 bootstrap resamples of the points. If the interval includes 0, the difference may be chance. With 129 points, differences below about 0.01 cannot be told from chance.

**Decision rule.** A change was kept only if nDCG@10 rose on the sample and on the holdout, the interval over all points did not go below 0, the guards held, and it was a soft change with one constant: nothing that overrides the merged order, as the title rule below did.

## Results

On 7,914 documents nDCG@10 is 0.72, up from 0.54 before #58 (measured before #57 added 275 full texts, which did not move the new ranking). It is 0.63 on the first three events of a journey and 0.74 later. About 3 of 100 first-10 sources are on the wrong disease or setting. The grades come from an LLM and the journeys are synthetic: the numbers compare rankings, they do not say how good the results are for patients.

**What #58 changed.**

| Now | Before |
|---|---|
| Every word of the journeys is translated, skipped, read as negated or marked generic | One translation list: "keine Fernmetastasen" searched distant metastases, and filler words like "is" were searched |
| The focus counts 12 times, and only the 10 context terms that the most older events name are searched | The focus counted 3 times and every older term once: late in a journey the history outweighed the current step |
| Without a full text, the metadata rank of a document counts for its full text too | Two thirds of the documents have no full text, and they ranked below every document that has one |
| The participants of a tumor board and a stable PSA trend are not searched | "Strahlentherapie" among the participants searched radiotherapy at a decision for surgery, and "stable" found papers on stable disease under a therapy |
| 29 more PubMed queries for the events of the journeys: 7,914 documents instead of 5,388 | The crawl did not cover e.g. bone metastases, BRCA2 or PI-RADS |

The first three brought most of the gain (about +0.16 when first measured), the others the rest.

**Variants against the built ranking,** on all 129 points:

| Variant | Δ nDCG@10 (95 % interval) | Grade 0 in the first 10 (built: 38 of 1,290) |
|---|---|---|
| Focus weight 3 | −0.012 (−0.032 to +0.008) | 26 |
| Focus weight 5 | −0.013 (−0.028 to +0.002) | 30 |
| Focus weight 8 | −0.006 (−0.017 to +0.004) | 33 |
| Focus weight 16 | +0.004 (−0.003 to +0.011) | 42 |
| Focus weight 20 | +0.004 (−0.005 to +0.013) | 45 |
| Focus weight 30 | 0.000 (−0.013 to +0.013) | 43 |
| "stable" searched again | −0.006 (−0.012 to 0.000) | 46 |
| "prostate" as an extra query term | 0.000 (−0.002 to +0.002) | 36 |
| Titles as a third ranking, a quarter of the weight | +0.014 (+0.004 to +0.024) | 40 |
| Bonus for reviews and meta-analyses | +0.026 (+0.015 to +0.036) | 33 |
| No context terms \* | −0.064 (−0.090 to −0.042) | more, also on other diseases |
| 20 context terms \* | −0.018 (−0.029 to −0.008) | about the same |
| Hits with a focus term in the title first \* | −0.004 (−0.022 to +0.013) | about the same |
| No stand-in for a missing full text \* | about −0.2 | about the same |

\* Measured before #57's full texts. "No context terms" and "no stand-in" bring sources into the first 10 that have no grade and count as 0, so their loss is overstated.

**What the numbers say.**

- **The focus weight is 12, on a plateau.** From 3 to 30 no weight differs from 12 beyond chance; only a weight of 1 is far worse (about −0.2), as the context then outweighs the focus. A higher weight brings more sources on the wrong disease or setting, a lower one fewer: 12 is a middle value, and 8 would serve as well.
- **No extra rule for the title.** Ranking the hits with a focus term in their title before all others, as #58 did first, gained nothing and put the metadata index's best hit outside the first 10 in 39 of 129 points, once at place 82. The title is in the metadata index already.
- **Context: the 10 terms that the most older events name,** the more recent first on a tie. Without context, more hits are on other diseases; 20 terms rank worse. A weight that falls with each newer event dropped a surgery from the context of later check-ups.
- **A stable PSA trend is not searched.** Of the first-20 sources with "stable", 43 % fit the patient, against 75 % of the others. The gain is small and its interval ends at 0; it was kept because it removes 8 of 46 sources on the wrong disease or setting. Leaving out "initial" too ranked worse.
- **Both indexes weigh the same.** A full-text weight of 0.5 or 2, another rank constant and 300 candidates per index changed nothing.
- **Tried, without a gain or worse:** ranking by the number or the rarity of the focus terms found, separate queries for focus and context, putting hits that share no term with an older event last, other BM25 constants, score fusion instead of rank fusion, pseudo-relevance feedback, context terms chosen by rarity, and each word of the focus once.
- **Open, with a gain:**
  - The bonus for reviews. But 71 % instead of 54 % of the first 10 are then reviews, videos and podcasts never get it, and the metadata index's best hit leaves the first 10 in 3 more points. What the app should show is not a ranking question.
  - The titles as a third ranking. But the gain is within chance on the holdout journeys, and it needs a third index and query.

## Checking a change

Save the answers of `match_journey` for the points of the [matching evaluation](matching-evaluation.md#compare-matchers) before and after a change, on the same documents, and compare the metrics and the ranks of the judged sources. A source without a grade counts as 0: a list can get better while its nDCG falls, so read the lists too.

To compare ranking variants, grade every source that one of them puts in its first 10 for a point, so that no compared source counts as 0. #58 did this with an LLM; its 9,028 grades for the 129 points are in [`keyword-llm-judgments.json`](../matcher/evaluation/keyword-llm-judgments.json), with `set` telling the journeys to choose a change on (`sample`) from those to confirm it on (`holdout`):

```sh
cd matcher
pnpm --filter @matcher/evaluation evaluate ../runs/keyword evaluation/keyword-llm-judgments.json
```

The file covers what the keyword ranking found. Another approach's first 10 will hold sources without a grade there. The LLM agrees with the 58 judgments of #11 within one grade (weighted kappa 0.89), which shows that the two are consistent, not that either is right: no clinician has checked them.

## Known limitations

**Matching by words.** What this approach cannot do, whatever its constants:

- **Words, not what a text is about.** The matcher counts shared words. A paper that names PSA ranks like a paper about PSA, and olaparib for breast cancer matches a prostate cancer patient on olaparib.
- **No relation between words.** A term of several words is searched word by word ("bone density" also finds bone metastases), and nothing ties a finding to its setting: "PSA rising after surgery" is three words, each also found in a paper on something else.
- **Only what the journey names.** Synonyms and paraphrases outside the term list are missed, and so is what matters at a step without being written down: continence after surgery, the side effects of a therapy.
- **No numbers.** A PSA of 0.4 and one of 40 give the same query.
- **No sense of disease or phase.** Nothing tells the matcher which disease a journey is about or which older events still matter. A term that fits several diseases finds them all, and a long series of check-ups outweighs one surgery in the context.
- **Little to search at the start of a journey:** one common term and no context.
- **The order among matching papers is the ceiling.** Most good sources hold every focus term, and word counts decide which of them comes first. The best order of the first 20 would reach about 0.94, the ranking reaches 0.72. The rest needs meaning, the job of the other approaches.
- **One vote per index.** A paper that the metadata index ranks first lands outside the first 10 when its full text ranks low (13 of 129 points). Other weights ranked no better.

**This version**

- **Hand-made term lists.** They cover the 20 synthetic journeys (#14). An unknown German word finds nothing, an unknown generic word counts as medical, and a finding negated in an unlisted way ("frei von", "o. B.") is searched as if present. To be extended for AIlixir's data (#44).
- **Tuned on synthetic prostate cancer journeys with LLM grades.** Real journeys may need other constants (#44).
- **Keyword filter.** It drops a few medical words ("doctor", "rising" for "rise") and keeps rare non-medical ones (names, typos).
- **Scores** compare within one list only, not between journeys or algorithms.

**Downloader and extractor** ([`@matcher/download`](../matcher/download/src/))

- **Most papers have no full text.** A PubMed paper needs a PMCID or an open-access PDF whose host allows the download: 34 % of the stored documents have a full text.
- **No video; audio only with speech-to-text.** YouTube gives captions only to a video's owner. Podcast audio is read only with `WHISPER_MODEL` set ([podcasts](sources/podcasts.md#indexing)); without it, episodes without a transcript have metadata only.
- **Text files only:** PDF, XML, HTML, plain text and transcripts. Not read: Word and PowerPoint files, images, archives, podcast show notes and scanned PDFs (no OCR).
- **One file per document:** the first of up to three that gives text, at most 50 MB.
- **English only.** Other texts keep their metadata only, and the references cut needs an English heading.
- **PDFs keep page headers, footers and formulas;** XML and HTML drop them.
- **arXiv is slow:** one request every 15 s, over four hours for 1,000 papers.
- **Sources are trusted:** downloads follow redirects to any address, and PDF parsing has no time limit.
