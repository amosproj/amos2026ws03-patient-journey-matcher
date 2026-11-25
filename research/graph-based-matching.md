# Graph-based Matching Research

**Why.** Our baseline is [keyword matching](../Documentation/design/keyword-matching.md): it ranks resources by the words they share with the patient journey. Words are not enough. A paper on olaparib for breast cancer shares "olaparib" and "BRCA" with a prostate cancer patient on olaparib, and still ranks high.

**Idea.** Compare relations instead of words. Patient and resources are both written as links between medical concepts, such as `olaparib –treats→ prostate cancer`, using shared IDs (MeSH), so that synonyms and German and English names match too. A resource ranks high when it shares the patient's concepts and links them the same way.

## 1. Input: Patient Journey Graph

Based on [medical_schema.py](../tools/patient-graph/workers/pipeline/graph/medical_schema.py) and the graph builder.

- **Node types:** `Patient`, `Diagnosis`, `Medication`, `LabTest`, `Procedure`, `Provider`, `PathologyResult`, `TumorMarker`, `TreatmentPlan`, `ImagingResult`, `Symptom`, `Allergy`, `VitalSigns`, `Referral`, `Appointment`.
- **Edge types:** `HAS_DIAGNOSIS`, `UNDERWENT`, `PRESCRIBED`, `HAD_LAB_TEST`, `HAS_TUMOR_MARKER`, `HAS_PATHOLOGY`, `HAS_IMAGING`, `HAS_SYMPTOM`, `HAS_ALLERGY`, `HAS_VITAL_SIGNS`, `WAS_REFERRED`, `HAS_APPOINTMENT`, `MANAGED_AT`, `HAS_TREATMENT_PLAN`, `TREATED_BY`, `CONFIRMED_BY`, `INDICATES`, `SYMPTOM_OF`, `PERFORMED_BY`, `REFERRED_TO`, `RELATES_TO`.

### Input format and findings

The documented Patient-5 run from #53 processed 35 documents and produced **34 nodes and 174 edges**, using Kuzu instead of Neo4j. These observations describe one sample, not guarantees for every graph.

- **Format:** One `graph.json` with `patient`, `documents`, `nodes` (name, labels, summary, attributes) and `edges` (name, fact, source/target references, `valid_at`, `invalid_at`). Resolving edge endpoints produces entity-relation-entity triples.
- **Directions and missing links:** Edges are directed, but their meaning and direction need normalization. Patient-5 has no `TREATED_BY` edge. Separate patient-diagnosis and patient-medication edges do not establish a treatment indication. Require explicit evidence; otherwise the relationship remains unknown.
- **Negation and uncertainty:** No dedicated fields were observed. Suspected diagnoses and negative findings occur in fact sentences or node text. Preserve this evidence and determine status before using statements as positive matches; unknown status must remain distinguishable.
- **Time:** All sample edges have `valid_at`; 32 also have `invalid_at`. Values may occur in fact text on generic edges. Invalidation can reflect a later restatement rather than the end of a lasting medical effect. Define these semantics before filtering by `as_of`; the builder's processing-date fallback for missing document dates remains a risk.
- **Normalization:** German/English synonyms can form duplicate nodes. Two prostate cancer nodes share ICD C61, while others lack codes or mix diagnosis and therapy. Map names and codes to compatible PubTator3 identifiers (MeSH for the initial disease/drug scope); mappings are not automatically one-to-one.
- **Selection and quality:** The sample includes 12 Provider nodes, many generic `RELATES_TO` edges and a urinary catheter mislabeled as Medication. Filter administrative context and validate labels. Generic relations must not be interpreted as specific treatment assertions.
- **Integration:** The original reader from #53 ([`graph.ts`](../matcher/mcp-server/src/graph.ts)) flattened graphs into daily events and lost relationship information. Preserve the original nodes, edges, evidence and attributes in the matcher contract (section 4).
## 2. Questions Our Matching Proposal Must Answer

Working example: a patient has diagnosis A treated with medication B. A paper about B for A should be distinguished from a paper about B for C. Mentioning the same concepts does not necessarily establish the same relationship.

