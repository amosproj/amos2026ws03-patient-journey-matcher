# Keyword tuning

How the ranking of the [keyword approach](../Documentation/design/keyword-matching.md) was tuned and measured in #58. The approach itself is described there; this page holds the method, the measurements and the variants that were tried.

## Method

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
| Every word of the journeys is translated, skipped or marked generic | One translation list: filler words like "is" were searched |
| Negated findings are left out, by listed words and phrases that each have their reach: "keine Fernmetastasen", "Lymphknoten nicht befallen", "PSA nicht mehr nachweisbar" (searches PSA) | No negation: "keine Fernmetastasen" searched distant metastases |
| The focus counts 12 times, and only the 10 context terms that the most older events name are searched | The focus counted 3 times and every older term once: late in a journey the history outweighed the current step |
| Without a full text, the metadata rank of a document counts for its full text too | Two thirds of the documents have no full text, and they ranked below every document that has one |
| The participants of a tumor board and a stable PSA trend are not searched | "Strahlentherapie" among the participants searched radiotherapy at a decision for surgery, and "stable" found papers on stable disease under a therapy |
| 29 more PubMed queries for the events of the journeys: 7,914 documents instead of 5,388 | The crawl did not cover e.g. bone metastases, BRCA2 or PI-RADS |

The first three brought most of the gain (about +0.16 when first measured), the others the rest.

**Variants against the built ranking,** on all 129 points. The focus weight is a trade-off: raising it brings more sources that fit the focus exactly into the first 10, and more on the wrong disease or setting; lowering it does the reverse.

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

- **The focus weight trades two things, and 12 is a middle value.**
  - Higher: the current event dominates. More sources of grade 3 (760 at a weight of 20, 703 at 3), so nDCG@10 rises a little, within chance.
  - Lower: the older events anchor the disease and the phase. Fewer sources of grade 0 (12 fewer at 3, 7 more at 20, both beyond chance), but some of grade 3 give way to grade 2.
  - nDCG@10 counts a grade 3 more than twice as much as a grade 2, so it leans to the higher weight. If sources that confuse a patient weigh more, a lower weight such as 8 is the better choice. Only a weight of 1 is far worse (about −0.2): the context then outweighs the focus.
- **No extra rule for the title.** Ranking the hits with a focus term in their title before all others, as #58 did first, gained nothing and put the metadata index's best hit outside the first 10 in 39 of 129 points, once at place 82. The title is in the metadata index already.
- **Context: the 10 terms that the most older events name,** the more recent first on a tie. Without context, more hits are on other diseases; 20 terms rank worse. A weight that falls with each newer event dropped a surgery from the context of later check-ups.
- **A stable PSA trend is not searched.** Of the first-20 sources with "stable", 43 % fit the patient, against 75 % of the others. The gain is small and its interval ends at 0; it was kept because it removes 8 of 46 sources on the wrong disease or setting. Leaving out "initial" too ranked worse.
- **Both indexes weigh the same.** A full-text weight of 0.5 or 2, another rank constant and 300 candidates per index changed nothing.
- **Tried, without a gain or worse:** ranking by the number or the rarity of the focus terms found, separate queries for focus and context, putting hits that share no term with an older event last, other BM25 constants, score fusion instead of rank fusion, pseudo-relevance feedback, context terms chosen by rarity, and each word of the focus once.
- **The order among matching papers is the ceiling.** The best order of the first 20 would reach about 0.94, the ranking reaches 0.72.
- **One vote per index.** In 13 of 129 points the metadata index's best hit lands outside the first 10 because its full text ranks low.
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

## Keyword filter

On 50 full texts the filter of basic words keeps 42 % of the words; of 80 medical test words it drops only "doctor".
