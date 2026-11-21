# Graph approach: normalization

The first part of the graph approach (#10): patient graphs and PubTator3 annotations in one representation, so that graph matching can compare them (#80). Why and how: [graph normalization](../../../Documentation/graph-normalization.md). The indexer and the matcher are not built yet, so the approach is not in the [registry](../../approaches/src/registry.ts).

## What normalization means

The patient record and a paper say the same things in different words, IDs and relation types:

|           | Patient graph                                                | PubTator3 annotations of a paper                              |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Disease   | `C61 Prostatakarzinom`, `Adenokarzinom der Prostata`         | `Prostatic Neoplasms` (`MESH:D011471`)                        |
| Treatment | edge `TREATED_BY`, from the disease to the drug              | relation `Negative_Correlation`, from the drug to the disease |
| Certainty | `Vd. a. Prostatakarzinom` (suspected), confirmed weeks later | none: what the abstract states                                |

Compared as text, they would hardly ever match. Normalization rewrites both into one form:

```
patient:  mesh:C531550 (olaparib)  treats  mesh:D011471 (prostate cancer)   asserted, from 2026-12-08
paper:    mesh:C531550 (olaparib)  treats  mesh:D011471 (prostate cancer)   score 0.998
```

It gives every name a shared ID, maps every edge and relation type to one set of predicates with one direction, and gives each patient statement a status (`asserted`, `suspected`, `negated`, `planned`, `unknown`). It does not rank papers: that is the matcher, which compares the two normalized sides.

The two inputs start out differently. The patient side is already a graph (nodes and edges built from the patient's documents); normalization translates it and leaves out what is administrative, such as providers and appointments. The PubTator3 side is not a graph: it is the entities PubTator3 found in the title and abstract, and the relations it found between them; normalization builds a graph from them. Both come out as the same `NormalizedGraph`.

```ts
import {
  normalizePatientGraph,
  normalizePubTatorDocument,
} from "@matcher/graph";

const patient = normalizePatientGraph(graphJson); // graph.json of the SS26 pipeline
const paper = normalizePubTatorDocument(biocJson, { minScore: 0.5 }); // one PubTator3 document
```

Both return a `NormalizedGraph` ([`types.ts`](src/types.ts)):

| Field       | Content                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entities`  | `id` (`mesh:D011471`, `ncbigene:675`, or `null`), `type`, `name`, `names`, `resolvedBy`, the source labels and IDs. `key` is unique in the graph and is what relations and facts point to |
| `relations` | `subject`, `predicate`, `object` as entity keys, `status`, the fact sentence or the score, `validAt` and `invalidAt`, and the origin                                                      |
| `facts`     | patient side only: `has_condition`, `receives`, `has_finding` of an entity, with the same fields                                                                                          |
| `skipped`   | what was left out or could not be read, with the reason; one bad node or edge does not reject the graph                                                                                   |

Only entities with an `id` can match across graphs.

## Files

| File                                                          | Content                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/patient.ts`                                              | `normalizePatientGraph`: resolves and merges nodes, maps edges, sets status                      |
| `src/pubtator.ts`                                             | `normalizePubTatorDocument`; `pubTatorDocuments` splits an export                                |
| `src/resolve.ts`                                              | Entity resolution: ICD code, then the dictionaries in order; more can be passed in               |
| `src/status.ts`                                               | Status from cue words in a sentence and from node attributes                                     |
| `src/relations.ts`                                            | Reads the two relation tables                                                                    |
| `src/text.ts`                                                 | `normalizeName`, used for every lookup                                                           |
| `data/concepts.json`                                          | Curated names → IDs, with the type of each concept                                               |
| `data/icd10-mesh.json`                                        | ICD-10 → MeSH                                                                                    |
| `data/patient-relations.json`, `data/pubtator-relations.json` | Edge and relation types → shared predicates                                                      |
| `data/status-cues.json`                                       | Cue words, windows, clause breaks, attribute values                                              |
| `data/outcomes.json`                                          | Outcomes such as Death, which are not diseases to match                                          |
| `fixtures/pubtator/`                                          | Trimmed PubTator3 exports of three papers, for the tests ([README](fixtures/pubtator/README.md)) |
| `scripts/normalize.ts`                                        | Prints the normalized form of a file                                                             |

Most changes are data: a missing name is a row in `concepts.json`, a new edge type a row in a relation table, a new cue a row in `status-cues.json`. The tests read the same files, and `src/data.test.ts` checks the files against each other and against the types, so a typo in a row fails a test.

## Try it

From the repository root:

```sh
pnpm --dir matcher --filter @matcher/graph normalize patientdata/Patient-5/graph.json
pnpm --dir matcher --filter @matcher/graph normalize matcher/algorithms/graph/fixtures/pubtator/32343890.json --min-score 0.5
```

A path is meant from where the command is typed. The options may stand before or after it: `--min-score <0-1>` (papers only) leaves out relations with a lower PubTator3 score, `--json` prints the whole `NormalizedGraph` instead of the summary. The debug UI reads that JSON.

The summary has up to four sections. A number in front of a line counts how many edges or items gave it.

```
Entities: 13 of 13 with an ID
  mesh:C531550       pubtator chemical  Olaparib / olaparib

Patient facts: 80
  25 has_condition Prostatic Neoplasms (asserted)
   2 has_condition Prostatic Neoplasms (suspected)

Relations: 10
  1 olaparib treats Prostatic Neoplasms (asserted, 0.9978)
  1 olaparib improves_outcome Death (asserted, 0.9975)

Left out: 3
  1 10 Species annotations left out
  1 score 0.4297 below 0.5
```

| Section       | Each line                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entities      | The shared ID, how it was found (`icd`, `curated`, `pubtator`, or `-`), the type, and every name it came with. `(no ID)` can never match the other side: the gap to close with a row in `concepts.json` |
| Patient facts | Patient side only: what the patient has, receives or was found to have, with the status                                                                                                                 |
| Relations     | Subject, predicate, object, the status and, for papers, the score. `treats Death` became `improves_outcome`, so Death never matches a patient's disease                                                 |
| Left out      | What was not taken, by reason                                                                                                                                                                           |

Run it after adding rows to the data files, to see the `(no ID)` lines go, and on every new graph of `make graph`.

## Check it in the debug UI

`make debug`, then the **Graph** screen at http://127.0.0.1:8765 shows the same result, with the sentence and cue behind each status. With the files in the repository:

| Graph                       | Expect                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Patient-5                   | 34 / 174 nodes and edges, 8 of 14 entities with an ID, 80 facts, 17 relations, 77 left out                                     |
| Patient-5, Statements       | Prostate cancer is `suspected` on 2026-11-12 (cue `verdacht auf`), never `asserted` before 2026-12-08, `asserted` from then on |
| Patient-5, Left out         | The `CONFIRMED_BY` edge: "both ends are the same entity; confirms it from 2026-12-08"                                          |
| 32343890, minimum score 0   | 42 / 12 annotations and relations, 13 of 13 entities with an ID, 12 relations, 1 left out (10 Species annotations)             |
| 32343890, minimum score 0.5 | 10 relations; the Cotreatment (0.43) and one Comparison (0.38) are left out for their score                                    |

A change to the code or the data that moves these numbers changes what matching gets, so it should be on purpose. The Patient-5 statuses are also explained in the design doc, §4.5.
