# Graph-based Matching Research

## 1. Input: Patient Journey Graph

-> based on [medical_schema.py](../../backend/workers/pipeline/graph/medical_schema.py) & graph builder
### Nodes

- **Node types:** `Patient`, `Diagnosis`, `Medication`, `LabTest`, `Procedure`, `Provider`, `PathologyResult`, `TumorMarker`, `TreatmentPlan`, `ImagingResult`, `Symptom`, `Allergy`, `VitalSigns`, `Referral`, `Appointment`.

### Edges and possible mapping
(`/` separates alternative node types)

| Source | Edge type | Target |
|---|---|---|
| Patient | `HAS_DIAGNOSIS` | Diagnosis |
| Patient | `UNDERWENT` | Procedure |
| Patient | `PRESCRIBED` | Medication |
| Patient | `HAD_LAB_TEST` | LabTest |
| Patient | `HAS_TUMOR_MARKER` | TumorMarker |
| Patient | `HAS_PATHOLOGY` | PathologyResult |
| Patient | `HAS_IMAGING` | ImagingResult |
| Patient | `HAS_SYMPTOM` | Symptom |
| Patient | `HAS_ALLERGY` | Allergy |
| Patient | `HAS_VITAL_SIGNS` | VitalSigns |
| Patient | `WAS_REFERRED` | Referral |
| Patient | `HAS_APPOINTMENT` | Appointment |
| Patient | `MANAGED_AT` | Provider |
| Patient / Diagnosis | `HAS_TREATMENT_PLAN` | TreatmentPlan |
| Diagnosis | `TREATED_BY` | Medication |
| Medication | `TREATED_BY` | Diagnosis (direction needs clarification) |
| Diagnosis | `CONFIRMED_BY` | LabTest / PathologyResult / ImagingResult |
| PathologyResult | `CONFIRMED_BY` | Diagnosis (direction needs clarification) |
| LabTest / TumorMarker / ImagingResult | `INDICATES` | Diagnosis |
| Symptom | `SYMPTOM_OF` | Diagnosis |
| Procedure / ImagingResult | `PERFORMED_BY` | Provider |
| Referral | `REFERRED_TO` | Provider |
| Appointment | `RELATES_TO` | Provider |
| Entity | `RELATES_TO` | Entity (generic fallback) |

### To be clarified 
-> can be answered after finishing issue Integrate Patient Graph Generation and Implement Graph Reader
#53

- **direction of edges** e.g. `TREATED_BY` and `CONFIRMED_BY` -> is it a directed edge 
- **Negation/uncertainty:** how are statements such as "no metastases" or "suspected diagnosis" represented? negation field? 
- **Time of events:** How are current vs. historical findings, repeated measurements, and treatment changes represented? -> builder uses processing date when the document date is missing or unparseable -> wrong representation
- **synonym handling:**  How reliably are synonyms and repeated mentions merged? ICD (International Classification of Diseases) codes are optional
- how does the **output** exactly look like

## 2. Questions Our Matching Proposal Must Answer

Working example: a patient has diagnosis A treated with medication B. A paper about B for A should be distinguished from a paper about B for C. Mentioning the same concepts does not necessarily establish the same relationship.

| Question | Explanation | Our decision |
|---|---|---|
| What does the algorithm receive? | Specify which patient nodes, edges, and attributes are used | Parsed patient graph assumed; exact fields TBD |
| What information is needed from resources? | Determine whether titles/abstracts/descriptions/transcripts are sufficient or whether concepts and relationships must be extracted | TBD |
| What counts as a match? | Define matches between terms, normalized concepts, and relationships, including synonyms and edge direction | TBD |
| How are resources ranked? | Define the score, weights, and treatment of missing information, contradictions, and temporal relevance | TBD |
| Why choose this approach? | Explain the expected benefit | TBD |
| What are the performance risks?| Explain which scenarios could have a negative impact on the term and where risks arise | TBD|
| How will we evaluate it? | Compare relevance and runtime against the keyword baseline using the same cases and corpus. A concepts-only comparison can isolate the contribution of relationships. | TBD |


## 3. Literature Research

Some helpful papers: 
1. **[A discovery system for narrative query graphs: entity-interaction-aware document retrieval](https://doi.org/10.1007/s00799-023-00356-3)** — Kroll et al., published online in 2023.
2. **[Ranking Narrative Query Graphs for Biomedical Document Retrieval](https://arxiv.org/abs/2412.15232)** — Kroll et al., 2024. Technical report accompanying a workshop paper; introduces GraphRank.
3. **[MedGraph: A semantic biomedical information retrieval framework using knowledge graph embedding for PubMed](https://doi.org/10.3389/fdata.2022.965619)** — Ebeid, 2022.
4. **[Improving search over Electronic Health Records using UMLS-based query expansion through random walks](https://doi.org/10.1016/j.jbi.2014.04.013)** — Martinez et al., 2014.

-> I don't know if it makes sense to also store them in our repository or if a link is sufficient 

### Comparison Table

| Paper | Graph model: What are the nodes and edges on the query and document sides? | Matching: When does a relationship count as a match, and how are results ranked? | Data requirements: What input and preprocessing are needed? | Transfer to our project: What could we reuse, and which assumptions remain open? |
|---|---|---|---|---|
| 1. Narrative query graphs | Each document has a graph of extracted subject-predicate-object triples. Query nodes are fixed concepts or typed variables: `?X: Disease` is a placeholder for an unknown disease, not simply a different node type. Edges specify relationships such as `treats`. | Graph pattern matching: fixed concepts, relationship labels, and directions must match; variables bind to entities of the required type. All patterns in a query must match within the same document, with shared variables bound consistently. Additional document nodes are allowed; subclasses can be included through query expansion. Detailed ranking remains to be reviewed. | Document titles and abstracts are transformed into graphs through entity linking, relationship extraction, and cleaning. Shared entity IDs/types and normalized relationship vocabularies are needed to compare query and document concepts. | enumerate patient-graph edges as triples, select medically relevant ones, and translate them into query patterns. For example, `Diagnosis A - TREATED_BY -> Medication B` becomes `Medication B - treats -> Diagnosis A`. Patient-to-diagnosis links can supply context; appointments may be excluded. Individual triples could be queried separately and their matches combined into a weighted resource score; connected patterns could preserve more context. Selection, relation mapping, weights, missing data, and score aggregation remain open. |
| 2. GraphRank | TBD | TBD | TBD | TBD |
| 3. MedGraph | TBD | TBD | TBD | TBD |
| 4. UMLS random walks | TBD | TBD | TBD | TBD |

