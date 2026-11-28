# Document pre-filter (#92)

Can cheap rules or a small classifier drop documents that help no patient, before they are indexed? We tested both on the VM's `documents` table (612,527 documents, 28 November 2026).

**Result: no.** No approach meets both bars at once. The only safe rule drops 0.04% of the table. Every rule that drops 2% or more also drops many documents that could help a patient. The classifier finds no safe cut-off at all. So nothing is dropped automatically. A rule only proposes drops (`scripts/prefilter.py propose-drops`, `erratum` by default), and a person drops or keeps each one in the Drops tab of the Pre-filter screen. Only a dropped document leaves the indexes and the match results.

## Question and success criteria

A document is **unhelpful** if it helps no patient with any disease:

- **Group 1, not usable for patients:** pure lab or animal work, pure methods or statistics papers, topics only about clinicians' work.
- **Group 2, little information:** errata, corrections, and letters, comments or editorials that only react to another paper, and documents whose title and summary say nothing usable.

A missing summary alone does not make a document unhelpful: if the title shows a useful paper, it is kept. Lab work about a drug patients take, regional statistics and rare patient subgroups are kept too. In doubt, keep. The full guide is in [`prefilter/labels.json`](prefilter/labels.json).

Fixed before measuring:

| Bar | Condition |
|---|---|
| Safety | At most about 1 in 100 dropped documents should have been kept: at most 1 wrong in a random sample of 300 drops |
| Usefulness | Drops at least 2 to 3% of all documents |
| Speed and cost | VM CPU only, no paid API, a pass over all documents in one night |
| Baseline | Rules first; the classifier must drop clearly more than the rules while staying safe |

## Method

1. **Approaches.**
   - **Rules:** SQL conditions on the document's metadata.
   - **Classifier:** a logistic regression on the Qwen3-Embedding-0.6B vectors that the AI index already stores. It only judges documents the rules keep. Its cut-off is chosen on out-of-fold scores (5 folds) and must drop at least 100 training documents with at most 1% of them labeled keep.
2. **Samples.**
   - **Training:** 700 documents. 500 were enriched for unhelpful candidates (rule hits, documents the LLM grades of #58 never put above 1, lab-like titles, the rest random). 200 more were the documents the first classifier was surest to drop.
   - **Random test:** 300 documents from the whole table.
   - **Drops:** 300 random rule drops, plus 30 per rule where the 300 held fewer.
3. **Labels.** An LLM proposed a label for every document. Its label counts unless a person changes it in the Pre-filter screen of the [debug UI](../debug/README.md).
   - Claude Opus 5.5 labeled 938 documents, as parallel agents reading 25 documents per batch.
   - Codex labeled 377.
   - Qwen3-4B labeled 123 under an earlier definition; 121 of them were relabeled by Claude, 2 were checked by a person.

   All proposals follow the definition above.
4. **Measure.** `scripts/prefilter.py measure` counts the drops on the whole table and checks the labeled drop samples.

## Results

### Rules

| Rule | Drops in the table | Checked drops | Labeled keep |
|---|---|---|---|
| `erratum`: errata notices and "Correction to …" titles | 269 (0.04%) | 30 | 0 |
| `reaction_without_abstract`: editorial, comment or letter with a summary under 200 characters | 15,254 (2.5%) | 291 | 116 |
| **Both (the rule set)** | **15,521 (2.5%)** | **300** | **116 (39%; 95% upper bound 44%)** |
| Variant: `no_summary` | 35,210 (5.7%) | 289 | 114 |
| Variant: `short_summary` (under 200 characters) | 6,720 (1.1%) | 9 | 2 |
| Variant: `no_summary_no_full_text` | 26,310 (4.3%) | 200 | 79 |

Variants are only reported, not part of the rule set.

- **`erratum` is safe but tiny.** 0 wrong in 30 checked; all 269 such documents exist, so no sample of 300 is possible. PubMed also tags the corrected article itself "Published Erratum", for example a gout guideline and a systematic review. The rule therefore only counts a document that is not also a "Journal Article".
- **`reaction_without_abstract` is not safe.** Many letters without an abstract are research letters, case reports or short trial reports. Their titles show a finding a patient could use.
- **Missing or short summaries are not a safe signal.** That follows from the definition: about 40% of these documents have a title that shows a useful paper.

### Classifier

| Training run | Labels used | Unhelpful | Labeled keep among the 100 lowest scores | Safe cut-off |
|---|---|---|---|---|
| 500 enriched | 268 | 42 | not possible (fewer than 100 unhelpful) | none |
| + 200 low-score | 468 | 144 | 29 | none |
| All labels under the final definition | 509 | 153 | 26 | none |

The classifier ranks documents sensibly: the 10 lowest scores hold 1 document labeled keep. But at 100 drops about a quarter are keep, far from 1%. The embedding mostly captures the topic, while the guide splits on whether the topic is usable: a mouse study of a mechanism versus a mouse study of a drug patients take. Of the 700 training documents, 124 (18%) had no embedding and could not be judged at all.

The fallback in the plan, a small local LLM on the classifier's uncertain band, was not built: the band holds as many keep as unhelpful documents.

### How common unhelpful documents are

In the random sample of 300, 34 documents are unhelpful (11%, 95% interval about 8 to 15%): 23 in group 1 and 11 in group 2. Group 1 needs reading the content, which metadata rules cannot do. Group 2 is about 4% of the table, but most of it looks the same in metadata as short research letters that are kept.

### Speed and cost

All rules over the whole table take 0.4 seconds in Postgres. Scoring with the classifier is one dot product per document. Speed and cost were never the problem.

## Limitations

- **The labels are LLM labels.** A person checked 2 of 1,317. The safety numbers are measured against Claude's judgment, not a person's. The finding is robust to this, since the gap to the bar is large (39% wrong versus 1%). A person reading the drop samples in the Pre-filter screen would make the numbers final.
- **The definition decides the result.** With "a missing summary is group 2", `no_summary` would pass easily. We chose the patient-friendly definition: "in doubt, keep" and "judge by the title".

## Reproduce

Against the VM's database through the SSH tunnel; all connections are read only. See `--help` for the options.

```sh
uv run --locked scripts/prefilter.py sample --set train        # then --low-score --n 200
uv run --locked scripts/prefilter.py import-proposals FILE --model NAME
uv run --locked scripts/prefilter.py train
uv run --locked scripts/prefilter.py sample --set random
uv run --locked scripts/prefilter.py measure                   # label the drop samples, then measure again
```

The labels, the classifier and the results are in [`prefilter/`](prefilter/). The Results tab of the Pre-filter screen shows the results against the bars.
