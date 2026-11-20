# Graph normalization: entity and relation types

For #80. Graph matching ([research](research/Graph-based-matching.md)) compares triples from two sources: the patient graph and the PubTator3 annotations of a paper. Before the two can be compared, both have to use the same entity types, IDs and relation types. This page lists what each source holds and how it maps to the shared representation. The code is in [`matcher/algorithms/graph/`](../matcher/algorithms/graph/README.md).

Sources of the inventory:

- **Patient:** the types in [Patient graph](mcp-interface.md#patient-graph), checked against [`patientdata/Patient-5/graph.json`](../patientdata/Patient-5/graph.json). It is the only patient graph so far: 34 nodes and 174 edges. Counts below are from this one sample.
- **Resource:** the PubTator3 BioC JSON export (`/research/pubtator3-api/publications/export/biocjson?pmids=…`), checked on PMIDs 32343890 (olaparib in prostate cancer), 30345884 (olaparib in ovarian cancer) and 35923949 (degarelix vs. leuprorelin), on 20 November 2026. The trimmed exports are the [test fixtures](../matcher/algorithms/graph/fixtures/pubtator/README.md).

## 1. Patient graph

### Nodes

Every node carries the label `Entity` plus its type. Only `Diagnosis` has a code (`icd_code`, ICD-10). No node has a MeSH ID.

| Type | In Patient-5 | Fields of note | Shared type |
|---|---|---|---|
| `Patient` | 1 | `patient_id`, `gender`, `date_of_birth` | none: the subject of patient facts, never an entity to find in a paper |
| `Diagnosis` | 3 | `icd_code` (C61 on 2 of 3), `status` (`active` or null), `stage`, `date_confirmed` | `disease` |
| `Symptom` | 1 | `status`, `severity`, `onset_date` | `disease` (MeSH puts signs and symptoms under C) |
| `Allergy` | 0 | | `disease` |
| `Medication` | 2 | `dosage`, `route`, `start_date`, `end_date` | `chemical` |
| `Procedure` | 4 | `indication`, `outcome`, `procedure_date` | `procedure` |
| `TreatmentPlan` | 3 | `therapy_type`, `recommendation`, `decision_date` | `procedure` or `chemical`, by its content |
| `LabTest` | 1 | `test_value`, `unit`, `result_status` | `finding` |
| `TumorMarker` | 1 | `marker_value`, `unit` | `finding` |
| `PathologyResult` | 2 | `finding`, `grade`, `specimen_site` | `finding` |
| `ImagingResult` | 2 | `modality`, `finding`, `impression` | `finding` |
| `VitalSigns` | 1 | blood pressure, weight, … | dropped |
| `Provider` | 12 | `institution`, `department` | dropped |
| `Appointment` | 1 | `appointment_type`, `purpose` | dropped |
| `Referral` | 0 | | dropped |

### Edges

Two kinds. **Patient facts** start at the `Patient` node; the patient has, gets or undergoes something. They describe the patient but are not triples a paper can contain. **Clinical relations** link two findings and can be compared with paper triples.

| Edge | Source → target in Patient-5 | Count | Kind | Shared predicate |
|---|---|---|---|---|
| `HAS_DIAGNOSIS` | Patient → Diagnosis | 31 | patient fact | `has_condition` |
| `HAS_SYMPTOM` | Patient → Symptom | 1 | patient fact | `has_condition` |
| `HAS_ALLERGY` | not in sample | | patient fact | `has_condition` |
| `PRESCRIBED` | Patient → Medication | 2 | patient fact | `receives` |
| `UNDERWENT` | Patient → Procedure | 14 | patient fact | `receives` |
| `HAS_TREATMENT_PLAN` | Patient → TreatmentPlan | 3 | patient fact | `receives`, status `planned` |
| `HAD_LAB_TEST`, `HAS_TUMOR_MARKER` | not in sample | | patient fact | `has_finding` |
| `HAS_PATHOLOGY` | Patient → PathologyResult | 3 | patient fact | `has_finding` |
| `HAS_IMAGING` | Patient → ImagingResult | 1 | patient fact | `has_finding` |
| `HAS_VITAL_SIGNS` | Patient → VitalSigns | 3 | patient fact | dropped |
| `MANAGED_AT`, `HAS_APPOINTMENT`, `WAS_REFERRED` | Patient → Provider / Appointment | 42 | administrative | dropped |
| `TREATED_BY` | not in sample | | clinical | `treats`, reversed: drug or procedure → disease |
| `INDICATES` | LabTest, TumorMarker, ImagingResult → Diagnosis | 12 | clinical | `indicates` |
| `CONFIRMED_BY` | PathologyResult → Diagnosis | 2 | clinical | `indicates`. The name reads "diagnosis confirmed by finding", but the stored direction is finding → diagnosis, so it is kept as stored |
| `SYMPTOM_OF` | Symptom → Diagnosis | 1 | clinical | `indicates` |
| `PERFORMED_BY`, `REFERRED_TO` | Procedure, ImagingResult → Provider | 6 | administrative | dropped |
| `RELATES_TO` | mixed, 11 type pairs | 53 | fallback | `related`: never read as a treatment or any other specific relation |

Of the 53 `RELATES_TO` edges, 21 are Patient → LabTest (effectively `has_finding`) and 24 touch a `Provider`. Mapping `RELATES_TO` by its endpoint types is possible for patient facts; between two findings it stays `related`.

### What the patient side lacks

- **Codes.** Only `Diagnosis` has ICD-10. Medications, procedures and findings have only a name, in German or English (`leuprorelin`, `Prostatastanzbiopsien`, `RPE`). Matching to MeSH needs a name and synonym map; ICD-10 C61 has to map to MeSH D011471 (Prostatic Neoplasms).
- **Duplicates.** `C61 Prostatakarzinom` and `prostate cancer` are two nodes with the same ICD code. `PSA`, `elevated PSA level` and `PSA increase` are a LabTest, a TumorMarker and a Symptom for the same thing.
- **Wrong or mixed labels.** `transurethral indwelling catheter` is a Medication. `Biochemisches Rezidiv – Salvage-Therapie` is a Diagnosis that also names a therapy and has no code.
- **Status.** `Diagnosis.status` is `active` or null. Suspicion appears only in fact text, in 3 of 174 facts ("suspected prostate cancer", "under the suspected diagnosis of"). No negation was found in the sample. Status therefore has to default to `unknown`, not `asserted`.
- **No treatment links.** There is no `TREATED_BY` edge. That the patient has prostate cancer and gets leuprorelin does not mean leuprorelin was given for it; such a `treats` triple is not derived.
- **Time.** Every edge has `valid_at`; 32 also have `invalid_at`. `invalid_at` can mean "described again later", not "ended" (see [reading a graph](mcp-interface.md#patient-graph)).

## 2. PubTator3 annotations

### Entities

Each annotation has `infons.type`, `infons.identifier` (namespace and ID) and `infons.name` (the preferred name), plus the matched `text` and its `locations`. Annotations cover the title and abstract.

| PubTator3 type | Identifier | Example | Shared type |
|---|---|---|---|
| `Disease` | MeSH, `MESH:D011471` | Prostatic Neoplasms | `disease` |
| `Chemical` | MeSH, `MESH:C531550` | olaparib | `chemical` |
| `Gene` | NCBI Gene, `672` | BRCA1 | `gene` |
| `Variant` (Mutation) | dbSNP or HGVS | | `variant` |
| `Species` | NCBI Taxonomy | human | dropped |
| `CellLine` | Cellosaurus | | dropped |

There is no procedure type. Radiotherapy, prostatectomy or biopsy in a paper can only be found by text, not by PubTator3 triples.

### Relations

A relation has `infons.type`, `infons.role1` and `infons.role2` (both full entities) and `infons.score` (0 to 1). It holds for the whole document; no sentence or position is given. The export also has `relations_display`, the same relations as `<name>|@ROLE1|@ROLE2`, using the names the relation search API uses. The display name follows from the type and the entity types of the roles:

| `infons.type` | Roles seen | Display name | Shared predicate |
|---|---|---|---|
| `Negative_Correlation` | Chemical → Disease | `treat` | `treats` |
| `Positive_Correlation` | Chemical → Disease | `cause` | `causes` |
| `Negative_Correlation`, `Positive_Correlation` | Chemical → Gene | `negative_correlate`, `positive_correlate` | `negative_correlation`, `positive_correlation` |
| `Association` | Disease → Gene | `associate` | `associated_with` (symmetric) |
| `Cotreatment` | Chemical → Chemical | `cotreat` | `cotreated_with` (symmetric) |
| `Comparison` | Chemical → Chemical | `compare` | `compared_with` (symmetric) |
| `Bind`, `Drug_Interaction`, `Conversion` | not in sample | | `interacts_with`, out of the first scope |

Only the six types above appeared in the two papers. The PubTator3 paper states 12 relation types in its relation search but names them only in a supplementary table, which was not checked.

### What the resource side lacks

- **`treat` is a negative correlation.** It means "the chemical lowers the disease". The same rule gives `olaparib treat Death`, which reads as "olaparib lowers mortality", and `olaparib cause Anemia` and `cause Nausea`, which are side effects. `treats` and `causes` triples need care when ranking; `causes` is not a treatment.
- **Studied, not proven.** A `treat` relation says a paper links the drug to the disease, not that the drug works.
- **No negation or uncertainty.** Only the confidence `score`, between 0.38 and 0.999 in the sample. A cut-off is still to be chosen.
- **No evidence sentence and no central/background distinction.** Relations are per document. Annotation positions show where each entity was mentioned, but not where the relation was stated.
- **No time.** The publication date of the paper is the only date.
- **Gaps in the annotations.** Leuprorelin, leuprolide and goserelin are not annotated, even in a paper whose title names leuprorelin (35923949) or whose abstract says leuprolide (37223757). "PSA" is annotated as the gene NPEPPS (9520), which shares the abbreviation, instead of KLK3 (354). Abiraterone has two IDs: `C089740` (abiraterone) and `D000069501` (Abiraterone Acetate).

## 3. Shared representation

The common types the two sides map to, used in the tables above; in code in [`types.ts`](../matcher/algorithms/graph/src/types.ts).

**Entity types:** `disease`, `chemical`, `gene`, `variant`, `procedure`, `finding`, `device`. `procedure`, `finding` and `device` exist only on the patient side and match no PubTator3 triple; they stay for context and the keyword fallback.

**Entity IDs:** `mesh:<ID>` for diseases and chemicals, `ncbigene:<ID>` for genes. On the patient side, the ICD code or the name maps to a MeSH ID. Without a mapping the ID is `null`: the entity keeps its names but takes no part in triple matching. PubTator3 has only MeSH and NCBI Gene IDs, so a made-up text ID could never match a paper, and would make string equality look like a concept match.

**Predicates:**

| Predicate | Direction | Patient source | PubTator3 source |
|---|---|---|---|
| `treats` | chemical or procedure → disease | `TREATED_BY`, reversed | `Negative_Correlation` Chemical → Disease |
| `causes` | chemical → disease | none | `Positive_Correlation` Chemical → Disease |
| `improves_outcome`, `worsens_outcome` | chemical → outcome | none | `treats` or `causes` with an outcome (Death, Disease Progression) |
| `indicates` | finding → disease | `INDICATES`, `CONFIRMED_BY`, `SYMPTOM_OF` | none |
| `associated_with` | symmetric | none | `Association` |
| `positive_correlation`, `negative_correlation` | as stored | none | the correlations not involving a disease |
| `cotreated_with`, `compared_with` | symmetric | none | `Cotreatment`, `Comparison` |
| `interacts_with` | symmetric | none | `Bind`, `Drug_Interaction`, `Conversion` |
| `related` | as stored | `RELATES_TO` between findings | none |
| `has_condition`, `receives`, `has_finding` | Patient → entity | patient facts above | none |

Unknown relation types map to `related`; they are not rejected. Symmetric predicates store their two ends in a fixed order, so `A compared_with B` and `B compared_with A` are one triple.

**Status:** `asserted`, `suspected`, `negated`, `planned` or `unknown`, per statement; see §4.5. PubTator3 relations are `asserted`, with their score kept.

**Kept with each triple:** the source (patient edge `uuid` or PMID with relation `id`), the original type, the evidence (fact text or score), and `valid_at` and `invalid_at` for patient edges.

## 4. Mapping strategy

Scope (20.11.2026): PubTator3 and the patient graph only. The goal: every patient entity that also exists in papers gets the same ID that PubTator3 uses, and every relation gets one shared predicate, both computed offline and with nothing about the patient sent out. What is built is in [`matcher/algorithms/graph/`](../matcher/algorithms/graph/README.md); §4.7 lists what is not built yet.

### 4.1 Entities: resolve each name to an ID, in tiers

A patient entity goes through the tiers in order and stops at the first hit. The tier that resolved it is kept with the entity (`resolvedBy`), so tests, the debug UI and the ranking can see how sure the mapping is.

| Tier | Input | Source | Example | Built |
|---|---|---|---|---|
| 1. Code | `icd_code` | Curated ICD-10 → MeSH table, [`icd10-mesh.json`](../matcher/algorithms/graph/data/icd10-mesh.json) | C61 → `mesh:D011471` | yes |
| 2. Curated name | normalized name | Curated names, [`concepts.json`](../matcher/algorithms/graph/data/concepts.json): German, English, abbreviations | `prostatakarzinom`, `pca`, `prostate cancer` → `mesh:D011471`; `rpe` → Prostatectomy | yes |
| 3. Corpus dictionary | normalized name | Built by the indexer from the PubTator3 annotations it stores: mention `text` → `identifier`, the most frequent ID per text | `enzalutamid` → the ID PubTator3 gave it in our papers | later: needs the graph indexer |
| 4. MeSH entry terms | normalized name | The MeSH descriptor and supplementary files of NLM, with their entry terms | `Leuprorelin` is an entry term of Leuprolide | later, optional |
| – Unresolved | | none | `id: null`, `resolvedBy: null`; `PSMA-PET/CT imaging procedure` keeps its name only | yes |

Why tiers:

- **Tier 3 matches the resource side by construction.** An ID that no paper in the corpus has can never match. A dictionary built from our own annotations has exactly the IDs that can, with the spellings our papers use. The resolver takes a list of dictionaries, so it comes in without a change to the code.
- **Tiers 1 and 2 handle what the corpus cannot:** German names, clinical abbreviations and the ICD codes of the patient. The curated table holds the concepts of the 20 generated patients. Its IDs were checked with the PubTator3 entity lookup and the NLM MeSH lookup, sending only generic drug and disease names.
- **Tier 4 is optional.** The keyword approach already reads the MeSH files ([`basic-words.ts`](../matcher/algorithms/keyword/scripts/basic-words.ts)); their entry terms could cover English names beyond tier 2.

**ICD codes** are what the LLM copied out of the documents into `Diagnosis.icd_code`; nothing checks them. In the generated documents C61 is the only code. A value not shaped like a code (`[A-Z]\d{2}(\.\d{1,2})?`) is ignored; a code is looked up as written, then by its three-character category.

**Name normalization** before every lookup ([`text.ts`](../matcher/algorithms/graph/src/text.ts)): `ß` → `ss`, Unicode NFKD without diacritics, lowercase, without a leading or bracketed ICD code (`C61 Prostatakarzinom` → `prostatakarzinom`), every run of other characters than letters and digits as one space. Names match whole: no containment, no fuzzy match. Compounds such as `Prostatastanzbiopsien` are curated names; generic German compound splitting is not attempted.

**The concept decides the type**, not the patient label. Each curated concept has a type, so a catheter labelled `Medication` becomes a `device` and can never match `olaparib treats …`, and PSA labelled `LabTest` becomes the gene KLK3. A check against the MeSH tree (C diseases, D chemicals, E procedures and devices) would do the same for tiers 3 and 4.

**Findings can resolve to genes.** PSA is the protein of the gene KLK3, which PubTator3 annotates as a `Gene`. `PSA`, `elevated PSA level` and `PSA increase` map to `ncbigene:354`. But PubTator3 often gives "PSA" the ID of NPEPPS (§2), so this match works only where PubTator3 normalized PSA correctly.

**Merge duplicates after resolving.** Nodes with the same ID become one entity with all names, labels and source `uuid`s. In Patient-5, `C61 Prostatakarzinom`, `prostate cancer` and `Adenokarzinom der Prostata` merge this way. Unresolved nodes merge only when their normalized names are equal; the name is an internal key of the graph (`key`), never an ID.

**Rejected for now:**

- **Sending patient names to PubTator3's annotation service, an LLM or an embedding API.** That sends journey data out, which needs a team decision ([rules](../matcher/algorithms/README.md#rules)). It may be worth asking for anyway, because node names alone are short and carry no dates or values.
- **UMLS crosswalks** (ICD-10 ↔ MeSH): better coverage, but they need a UMLS licence per user and may not be redistributed in the repository.
- **Fuzzy string matching:** `prostatitis` and `prostate cancer` are close as strings and far as concepts. A wrong ID is worse than no ID.

**Upstream alternative:** the patient graph is already built by an LLM (Gemini, in [`patient_graph.py`](../scripts/patient_graph.py)). Asking that step to output a MeSH ID or an English preferred name per node would fix most of tier 2 at the source, without sending anything new out. This changes the graph producer, which is not ours to change in the real app, so it is a question for AIlixir, not part of #80.

### 4.2 Out of scope: other concept sources

PubMed MeSH headings (`documents.subjects`, with the `major` flag) and concepts for Zenodo, arXiv, podcasts and YouTube are left out for now. Graph matching therefore covers only PubMed papers with PubTator3 annotations; the other sources are found by the keyword approach, and the two rankings can be merged with `reciprocalRankFusion`.

### 4.3 Relations: one table keyed by type and endpoint types

Both sides map with the same kind of rule: `(source relation type, subject type, object type)` → `(predicate, direction)`. PubTator3 already works this way (§2), and `RELATES_TO` can only be read by its endpoint types. The tables are [`patient-relations.json`](../matcher/algorithms/graph/data/patient-relations.json) and [`pubtator-relations.json`](../matcher/algorithms/graph/data/pubtator-relations.json).

- **The first matching row wins**; a row without `subject` or `object` matches any type. A new type is a new row.
- **Unknown combinations:** between two entities `related`; from the patient, the edge is left out and reported, because a patient fact needs a row.
- **Canonical direction:** `treats` and `causes` always point from chemical or procedure to disease. A reversed source type (`TREATED_BY`, stored disease → drug) has `flip` in its row: the two ends are swapped. Symmetric predicates store their ends sorted by ID, so `A compared_with B` and `B compared_with A` are one triple.
- **Left out:** nodes labelled `Provider`, `Appointment`, `Referral` and `VitalSigns`, with their edges, and the PubTator3 types `Species` and `CellLine`. Every left-out edge is listed in `skipped` with its reason.
- **Score threshold for PubTator3:** `minScore`, 0 by default. The value to use comes from the coverage report of the research plan; 0.5 would drop one of the two `Comparison` relations (0.38) and the `Cotreatment` (0.43) of 32343890.
- **Outcome concepts** ([`outcomes.json`](../matcher/algorithms/graph/data/outcomes.json): Death, Disease Progression): `olaparib treats Death` becomes `olaparib improves_outcome Death`, `causes` with an outcome `worsens_outcome`, so neither matches a disease.
- **Duplicates in a paper:** several relations with the same triple become one, with the highest score.
- **Patient facts stay patient facts.** `has_condition`, `receives` and `has_finding` are not compared with paper triples one to one. Matching combines them into patterns: `has_condition(A)` and `receives(B)` → query `B treats A`.

### 4.4 Treatment links on the patient side, only with evidence

Not built yet. The research rules out inferring `B treats A` from `has_condition(A)` and `receives(B)` alone. But some nodes state the link themselves. A `treats` triple is derived only when one of these names the diagnosis:

- the `indication` field of a `Procedure`;
- the `recommendation` or `therapy_type` of a `TreatmentPlan`;
- the `fact` of an edge that names both the drug or procedure and the diagnosis.

"Names" means: the text resolves (§4.1) to the ID of a diagnosis of the patient. Every such triple keeps the text it came from and is marked as derived. Without such a text, no `treats` triple is made, and matching uses the pattern of §4.3 with a lower weight.

### 4.5 Status of a statement

Status says whether a statement confirms, suspects, rules out or plans something ([`status.ts`](../matcher/algorithms/graph/src/status.ts), cues in [`status-cues.json`](../matcher/algorithms/graph/data/status-cues.json)). It belongs to one statement at its time, not to the concept: in Patient-5 prostate cancer is suspected in November 2026 and confirmed in December. The matcher takes the latest statement per concept on or before `as_of`.

For each patient edge, about its target node (the diagnosis of `HAS_DIAGNOSIS` and of `INDICATES` alike), the first of these that applies:

1. **A cue in the fact sentence.** The entity has to be in the sentence, by one of its names or the names of its concept; a cue is never applied to a whole sentence. A `pre` cue (`suspected`, `Verdacht auf`, `no evidence of`, `kein Hinweis auf`, `confirmed`) counts at most 5 words before the name, a `post` cue (`ruled out`, `ausgeschlossen`, `cannot be ruled out`) at most 3 words after it, both in the same clause: a clause ends at `.`, `;`, `!`, `?` and at words like `but`, `aber`, `jedoch`. Of two overlapping cues the longer wins, so `cannot be ruled out` is `suspected`, not `negated`; pseudo-cues like `no change` only block shorter ones. The nearest cue wins. "V. a." and "Vd. a." are read as "Verdacht auf".
2. **`planned`** for `HAS_TREATMENT_PLAN` and `RELATES_TO` to a `TreatmentPlan`.
3. **The node attribute**, `status: active` → `asserted`, but only for statements on or after the node's `date_confirmed`. Graphiti rewrites a node with every document, so its attribute describes the end of the record, not the first weeks. `date_confirmed` is written as `2026-12-08` or as `December 8, 2026`; both are read.
4. **`unknown`.** Never `asserted` by default. The matcher treats `unknown` as weaker than `asserted`, never as a negative.

German cues are kept although Graphiti writes its facts in English: German terms and the "Vd. a." of the document headers leak into them. In Patient-5 the rules find 2 suspected diagnoses and 4 suspected `INDICATES` and `RELATES_TO` relations; 25 diagnosis facts are `asserted`: 3 by the cue `diagnosed with`, 22 by the attribute, all from 8 December 2026 on.

### 4.6 How we check the mapping

- **Unit tests** in `matcher/algorithms/graph/src/*.test.ts`: normalization, each tier, each relation-table row, merging, the type taken from the concept, the status cues (the three suspected facts of Patient-5 and made-up negations), both adapters, and two cross-source checks: Patient-5's diagnosis has the same ID as the paper's disease, and a patient `olaparib treats prostate cancer` equals the triple of 32343890 but not of the ovarian cancer paper.
- **Coverage per graph:** `pnpm --dir matcher --filter @matcher/graph normalize <file>` prints each entity with its ID and tier, the facts, the relations and what was left out. For Patient-5: 8 of 14 entities have an ID. Unresolved entities are the gap: the fix is a new curated name, not a looser match.
- **Hand check** of every tier-3 and tier-4 mapping for Patient-1 to Patient-10, once those exist. Patients 11 to 20 stay held out, as in [matching evaluation](matching-evaluation.md).

### 4.7 Order of work

1. Name normalization, the relation tables and the status rules, with tests. **Done.**
2. Curated ICD-10 and name tables for the concepts of the generated patients (tiers 1 and 2), and both adapters. **Done.**
3. Evidence-based treatment links (§4.4).
4. The corpus dictionary (tier 3), once the graph indexer stores PubTator3 annotations.
5. Tier 4 and the MeSH tree check, if tiers 1 to 3 leave too much unresolved.

## 5. Known limitations

- Only one patient graph and three papers were inspected. Types absent from all of them (for example `TREATED_BY`, `Bind`) are mapped from their documented meaning, not from data.
- Patient-5 has no `TREATED_BY` edge, so it yields no `treats` triple. Patient-side matching mostly starts from patient facts (`has_condition`, `receives`) combined with paper triples, as the [research](research/Graph-based-matching.md#2-questions-our-matching-proposal-must-answer) describes for typed placeholders. Exact patient-triple-to-paper-triple matches will be rare.
- PubTator3 does not annotate leuprorelin or goserelin, the drugs of several generated patients, so their `receives` facts can never meet a paper triple. It annotates "PSA" as NPEPPS, so the KLK3 mapping often misses.
- Procedures (prostatectomy, radiotherapy, biopsy) have MeSH IDs on the patient side, but PubTator3 has no procedure type: they match no paper triple.
- The curated names cover the 20 generated patients. Names written differently by the graph's LLM (`PSMA-PET/CT imaging procedure`, `Salvage Radiotherapy Plus Adt`) stay unresolved until a name is added. Broader and narrower concepts (castration-resistant prostate cancer under prostate cancer) are not expanded.
- Status comes from rules over sentences that an LLM already paraphrased; a hedge it dropped cannot be recovered. No `historical` status ("history of", "Z. n.") yet.
- Concepts with two IDs in PubTator3, such as abiraterone and Abiraterone Acetate, do not match each other.
