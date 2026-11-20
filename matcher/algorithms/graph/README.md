# Graph approach: normalization

The first part of the graph approach (#10): patient graphs and PubTator3 annotations in one representation, so that graph matching can compare them (#80). Why and how: [graph normalization](../../../Documentation/graph-normalization.md). The indexer and the matcher are not built yet, so the approach is not in the [registry](../../approaches/src/registry.ts).

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
| `skipped`   | what was left out, with the reason                                                                                                                                                        |

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

Most changes are data: a missing name is a row in `concepts.json`, a new edge type a row in a relation table, a new cue a row in `status-cues.json`. The tests read the same files.

## Try it

From the repository root:

```sh
pnpm --dir matcher --filter @matcher/graph normalize patientdata/Patient-5/graph.json
pnpm --dir matcher --filter @matcher/graph normalize matcher/algorithms/graph/fixtures/pubtator/32343890.json --min-score 0.5
```

It lists each entity with its ID and tier (or `(no ID)`), the patient facts and relations with their status, and what was left out. `--json` prints the whole `NormalizedGraph`.
