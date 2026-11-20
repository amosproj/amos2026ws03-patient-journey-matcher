# Synthetic Patient Journeys

A total of 20 synthetic prostate cancer patients were generated using `meddocgenerator` for development and testing. Generation was performed in two runs of ten patients each:

- Run 1: Patient-1 to Patient-10
- Run 2: Patient-11 to Patient-20

## Run Configuration

The following commands were used:

```bash
uv run medgen generate --pathway all --n 10 --start 1 --n-doctors 4 --n-clinics 3 --style dynamic --output ./output
```

```bash
uv run medgen generate --pathway all --n 10 --start 11 --n-doctors 4 --n-clinics 3 --style dynamic --output ./output
```

The parameters have the following meanings:

| Parameter | Description |
|---|---|
| `--pathway all` | Uses all ten available clinical pathways. |
| `--n 10` | Generates ten patients in total per run. |
| `--start 1` / `--start 11` | Sets the starting index for patient identifiers. |
| `--n-doctors 4` | Configures a pool of four doctors per run. |
| `--n-clinics 3` | Configures a pool of three clinics per run. |
| `--style dynamic` | Uses the writing style assigned to each physician when LLM enrichment is enabled. |
| `--output ./output` | Saves the results in a run-specific subdirectory of `./output`. |

The pool sizes apply to each generation run. They do not imply that all four physicians and all three clinics appear in every patient's documents.

## Clinical Pathway Coverage

With `--pathway all`, patients are assigned sequentially to the available pathways, sorted by pathway ID.

| Pathway | Patients | Risk Group | Clinical Pathway |
|---|---|---|---|
| p01 | 1, 11 | low | Low-risk disease – Active surveillance |
| p02 | 2, 12 | high | Locally advanced disease – Primary androgen deprivation therapy (ADT) |
| p03 | 3, 13 | intermediate_favorable | Localized disease – Radical prostatectomy (RP) |
| p04 | 4, 14 | intermediate_unfavorable | RP + Adjuvant radiotherapy (pT3a R1) |
| p05 | 5, 15 | intermediate_favorable | RP + Biochemical recurrence – Salvage therapy |
| p06 | 6, 16 | intermediate_unfavorable | Primary radiotherapy + ADT (IMRT + goserelin) |
| p07 | 7, 17 | metastatic | Metastatic disease – Chemotherapy + Radionuclide therapy (radium-223) |
| p08 | 8, 18 | metastatic | Metastatic disease – Modern hormonal therapy (abiraterone → enzalutamide) |
| p09 | 9, 19 | intermediate_favorable | Early recurrence after RP – Salvage radiotherapy + ADT |
| p10 | 10, 20 | metastatic | Advanced disease – Targeted therapy (BRCA2 + PARP inhibitor) |


All patient cases concern prostate cancer. 
Depending on the pathway, they differ in 
- risk group
- disease stage
- findings
- treatment
- clinical course

This results in different clinical events and different combinations and numbers of documents.

### Files per patient

Each `Patient-<n>/` folder holds one PDF and one HTML file per document, named `<type>_e<event>` after the event it belongs to, plus `timeline.json`; Patient-5 also has `graph.json`.

| File prefix | Document type |
|---|---|
| `ueberweisungsbrief` | Referral letter |
| `einweisungsbrief` | Admission letter |
| `entlassungsbrief` | Discharge letter |
| `arztbrief` | Medical letter |
| `laborbericht` | Laboratory report |
| `befundbericht` | Findings report, such as imaging |
| `pathologiebericht` | Pathology report |
| `op_bericht` | Operative report |
| `tumorkonferenzprotokoll` | Tumor board report |
| `verlaufsbericht` | Follow-up report |
| `palliativbericht` | Palliative care report |

`timeline.json` holds the structured clinical events with these fields:

| Field | Description |
|---|---|
| `patient_id` | Synthetic patient identifier matching the folder name. |
| `pathway_id` | Clinical pathway identifier, from `p01` to `p10`. |
| `start_date` | Journey start date in `YYYY-MM-DD` format. |
| `events` | List of clinical events. |

Each event contains `id`, `type`, `label`, `date`, `specialist`,
`parameters`, `documents`, and `repeat_index`. The `parameters` object
contains event-specific clinical details. The `documents` list identifies
the document types generated for that event. `repeat_index` identifies
repeated events where applicable and is otherwise `null`.

