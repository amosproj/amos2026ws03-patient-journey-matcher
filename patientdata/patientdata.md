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

--> results in different clinical events and different combinations and numbers of documents

### Document types: 
- referral letters
- laboratory reports
- imaging reports
- pathology reports
- tumor board reports
- medical letters
- palliative reports
- follow-up reports

A `timeline.json` containing structured clinical events and contains following fields:

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

## Decision on the LLM Layer

Template-based patient journeys without an LLM layer are sufficient for the intended development and testing purposes. In the sample comparison, the relevant clinical information and timelines were already represented. LLM enrichment mainly changed wording and text length; it did not provide substantial additional value for our tests. The reviewed LLM document set also contained inconsistencies in patient demographics and the chronological presentation of findings.

