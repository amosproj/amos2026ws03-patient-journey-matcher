# Matching evaluation

How we decide if a matched source is relevant for a patient journey, and how we compare the keyword, graph and AI summary matchers (#11). The judgments are in [`matcher/evaluation/judgments.json`](../matcher/evaluation/judgments.json), the metrics runner is in [`matcher/evaluation/`](../matcher/evaluation/src/).

## Goal

The results go to the "For you" section of the AIlixir app. They should help the patient understand their situation, not give medical advice (partner meeting, 06.11.). So a good result fits where the patient is now, and a bad result is one that confuses or worries them, like a paper about a stage they don't have.

## Evaluation points

We don't judge a whole journey, we judge it at one point in time. An evaluation point is a journey cut at a date (`as_of`). This is how the app will call us: AIlixir wants matching to run again when a new report comes in, not live.

- The **focus** is the latest event on or before `as_of`.
- The **context** is every older event that still matters, see [Recent events and context](#recent-events-and-context).
- We pick points right after a report that changes something: a diagnosis, a decision, a progression or a follow-up. Never after the patient died, because some synthetic journeys end that way.

The first 10 points use one journey per pathway from the synthetic journeys of #14 (Patient-1 to Patient-10). Patient-11 to Patient-20 have the same pathways and stay free as a second set, so we can check later that a matcher was not tuned to the first 10.

| Point | Pathway | Focus at `as_of` |
|---|---|---|
| `patient-1-e07` | Active surveillance | First follow-up under active surveillance |
| `patient-2-e08` | Primary ADT | Follow-up under hormone therapy, bone density |
| `patient-3-e10` | Radical prostatectomy | First PSA check after surgery, PSA undetectable |
| `patient-4-e11` | Adjuvant radiotherapy | Follow-up after radiotherapy for a positive margin |
| `patient-5-e15` | Salvage therapy | Biochemical recurrence after surgery |
| `patient-6-e09` | Radiotherapy plus ADT | Follow-up during radiotherapy plus ADT |
| `patient-7-e16` | Radium-223 | Castration-resistant disease with bone metastases |
| `patient-8-e18` | Enzalutamide | PSA rising under enzalutamide |
| `patient-9-e15` | Salvage radiotherapy | Tumor board: salvage radiotherapy with short ADT |
| `patient-10-e12` | PARP inhibitor | Progression under olaparib, BRCA2 mutation |

## What makes a match relevant

We grade each source for one evaluation point, from its title and abstract (or description for videos and podcasts).

| Grade | Meaning | Example |
|---|---|---|
| 3 | Fits the focus: the current situation, an ongoing treatment or its side effects, or the likely next step | Guideline on decisions at biochemical recurrence, for `patient-5-e15` |
| 2 | Fits the context: an older event that still matters, a trend, or the disease state | Pelvic floor training for incontinence after surgery, for `patient-3-e10` |
| 1 | Right disease, but generic, a past phase, or a different situation | PSA that stays high after surgery, for `patient-3-e10` whose PSA is undetectable |
| 0 | Wrong disease or population, or a phase that does not apply to this patient | PSA screening, for `patient-5-e15` |

Rules that came up while judging:

- The same source gets different grades at different points. An active surveillance review is a 3 for `patient-1-e07` and a 0 for `patient-7-e16`.
- Words are not enough. Olaparib for breast cancer shares "BRCA" and "olaparib" with `patient-10-e12` and is still a 0. These near misses are the most useful judgments, because a keyword matcher falls for them.
- Lab research with no patient outcomes (cell lines, molecular mechanisms only) gets at most a 1.
- A treatment the patient did not get, in a setting he is not in, is a 1 or 0. ADT with radiotherapy after surgery is a 1 for `patient-6-e09`, who had radiotherapy without surgery.
- Source type, language and publication date don't change the grade. We report them separately later if needed.

## Recent events and context

AIlixir said older events can stay relevant depending on the medical context and trends (partner meeting, 06.11.). An older event counts as context when one of these is true:

- **It defines the disease.** Gleason score, stage, metastases or a BRCA2 mutation matter for the rest of the journey.
- **Its effects continue.** After a prostatectomy, continence and erectile function matter for years. Under ADT, bone and heart side effects matter for as long as the therapy runs.
- **It is part of a trend.** Several PSA values together show a rise or a fall, which one value alone does not.
- **It explains the next step.** A positive margin explains why radiotherapy follows the surgery.

An older event stops counting when its phase is over and has no lasting effect, like the screening PSA once the patient has a recurrence, or active surveillance once he had surgery. Each point in `judgments.json` lists its context events with the reason, so a matcher can be checked against them.

## Metrics

The runner computes four numbers for every point and their mean over all points.

| Metric | What it tells us |
|---|---|
| `ndcg_10` | Main score. Are the best sources at the top of the first 10? Uses the grades 0 to 3, 1 is perfect |
| `precision_5` | How many of the first 5 have grade 2 or 3. The "For you" section shows only a few cards |
| `off_target_10` | How many of the first 10 have grade 0. Should be close to 0, because these confuse patients |
| `judged_10` | How many of the first 10 have a grade at all. Unjudged sources count as 0, so a low value means the scores are too low and we need to judge more |

A point with no result file scores 0, so every matcher is compared on all points.

## Compare matchers

The same steps work for every matcher we add later.

1. For each point, call `match_journey` with the whole `timeline.json` of the journey, `as_of` from the point and the matcher as `algorithm`.
2. Save the result as `<point id>.json`, one folder per matcher, for example `runs/keyword/patient-5-e15.json`.
3. Run the evaluation:

   ```sh
   cd matcher
   pnpm --filter @matcher/evaluation evaluate ../runs/keyword
   ```

4. The runner lists the sources in the first 10 that have no grade yet ("Judge next"). Grade each one with the rules above and add it to `judgments.json`. If you are unsure, ask a second person.
5. Run the evaluation again for all matchers, then compare the means.

The test in `matcher/evaluation/src/evaluate.test.ts` checks that `judgments.json` stays valid after each edit.

## Status of the judgments

The first 58 judgments (5 to 7 per point) were graded from the PubMed titles and spot-checked against the abstracts in review. They use real PubMed records that a matcher can also find, with the `source_id` the crawler uses (`pubmed:<PMID>`). If a grade turns out wrong, fix it in `judgments.json` with a short note.

## Open questions

1. Andi will send journeys generated with an LLM. Do we switch the points to those, or keep the journeys without LLM?
2. The real app sends the whole patient graph, not `timeline.json` (#44). The points then need the same cut at `as_of` in the graph format.
3. Who judges videos and podcasts, and from what: description or transcript?
4. Are 10 points enough to see a difference between two matchers, or do we need the second 10 as well?