A `graph.json` holds the patient graph that the SS26 graph steps build from the PDFs of a patient. It is the input of the graph reader (`matcher/mcp-server/src/graph.ts`). Every patient has one. `make graph PATIENT=Patient-5` builds it ([patient graph tool](../tools/patient-graph/README.md)); how the server reads it: [patient graph](../Documentation/user/mcp-interface.md#patient-graph).

| Field | Description |
|---|---|
| `patient` | Synthetic patient identifier matching the folder name. |
| `documents` | The PDFs that are in the graph, in the order they were read. The graph is complete when it lists every PDF of the folder. |
| `nodes`, `edges` | The graph as Graphiti holds it, without the embeddings. |

### Generated graphs

All 20 graphs are complete: each holds every PDF of its patient, 569 PDFs in total. Together they have 599 nodes and 2993 edges. `graph.test.ts` reads each graph with the graph reader and checks three things: the graph follows the schema of the reader, its `documents` are the PDFs of the folder, and its days are the days of the `timeline.json`.

| Patient | PDFs | Nodes | Edges | Days with a fact, of the days in the timeline |
|---|---|---|---|---|
| Patient-1 | 20 | 15 | 83 | 13 of 13 |
| Patient-2 | 18 | 23 | 83 | 12 of 12 |
| Patient-3 | 23 | 23 | 94 | 16 of 16 |
| Patient-4 | 24 | 28 | 114 | 17 of 17 |
| Patient-5 | 35 | 34 | 174 | 23 of 23 |
| Patient-6 | 26 | 28 | 128 | 17 of 17 |
| Patient-7 | 43 | 37 | 241 | 23 of 23 |
| Patient-8 | 36 | 30 | 199 | 22 of 22 |
| Patient-9 | 30 | 27 | 145 | 21 of 21 |
| Patient-10 | 40 | 48 | 229 | 23 of 23 |
| Patient-11 | 14 | 16 | 70 | 10 of 10 |
| Patient-12 | 22 | 27 | 100 | 14 of 14 |
| Patient-13 | 21 | 19 | 95 | 15 of 15 |
| Patient-14 | 18 | 28 | 88 | 14 of 14 |
| Patient-15 | 29 | 37 | 157 | 21 of 21 |
| Patient-16 | 20 | 26 | 116 | 14 of 14 |
| Patient-17 | 45 | 40 | 259 | 24 of 24 |
| Patient-18 | 36 | 28 | 208 | 22 of 22 |
| Patient-19 | 30 | 36 | 161 | 20 of 21 |
| Patient-20 | 39 | 49 | 249 | 23 of 23 |

**How they were built.** All with the model `gemini-3.5-flash-lite`, not with `gemini-2.5-flash` that SS26 uses. Patient-5 was built first, on 11 and 15 November 2026 with a free API key, which allows `gemini-2.5-flash` only 20 requests a day. The other 19 were built on 18 November 2026 with a paid key, four patients at a time. A document then took about 20 s instead of 90 s.

**Incomplete graph.**

- **Patient-19 has no fact for 9 November 2026.** The laboratory report of that day (`laborbericht_e02.pdf`) is in the graph, but the only fact it added is that the patient was at the laboratory, and the reader leaves out facts about a provider. Its PSA value of 7.0 ng/ml was already in the graph, from the referral letter of 6 November, so Graphiti did not add it again. The journey from this graph has 20 events instead of 21. No value is lost.

**Failures while generating.**

- **A call that never answered.** In the run of Patient-20 one call to Gemini did not come back, and the run stood still for 40 minutes at document 27 of 39. Since then the script stops a document after 10 minutes, like a rate limit.
- **A database that did not open again.** After that run was stopped by hand, the Kuzu database of Patient-20 crashed on opening. It was deleted and the patient was built again from the first document. The other patients were not affected.
- **Answers that could not be read.** Four times Graphiti got an answer from the model that was cut off in the middle (Patient-7, Patient-14, Patient-18, Patient-19). It asked again and went on.
- **Wrong numbers of duplicate facts.** Six times the model named a duplicate fact that does not exist (three times for Patient-5, once each for Patient-11, Patient-18 and Patient-20). Graphiti ignores such a number, so one fact may be in the graph twice.

**Limits.**

- **A second run gives another graph.** The model does not answer the same way twice, so the names of nodes and the number of edges differ between two runs of the same patient.
- **Nobody has read the facts.** The checks are about the form and the days. Whether each fact is medically right was not checked.
- **`gemini-2.5-flash` is deprecated.** From 1 December 2026 Google sends its calls to `gemini-3.5-flash-lite`, the model used here.

## Decision on the LLM Layer

Template-based patient journeys without an LLM layer are sufficient for the intended development and testing purposes. In the sample comparison, the relevant clinical information and timelines were already represented. LLM enrichment mainly changed wording and text length; it did not provide substantial additional value for our tests. The reviewed LLM document set also contained inconsistencies in patient demographics and the chronological presentation of findings.

## Generator Version

The dataset was generated using
[meddocgenerator](https://github.com/andizink/meddocgenerator)
at commit `7901b8fe3b691629c7a8c2b4e20c8d4bcf8264a9`.