This proposal predates the [graph matcher](../Documentation/design/graph-normalization.md). Its ranking was measured afterwards: [results](#7-results).

| Question | Explanation | Our decision |
|---|---|---|
| What does the algorithm receive? | Patient data and required preprocessing | `graph.json` with the nodes, edges, attributes and evidence described in section 1, passed intact through an extended matcher contract (section 4); flattened events alone are insufficient. Use `as_of` to reconstruct only information known at that point. Select relevant medical concepts and relationships; normalize concept IDs, synonyms, relation types and directions. Dependencies include the graph reader, terminology mapping and reliable time/status information. |
| What information is needed from resources? | Comparable concepts, relationships and supporting context | Subject-predicate-object triples, preferably extracted from accessible full text; otherwise from abstracts, descriptions or transcripts. Keep normalized entity IDs, relation type/direction, resource ID and supporting text, plus negation/uncertainty where available. Retrieve supported PubTator3 annotations by PMID during offline indexing and store normalized triples and entity mentions in PostgreSQL. Do not call PubTator3 at query time. Unsupported content uses the optional keyword fallback; separate extraction is outside the initial workflow. Distinguishing central investigation, comparison and background mention requires additional text analysis, not just triples. Studying a treatment must not be confused with proving its effectiveness. |
| What counts as a match? | Proposed graph-based algorithm | Compare normalized patient entity-relation-entity triples with stored PubTator3 triples per paper, then rank the matching results. Use diagnosis-anchored graph pattern matching: normalize both sides, retrieve candidates through a concept-to-resource index, then compare triples and small connected patterns. At least one non-negated patient diagnosis must match the same normalized concept; synonyms count, broader diagnoses do not automatically count. Exact matches require both entities, the relation and its direction to agree. Typed treatment placeholders additionally find new treatments for that diagnosis; label these as exploratory pattern matches rather than identical patient-triple matches. Patient-to-concept edges supply context, not a Patient node to find in a paper. A shared drug linked only to another disease gives no treatment match or bonus. Connected patterns must bind shared variables consistently. Allow partial matches and a weaker diagnosis-only fallback when no relation is extracted. Do not infer a patient treatment indication from separate patient-diagnosis and patient-medication edges; only explicit evidence supports a full patient-relation match. JSON and indexes are sufficient for an initial prototype; a graph database is optional. |
| How are resources ranked? | Relevance features and scoring rules | After matching, aggregate distinct matched triples and exploratory pattern matches per resource into an explainable weighted ranking, informed by focus and continuing context in [matching-evaluation.md](matching-evaluation.md). Relationships count more than concept overlap. Central investigation counts more than comparison or background mention; count each distinct relationship once. Give small bonuses for an existing treatment linked to the matched diagnosis in the paper, an explicitly matching patient relationship, and additional compatible patient details. A centrally studied new treatment should outrank a passing mention of an existing one. Negative study results remain relevant. Prioritize current relevance while retaining older events with lasting effects; downweight suspected diagnoses, exclude negated diagnoses as positive criteria, and mark missing status as unknown. Explicit contradictions lower relevance; missing information is not a contradiction. Exact weights, aggregation across patterns and diagnoses, unknown research focus, and handling of clearly incompatible stages/populations remain to be specified and evaluated. |
| Why choose this approach? | Expected benefit over keyword matching | Match medical relationships rather than shared words alone: distinguish a drug studied for the patient's disease from the same drug studied for another disease. Shared concept IDs handle synonyms; typed placeholders support discovery of new treatments. Matched patterns and evidence make results explainable. Improved relevance is a hypothesis to test, not an established result. |
| What are the performance risks? | Relevance, runtime and operational risks | Missing or incorrect entities, relations, directions, negation or terminology mappings can cause false matches and missed results. Exact diagnosis matching can miss broader but relevant studies; sparse abstracts and unsupported relation types reduce coverage. Incorrect temporal filtering can leak future information. Full-text extraction and research-focus analysis add processing time and possible model costs; external APIs introduce rate limits and availability dependencies. Stored triples, evidence and indexes increase storage and memory requirements. Larger graphs and more connected query patterns can increase matching latency. Cache resource annotations, index candidates by diagnosis and keep query patterns small; measure preprocessing costs separately from query runtime. |
| How will we evaluate it? | Relevance and efficiency against the baseline | Follow [matching-evaluation.md](matching-evaluation.md), using the same resource corpus, source IDs, evaluation points and `as_of` cutoffs. Compare keyword matching, normalized-concept matching and concept-plus-relation matching to isolate the contribution of relations. Use the existing `judgments.json` and runner: `ndcg_10` is primary; report `precision_5`, `off_target_10` and `judged_10`. Judge newly retrieved ungraded sources and rerun all variants; ungraded does not mean irrelevant. Develop on Patient-1 to Patient-10 and reserve Patient-11 to Patient-20 for a later held-out check. Adapt the current timeline-based evaluation input to equivalent graph snapshots without exposing judgments to the matcher. Include same-drug/wrong-disease, wrong-stage, missing-relation and new-treatment cases. Measure preprocessing time/cost separately from matching latency and memory. Keep source-text availability comparable; test full-text enrichment separately from abstract-only runs. |

## 3. Steps for Graph-based matching

**Overview.** Some steps run once, before any patient is matched, and some run for each query:

Paper annotations and patient graph edges are normalized into comparable entity-relation-entity triples. Matching records their agreement per paper; ranking then scores and orders those papers.

- **Once per crawl:** the crawler stores the papers in `documents`, PubMed papers with IDs such as `pubmed:12345`. The indexer fetches the PubTator3 annotations of each PMID and stores them as triples next to the keyword index. We do not build the paper graph ourselves, and PubTator3 is not called at query time.
- **Once per patient:** `make graph` turns the PDFs of the patient into `graph.json` (section 1). Its medical concepts and relations are normalized after creation or updates, using compatible IDs (MeSH for the initial disease/drug scope). Temporal selection runs per query.
- **Per query:** `match_journey` with `algorithm: "graph"` looks up the stored triples of the patient's diagnoses, compares them with the patient's triples and ranks the papers.

Papers without a PMID get no triples (see Fallback in section 4). In the steps below, step 2 runs once per crawl and steps 4 to 6 per query.

1. **Read and select patient information.** Load the preserved nodes and edges from `graph.json` through the extended matcher contract and consider only information known at `as_of`. Select relevant diagnoses, treatments and continuing context. Existing edges already form subject-predicate-object triples; do not invent missing diagnosis-treatment links.
2. **Prepare resource triples.** Retrieve available PubTator3 annotations for supported papers and relationships. Convert them into triples and retain source IDs and supporting text. Prefer accessible full text where supported; otherwise use abstracts or other available text. Uncovered resources use the optional keyword fallback; separate extraction is outside the initial workflow. Store annotations for reuse across patient queries.
3. **Normalize both inputs.** Map synonyms and concept identifiers to a shared representation, and align relation types and directions without losing negation or uncertainty. A treatment being studied must not automatically be represented as proven effective.
4. **Build query patterns and select candidates.** Keep the diagnosis fixed and create both concrete patterns (`B - treatment_for -> A`) and patterns with a typed variable (`?Treatment - treatment_for -> A`). Use a concept-to-resource index to select papers containing a matching diagnosis.
5. **Match patterns.** Compare the query patterns with each paper's triples, including small connected patterns for additional context. Shared variables must refer to the same entity. Allow partial matches and a weaker diagnosis-only fallback; a shared drug used for a different disease gives no treatment match. Record matched relationships, missing information and explicit contradictions.
6. **Rank and explain results.** Apply the criteria in section 2, considering patient context, relation matches and whether a relationship is central or only mentioned. Count each distinct relationship once. Research focus requires additional text analysis beyond the triples. Return ranked resources with matching reasons and supporting evidence; validate the ranking using [matching-evaluation.md](matching-evaluation.md).

## 4. Implementation Strategy

Implement **offline PubTator3 indexing**, followed by **patient-triple matching and resource ranking at query time**. Use the existing [approach interfaces](../matcher/algorithms/README.md). Paths below are proposed implementation locations; registration alone does not provide a working matcher.

| Part | Proposed place | Responsibility |
|---|---|---|
| Indexer | `matcher/algorithms/graph/src/indexer.ts` | After crawls, fetch annotations by PMID. Normalize/deduplicate triples and store entities, relations, evidence and document references in PostgreSQL. Report coverage and failures. |
| Mapping | `matcher/algorithms/graph/data/` | Align identifiers, synonyms, relation labels and directions. Start with disease/drug concepts. Broader/narrower concept expansion remains a later experiment. |
| Matcher | `matcher/algorithms/graph/src/matcher.ts` | Select patient facts at `as_of`, derive triples and patterns, retrieve candidates by diagnosis and compare stored paper triples. Record exact matches, exploratory matches, missing information and contradictions. |
| Ranking | Within the graph approach | Score each paper from these matching results using section 2. Return document IDs, scores and matched relationships with evidence. Research-focus weighting requires additional text-derived features. |
| Contract and registry | `matcher/core/src/contracts.ts`, MCP input handling and approach registry | Preserve the graph and query cutoff for the matcher; register the graph approach. The `graph` input of #53 is merged; the matchers still receive only the journey state. |

**Contract change.** Before graph matching, `JourneyState` exposed only focus and context events. Add an optional graph payload retaining node IDs, labels, codes, edge types, endpoints, fact text, timestamps and source references where available. Preserve the query cutoff. Normalize after patient graph updates, but apply temporal selection per query. If only a timeline is supplied, explicitly use concept-only or keyword fallback; do not claim relation matching.

**Coverage and fallback.** Entity annotations without matching relations can support the weaker diagnosis-only score from section 2. Resources without usable annotations cannot contribute PubTator3 matches. Evaluate graph alone first, then optionally merge graph and keyword rankings using `reciprocalRankFusion`, preserving which approach supplied each result.

**Order of work:**

1. Implement the indexer and coverage report: resources with entities, relations and treatment relations. The documented check on five Patient-5 papers found three relations and no `treat`; verify coverage across the corpus.
2. Define and test concept/relation mappings, including direction and unsupported predicates.
3. Extend the contract to preserve graph structure and cutoff.
4. Implement triple/pattern comparison, then ranking and explanations; register the approach.
5. Evaluate as in section 2, including same-drug/wrong-disease cases and annotation gaps.
6. Evaluate and decide on keyword fusion.
## 5. Graph DB vs PostgreSQL

**Decision: PostgreSQL is sufficient for this workflow.** Graph-based matching describes the data model and comparison logic; a graph database is not required. This decision concerns the matching index, independently of the database used to generate patient graphs.

- Store resource concept mentions in `graph.entities` and triples in `graph.relations`, linked to `documents`.
- A relation row can contain `document_id`, `subject_id`, `relation_type`, `object_id` and evidence metadata. Preserve identifier namespaces and normalize directions.
- Index concept mentions for candidate retrieval and relation endpoints for triple lookup. Choose composite index order according to query filters; see [PostgreSQL multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html).
- Retrieve candidate papers and their triples with SQL. Compare against patient triples and rank in TypeScript. Small connected patterns can be checked in code or through joins constrained to the same paper.
- Keep the patient graph in the request payload or a separate cache. A persistent shared patient-paper graph is unnecessary.
- Reuse existing PostgreSQL infrastructure and document references. Measure latency, memory and index size before making performance claims.

Reconsider a graph database if future requirements involve frequent deep traversals or complex paths across a large shared knowledge graph. PostgreSQL also supports [recursive queries](https://www.postgresql.org/docs/current/queries-with.html); neither option is universally faster. Cross-paper inference is outside the current workflow, and any future shared graph must preserve statement provenance.
## 6. Literature Research

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

## 7. Results

We compared the rankings on 29,720 documents from the VM on 2026-11-24. The slice includes prostate cancer papers, previously graded sources, papers naming a patient drug or gene, and a 2% sample of the remaining PubMed papers. Each method saw the same patient input up to the same date. The ten synthetic prostate cancer journeys contributed 129 time points. Five patients supplied the 67 development points. The other five supplied 62 points in a historical holdout that has since been reused to check changes. [Evaluation method and command](matching-evaluation.md#compare-matchers)

| Ranking | Input | nDCG@10 | Development | Holdout | Precision@5 | Grade 0 in top 10 |
|---|---|---:|---:|---:|---:|---:|
| Graph before the initial rework | Patient graph | 0.145 | 0.171 | 0.117 | 0.164 | 58.8% |
| Previous graph matcher | Patient graph | 0.447 | 0.484 | 0.408 | 0.538 | 6.3% |
| Graph before care-context reranking | Patient graph | 0.475 | 0.519 | 0.427 | 0.563 | 5.7% |
| Graph at `03ed881` | Patient graph | 0.525 | 0.563 | 0.484 | 0.626 | 3.9% |
| Keyword | Patient graph | 0.500 | 0.473 | 0.528 | 0.581 | 14.4% |
| Graph + keyword, offline | Patient graph | 0.551 | 0.571 | 0.530 | 0.647 | 7.2% |
| Previous graph matcher | Timeline | 0.532 | 0.564 | 0.497 | 0.645 | 5.2% |
| Graph before care-context reranking | Timeline | 0.568 | 0.587 | 0.546 | 0.682 | 3.8% |
| Graph at `03ed881` | Timeline | 0.631 | 0.646 | 0.614 | 0.771 | 1.9% |
| Keyword | Timeline | 0.553 | 0.575 | 0.530 | 0.684 | 9.0% |
| Graph + keyword, offline | Timeline | 0.636 | 0.666 | 0.603 | 0.774 | 4.1% |

The previous graph matcher introduced MeSH evidence, concept rarity and disease-state weighting. The matcher at `03ed881` uses dated findings and treatment status, checks curated concepts in titles, and distinguishes clinical terms with different meanings. For example, regional nodes and distant metastases supply different evidence. On a patient graph that version returned results for all 129 points, up from 128. The revisions were measured together. [Graph matching details](../Documentation/design/graph-normalization.md#ranking) · [NCI prostate cancer staging](https://www.cancer.gov/types/prostate/hp/prostate-treatment-pdq)

The comparison at `03ed881` isolates the care question. A paper on differential diagnosis can help at PSA workup. A study of reclassification or a switch to treatment can help during surveillance. After prostatectomy with recurrence, the sequence of treatments in a paper's title matters. Against the preceding version, mean nDCG@10 rose for seven of ten patients with graph input and eight with timeline input. Exact two-sided sign-flip tests, flipping all of each patient's event differences together, gave p = 0.016 and 0.008 respectively.

On the 67 development points, 201 grade-3 keyword hits fell outside the graph top ten. Of those, 123 reached the reranker, 68 passed the diagnosis filter but missed the 300-paper shortlist, and ten failed the filter. In a separate trial, admitting titles with both a diagnosis and a focus concept changed no development top ten. Across all 129 points, 14 of the 48 grade-3 keyword hits previously ranked 11–30 by the graph entered its top ten. One entered from below 30 and six previously shared top-ten hits dropped out. These counts refer to point–source pairs.

The offline comparator combines each method's first 30 hits by equal-weight reciprocal rank fusion with k = 60. Every returned top-ten hit has an LLM grade. The latest round added 163 judgments and included 44 hidden calibration pairs. Agreement with the earlier grades was 59% exact and 98% within one grade. The table gives newer judgments precedence where the pools overlap. Giving earlier judgments precedence yields 0.535 for graph versus 0.512 for keyword on patient graphs, and 0.640 versus 0.626 on timelines. Keyword still leads on the five holdout patients with graph input under the main grading order. These are retrospective results on ten synthetic cases. Performance on new patients or with clinician judgments remains open. [Rank fusion method](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) · [Pooled judgments](../matcher/evaluation/graph-llm-judgments.json) · [Patient graph limitations](../Documentation/design/graph-normalization.md#known-limitations)

**Cross-disease evaluation.** The registered `match_journey` tool ran on the same 29,720 documents, indexes and cutoff dates for all three methods. The original graph matcher stopped before retrieval for C50 and C34 at every cutoff in both formats. The index already contained 1,331 documents with the breast cancer ID (`mesh:D001943`) and 464 with the lung cancer ID (`mesh:D008175`). Diagnosis resolution prevented those matches. The corpus also contained treatment studies and same-drug controls for rheumatoid arthritis and the held-out Crohn disease case, so no additional papers were needed.

The four new synthetic cases each contribute three cutoffs, at suspicion, confirmation and treatment. Crohn disease was first exercised after freezing the matcher and used a disease name without an ICD code. The prostate comparison uses the original 129 cutoffs. Existing grades were reused. Codex agents graded 732 additional point–source pairs, including development pools, with the algorithm and rank hidden. The report uses the same enlarged judgment pool for every method. With the original judgments the baseline reproduced 0.525 for graphs and 0.631 for timelines. [Inputs, grading and reproduction](matching-evaluation.md#compare-matchers) · [Additional judgments](../matcher/evaluation/disease-judgments.json)

Each entry gives the graph input first and the timeline second. **Diagnosis** counts queries with the expected retrieval ID. Keyword has no concept resolver. **Relevant** counts queries with at least one grade 2 or 3 result in the top ten. **Off target** counts grade 0 hits out of all returned top-ten places. Times are local MCP round trips in milliseconds.

| Disease | Method | Diagnosis | Empty | Relevant | nDCG@10 | Off target (graph · timeline) | p50 ms | p95 ms |
|---|---|---:|---:|---:|---:|---|---:|---:|
| Prostate cancer | Graph `03ed881` | 129 / 129 | 0 / 0 | 118 / 128 | 0.525 / 0.630 | 50/1290 · 24/1290 | 221.7 / 200.9 | 271.6 / 298.3 |
| Prostate cancer | Graph | 129 / 129 | 0 / 0 | 120 / 129 | 0.530 / 0.633 | 72/1290 · 38/1290 | 242.3 / 236.2 | 304.1 / 294.9 |
| Prostate cancer | Keyword | — | 0 / 0 | 120 / 125 | 0.499 / 0.553 | 186/1290 · 116/1290 | 46.0 / 44.2 | 75.6 / 60.9 |
| Breast cancer | Graph `03ed881` | 0 / 0 | 3 / 3 | 0 / 0 | 0.000 / 0.000 | 0 hits · 0 hits | 0.1 / 0.1 | 0.5 / 0.2 |
| Breast cancer | Graph | 3 / 3 | 0 / 0 | 3 / 3 | 0.522 / 0.537 | 6/30 · 6/30 | 36.5 / 36.2 | 70.1 / 51.2 |
| Breast cancer | Keyword | — | 2 / 0 | 1 / 2 | 0.010 / 0.133 | 9/10 · 21/30 | 0.9 / 38.5 | 47.8 / 42.6 |
| Lung cancer | Graph `03ed881` | 0 / 0 | 3 / 3 | 0 / 0 | 0.000 / 0.000 | 0 hits · 0 hits | 0.1 / 0.1 | 0.2 / 0.2 |
| Lung cancer | Graph | 3 / 3 | 0 / 0 | 2 / 3 | 0.533 / 0.488 | 5/30 · 12/30 | 21.5 / 21.0 | 23.4 / 27.1 |
| Lung cancer | Keyword | — | 2 / 0 | 1 / 1 | 0.118 / 0.209 | 8/10 · 26/30 | 0.9 / 39.6 | 32.2 / 40.3 |
| Rheumatoid arthritis | Graph `03ed881` | 0 / 0 | 3 / 3 | 0 / 0 | 0.000 / 0.000 | 0 hits · 0 hits | 0.1 / 0.1 | 0.1 / 0.1 |
| Rheumatoid arthritis | Graph | 3 / 3 | 0 / 0 | 3 / 3 | 0.750 / 0.761 | 1/30 · 1/30 | 9.5 / 9.9 | 10.8 / 11.2 |
| Rheumatoid arthritis | Keyword | — | 0 / 0 | 3 / 3 | 0.483 / 0.454 | 3/30 · 4/30 | 31.6 / 32.8 | 34.0 / 52.5 |
| Crohn disease | Graph `03ed881` | 0 / 0 | 3 / 3 | 0 / 0 | 0.000 / 0.000 | 0 hits · 0 hits | 0.1 / 0.1 | 0.2 / 0.1 |
| Crohn disease | Graph | 3 / 3 | 0 / 0 | 3 / 3 | 0.430 / 0.430 | 2/30 · 2/30 | 5.8 / 6.0 | 8.2 / 7.7 |
| Crohn disease | Keyword | — | 0 / 0 | 3 / 3 | 0.749 / 0.824 | 3/30 · 3/30 | 32.5 / 33.6 | 34.8 / 35.9 |

The treatment controls gave the same result in both input formats. The relevant papers reached rank 15 for olaparib in breast cancer, rank 1 for pembrolizumab in lung cancer, rank 3 for methotrexate in rheumatoid arthritis and rank 3 for infliximab in Crohn disease. All four prespecified controls on another disease fell outside the graph top 30. The HTTP integration test also puts both diagnoses and the same drug on both papers, so both pass retrieval. With all other evidence tied, the paper that links the drug to the patient's disease ranks first. [Control PMIDs](../matcher/evaluation/disease-cases.json) · [MCP integration test](../matcher/mcp-server/src/integration/graph.test.ts)

Recognition and current relevance diverged at diagnosis. In the breast timeline, the first paper at suspicion concerned follow-up after completed treatment. At olaparib initiation the first two papers studied olaparib in BRCA-mutated breast cancer. For lung cancer, a screening cost study still ranked second after confirmation, while KEYNOTE-010 ranked first at pembrolizumab initiation. Rheumatoid arthritis returned workup studies at suspicion and methotrexate studies at treatment. [Breast follow-up](https://pubmed.ncbi.nlm.nih.gov/23129741/) · [Adjuvant olaparib](https://pubmed.ncbi.nlm.nih.gov/34081848/) · [Lung screening](https://pubmed.ncbi.nlm.nih.gov/22308519/) · [KEYNOTE-010](https://pubmed.ncbi.nlm.nih.gov/26712084/)

On prostate cancer, mean nDCG improved slightly, while grade-0 hits rose from 50 to 72 on graph inputs and from 24 to 38 on timelines. At the last cutoff for each of the ten additional prostate patients (11–20), both formats returned results and the expected diagnosis. These 20 calls had no relevance grades.

Keyword led on the held-out Crohn case. At suspicion the graph ranked imaging of perianal fistulas and postoperative recurrence highly, before either complication or surgery was documented. The corpus is weighted towards prostate cancer, and each additional disease has only one synthetic patient. These measurements establish retrieval on the tested cases. They leave clinical relevance on other populations and terminology coverage for unmapped codes open. [Fistula imaging](https://pubmed.ncbi.nlm.nih.gov/25816833/) · [Postoperative recurrence](https://pubmed.ncbi.nlm.nih.gov/16697723/)

**Less prostate-specific ranking.** The baseline gave stage, phase and care rules only to prostate cancer, and its vocabulary had no procedures. The revision adds MeSH procedures, applies the disease states every cancer has and a phase rule for any disease, and reads a suspicion, a pathology report and later findings of spread from any timeline ([ranking](../Documentation/design/graph-normalization.md#ranking)). A separate agent wrote three journeys of 16 events each (breast, ovarian and rectal cancer) before the change, and picked four milestones each. The journeys were frozen by hash and run once at the end, as timelines only. Two blind LLM graders of the same model as the journey writer and the rule author judged the pool: A all 256 pairs, B the 154 pairs of the two graph versions, both with hidden calibration pairs (11 of 12 and 8 of 9 exact). On the shared pairs A and B agreed exactly on 95 %. The author read short summaries of the journeys after the main changes; three later changes rest on development data: dropping the MeSH qualifier "secondary" as a sign of metastases (it cost prostate and changed no development list), the suspicion rule only before a diagnosis is named, and shared aspects for diagnoses of one disease (development journey `Lung-EGFR`).

| nDCG@10 | Baseline | Revision | Keyword |
|---|---:|---:|---:|
| Holdout, 12 points (A) | 0.297 | 0.543 | 0.433 |
| Holdout, 12 points, graph pairs only, A / B | 0.339 / 0.336 | 0.664 / 0.666 | – |
| Holdout, 6 breast and ovarian points with baseline hits (A) | 0.594 | 0.613 | 0.422 |
| Holdout breast · ovarian · rectal (A) | 0.520 · 0.371 · 0.000 | 0.695 · 0.573 · 0.362 | 0.398 · 0.400 · 0.502 |
| Prostate, 129 points, graph / timeline | 0.529 / 0.629 | 0.526 / 0.628 | – |
| Development breast · lung · Crohn (timeline) | 0.519 · 0.510 · 0.424 | 0.604 · 0.538 · 0.510 | – |

Most of the holdout gain comes from the first milestones, where the baseline returned nothing and the revision returned results at all twelve points. On the breast and ovarian points with baseline hits the gain is small, and two breast milestones rank lower. Without the rectal journey, the share of grade-0 hits fell from 10 % to 6 %. Neither version recognised the rectal cancer: C18 to C21 have no code mapping, and the German MeSH has no name `Rektumkarzinom`. The baseline searched by adenocarcinoma, the revision by carcinoma from the referral's suspicion, so 36 of its 40 rectal hits concern other cancers; keyword leads there. The rectal score at the first milestone rests on a single relevant paper. The Crohn baseline is 0.424 on the merged grades, 0.430 in the table above. Three journeys cannot show significance. [Judgments](../matcher/evaluation/disease-judgments.json)
