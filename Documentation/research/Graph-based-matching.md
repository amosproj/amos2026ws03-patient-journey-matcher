# Graph-based Matching Research

**Why.** Our baseline is [keyword matching](../keyword-matching.md): it ranks resources by the words they share with the patient journey. Words are not enough. A paper on olaparib for breast cancer shares "olaparib" and "BRCA" with a prostate cancer patient on olaparib, and still ranks high.

**Idea.** Compare relations instead of words. Patient and resources are both written as links between medical concepts, such as `olaparib –treats→ prostate cancer`, using shared IDs (MeSH), so that synonyms and German and English names match too. A resource ranks high when it shares the patient's concepts and links them the same way.

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

### First answers from a real graph (Patient-5)

The two SS26 graph steps (read the PDF, build the graph) were run for Patient-5 in #53, on all 35 documents. The run used a smaller model than the SS26 setup (`gemini-3.5-flash-lite`) and an embedded Kuzu database instead of Neo4j, so this is a look at one patient. The graph is on `main` in [`patientdata/Patient-5/graph.json`](../../patientdata/Patient-5/graph.json), and `make graph PATIENT=Patient-5` builds it.

Result: 34 nodes and 174 edges.

- **Direction of edges:** edges are directed, each has a source and a target node. `CONFIRMED_BY` goes PathologyResult → Diagnosis (2 edges). `INDICATES` goes LabTest / TumorMarker / ImagingResult → Diagnosis (12). `SYMPTOM_OF` goes Symptom → Diagnosis (1). There is no `TREATED_BY` edge in this graph. The two Medication nodes hang only on the patient through `PRESCRIBED`, so the graph does not say which diagnosis a medication treats.
> TBD: can we derive Dignosis -> treated_by > medication just because there are Medication nodes and a diagnosis node which are not linked directly? 
> Or do we decide that separate patient-diagnosis and patient-medication edges do not establish a treatment indication. A diagnosis-medication link requires explicit evidence from the patient documents; otherwise it remains unknown. The concepts can still contribute individually, but no full patient-relation bonus is awarded.
- **Negation/uncertainty:** there is no field for it, edges have no attributes. "suspected" appears only in the fact sentence of an edge (3 of 174 edges). "no evidence of distant metastasis" is not on any edge: it appears only in the outcome text of a Procedure node and in the summary text of the Patient node. A matcher that looks only at edge types reads a suspected diagnosis as a confirmed one.
- **Time of events:** every edge has `valid_at`, and 32 also have `invalid_at`. The facts fall on 23 days, and these are exactly the 23 event dates in the `timeline.json` of the patient, so the fallback to the processing date does not show in this graph. Repeated measurements become a chain of edges: PSA is 13,4 ng/ml from 2026-11-06, <0,1 from 2027-01-22, 0,2 from 2028-08-02, 0,9 from 2028-12-25, 0,3 from 2029-04-22 and <0,1 again from 2029-08-26. Edges replaced by a newer statement get `invalid_at`. The value is in the fact sentence, mostly on a generic `RELATES_TO` edge from the patient to the LabTest node "PSA" (21 edges), not on a TumorMarker node. `invalid_at` does not always mean an outdated value: the radical prostatectomy of 2027-01-22 gets `invalid_at` 2027-01-29, when a later report describes it again.
- **Synonym handling:** not reliable. The same cancer is split over the Diagnosis nodes "C61 Prostatakarzinom" (17 `HAS_DIAGNOSIS` edges) and "prostate cancer" (10). A third Diagnosis node, "Biochemisches Rezidiv – Salvage-Therapie" (4), mixes a diagnosis with a therapy. "radical prostatectomy" and "RPE" are two Procedure nodes. German and English names are mixed. The two prostate cancer nodes carry `icd_code` C61, so the ICD code is a better key than the name; the third node has no code. There are no MeSH IDs.
- **Output:** one JSON per patient with `patient`, `documents` (the PDFs that are in the graph), `nodes` (name, labels, summary, attributes) and `edges` (name, fact, source and target node, `valid_at`, `invalid_at`). `match_journey` takes this file as its `graph` input, see [Graph input](../mcp-interface.md#graph-input).

What this means for the matching proposal:

- The patient side needs a mapping step from names and ICD codes to MeSH IDs before it can be compared with PubTator3.
- Not every node helps. 12 of 34 nodes are Provider nodes, 41 edges are `MANAGED_AT` and 53 are the generic `RELATES_TO`. The graph should be filtered to the medical node types first.
- Labels can be wrong: one of the two Medication nodes is a urinary catheter.
- The reader from #53 does not give the graph to a matcher. It turns the graph into a journey with one event per day, named by the nodes of the facts of that day, and drops the edge types and the fact sentences. A graph matcher needs the nodes and edges themselves, so `match_journey` has to pass the graph on to it. That is a change in the contract, not in the graph file.

## 2. Questions Our Matching Proposal Must Answer

Working example: a patient has diagnosis A treated with medication B. A paper about B for A should be distinguished from a paper about B for C. Mentioning the same concepts does not necessarily establish the same relationship.

The following is a proposed design, not an implemented algorithm. Numerical weights and unresolved extraction details must be validated experimentally.

| Question | Explanation | Our decision |
|---|---|---|
| What does the algorithm receive? | Patient data and required preprocessing | `graph.json` with the nodes, edges, attributes and evidence described in section 1, provided through the reader from #53. Use `as_of` to reconstruct only information known at that point. Select relevant medical concepts and relationships; normalize concept IDs, synonyms, relation types and directions. Dependencies include the graph reader, terminology mapping and reliable time/status information. |
| What information is needed from resources? | Comparable concepts, relationships and supporting context | Subject-predicate-object triples, preferably extracted from accessible full text; otherwise from abstracts, descriptions or transcripts. Keep normalized entity IDs, relation type/direction, resource ID and supporting text, plus negation/uncertainty where available. Use PubTator3 for supported annotations; extraction for uncovered content remains a separate dependency. Distinguishing central investigation, comparison and background mention requires additional text analysis, not just triples. Studying a treatment must not be confused with proving its effectiveness. |
| What counts as a match? | Proposed graph-based algorithm | Use diagnosis-anchored graph pattern matching: normalize both sides, retrieve candidates through a concept-to-resource index, then compare triples and small connected patterns. At least one non-negated patient diagnosis must match the same normalized concept; synonyms count, broader diagnoses do not automatically count. Query both a fixed treatment and a typed treatment placeholder to find new treatments for that diagnosis. A shared drug linked only to another disease gives no treatment match or bonus. Connected patterns must bind shared variables consistently. Allow partial matches and a weaker diagnosis-only fallback when no relation is extracted. Do not infer a patient treatment indication from separate patient-diagnosis and patient-medication edges; only explicit evidence supports a full patient-relation match. JSON and indexes are sufficient for an initial prototype; a graph database is optional. |
| How are resources ranked? | Relevance features and scoring rules | Use an explainable weighted ranking, informed by focus and continuing context in [matching-evaluation.md](../matching-evaluation.md). Relationships count more than concept overlap. Central investigation counts more than comparison or background mention; count each distinct relationship once. Give small bonuses for an existing treatment linked to the matched diagnosis in the paper, an explicitly matching patient relationship, and additional compatible patient details. A centrally studied new treatment should outrank a passing mention of an existing one. Negative study results remain relevant. Prioritize current relevance while retaining older events with lasting effects; downweight suspected diagnoses, exclude negated diagnoses as positive criteria, and mark missing status as unknown. Explicit contradictions lower relevance; missing information is not a contradiction. Exact weights, aggregation across patterns and diagnoses, unknown research focus, and handling of clearly incompatible stages/populations remain to be specified and evaluated. |
| Why choose this approach? | Expected benefit over keyword matching | Match medical relationships rather than shared words alone: distinguish a drug studied for the patient's disease from the same drug studied for another disease. Shared concept IDs handle synonyms; typed placeholders support discovery of new treatments. Matched patterns and evidence make results explainable. Improved relevance is a hypothesis to test, not an established result. |
| What are the performance risks? | Relevance, runtime and operational risks | Missing or incorrect entities, relations, directions, negation or terminology mappings can cause false matches and missed results. Exact diagnosis matching can miss broader but relevant studies; sparse abstracts and unsupported relation types reduce coverage. Incorrect temporal filtering can leak future information. Full-text extraction and research-focus analysis add processing time and possible model costs; external APIs introduce rate limits and availability dependencies. Stored triples, evidence and indexes increase storage and memory requirements. Larger graphs and more connected query patterns can increase matching latency. Cache resource annotations, index candidates by diagnosis and keep query patterns small; measure preprocessing costs separately from query runtime. |
| How will we evaluate it? | Relevance and efficiency against the baseline | Follow [matching-evaluation.md](../matching-evaluation.md), using the same resource corpus, source IDs, evaluation points and `as_of` cutoffs. Compare keyword matching, normalized-concept matching and concept-plus-relation matching to isolate the contribution of relations. Use the existing `judgments.json` and runner: `ndcg_10` is primary; report `precision_5`, `off_target_10` and `judged_10`. Judge newly retrieved ungraded sources and rerun all variants; ungraded does not mean irrelevant. Develop on Patient-1 to Patient-10 and reserve Patient-11 to Patient-20 for a later held-out check. Adapt the current timeline-based evaluation input to equivalent graph snapshots without exposing judgments to the matcher. Include same-drug/wrong-disease, wrong-stage, missing-relation and new-treatment cases. Measure preprocessing time/cost separately from matching latency and memory. Keep source-text availability comparable; test full-text enrichment separately from abstract-only runs. |

## 3. Steps for Graph-based matching

1. **Read and select patient information.** Load `graph.json` through the graph reader and consider only information known at `as_of`. Select relevant diagnoses, treatments and continuing context. Existing edges already form subject-predicate-object triples; do not invent missing diagnosis-treatment links.
2. **Prepare resource triples.** Retrieve available PubTator3 annotations for supported papers and relationships. Convert them into triples and retain source IDs and supporting text. Prefer accessible full text where supported; otherwise use abstracts or other available text. Uncovered resources require separate extraction. Store annotations for reuse across patient queries.
3. **Normalize both inputs.** Map synonyms and concept identifiers to a shared representation, and align relation types and directions without losing negation or uncertainty. A treatment being studied must not automatically be represented as proven effective.
4. **Build query patterns and select candidates.** Keep the diagnosis fixed and create both concrete patterns (`B - treatment_for -> A`) and patterns with a typed variable (`?Treatment - treatment_for -> A`). Use a concept-to-resource index to select papers containing a matching diagnosis.
5. **Match patterns.** Compare the query patterns with each paper's triples, including small connected patterns for additional context. Shared variables must refer to the same entity. Allow partial matches and a weaker diagnosis-only fallback; a shared drug used for a different disease gives no treatment match. Record matched relationships, missing information and explicit contradictions.
6. **Rank and explain results.** Apply the criteria in section 2, considering patient context, relation matches and whether a relationship is central or only mentioned. Count each distinct relationship once. Research focus requires additional text analysis beyond the triples. Return ranked resources with matching reasons and supporting evidence; validate the ranking using [matching-evaluation.md](../matching-evaluation.md).

## 4. Implementation Strategy

Graph matching becomes a third approach next to keyword, built like it (see [matching approaches](../../matcher/algorithms/README.md)). `match_journey` already accepts `algorithm: "graph"` ([`contract.ts`](../../matcher/mcp-server/src/contract.ts)); it works once the approach is in [`registry.ts`](../../matcher/approaches/src/registry.ts).

| Part | Place | What it does |
|---|---|---|
| Indexer | `matcher/algorithms/graph/src/indexer.ts` | `make index`: fetch PubTator3 annotations by PMID and store them in `graph.entities` and `graph.relations` |
| Mapping | `matcher/algorithms/graph/data/` | ICD codes and names → MeSH, plus the MeSH tree for narrower concepts |
| Matcher | `matcher/algorithms/graph/src/matcher.ts` | Candidates by diagnosis, scoring as in section 2, matched concepts as explanation |
| Contract | [`graph.ts`](../../matcher/mcp-server/src/graph.ts), [`contracts.ts`](../../matcher/core/src/contracts.ts) | Pass the graph to the matchers (see below) |

**Contract change.** Matchers only get a `JourneyState` with flattened events. Proposal: add an optional `graph` to it, which keyword ignores. The graph reader also has to keep the edge type, `invalid_at` and `icd_code`. When only a journey is sent, the graph matcher maps event labels to concepts and runs without relations.

**Fallback.** Non-PubMed sources and papers without annotations are invisible to graph matching. We evaluate graph alone first, then graph + keyword merged with `reciprocalRankFusion`.

**Order of work:**

1. Indexer and a coverage report: how many crawled papers have relations, and how many have `treat`. A first check on the five papers judged for Patient-5 found three relations, none of them `treat`.
2. Mapping data with tests.
3. Contract change.
4. Matcher and registry entry.
5. Evaluation as in section 2, with added "trap" judgments (same drug, other disease).
6. Decide on the fallback.

## 5. Literature Research

### Narrative query graphs

**[A discovery system for narrative query graphs: entity-interaction-aware document retrieval](https://doi.org/10.1007/s00799-023-00356-3)** - Kroll et al., published online in 2023.

- **Graph model:** Document titles and abstracts are converted into subject-predicate-object triples through entity linking, relationship extraction and cleaning.
- **Variable nodes:** Queries can contain fixed concepts and typed placeholders. `?X: Disease` represents an unknown disease, not simply a different node type.
- **Matching:** Fixed concepts, relation labels and directions must match. All query patterns must occur in the same document, with shared variables bound consistently. Additional document nodes are allowed; subclasses can be included through query expansion.
- **Requirements:** Shared entity IDs/types and a normalized relationship vocabulary on both sides. Detailed ranking remains to be reviewed.
- **Reuse in AMOS:**
  - Keep diagnosis A fixed and query `?Treatment - treats -> A` to find new treatments. 
  - Match individual triples and combine connected triples to capture additional patient context.
- **Our adaptation:** Allow partial matches and rank them; the paper requires all query patterns to match.

### PubTator 3.0

**[PubTator 3.0: an AI-powered literature resource for unlocking biomedical knowledge](https://doi.org/10.1093/nar/gkae235)** - Wei et al., 2024, Nucleic Acids Research. [Open-access full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC11223843/).

- **What it is:** An NCBI biomedical literature resource offering precomputed entity annotations and relation search for PubMed and the PMC Open Access subset.
- **Processing:** Recognizes biomedical entities, maps mentions to standardized identifiers, and extracts supported relationships using BioREx.
- **Coverage:** Includes diseases, chemicals/drugs, genes, variants, species and cell lines. Coverage is limited to supported entity and relationship types; it is not a complete medical graph of every paper.
- **Access:** Provides a web interface and an API for searching literature and exporting annotations.
- **Proposed use in AMOS:** 
  - Retrieve available annotations for crawled PubMed papers by PMID and convert them into our resource-side triples, retaining the resource reference and available supporting text. 
  - Map patient concepts and relation types to compatible identifiers and labels, then compare our diagnosis-anchored query patterns with these triples.
- **Remaining work:** Validate relation coverage and extraction quality on our papers. Patient-context matching, ranking and identifying whether a relationship is centrally investigated remain our responsibility. Other resource types require a separate extraction approach.
