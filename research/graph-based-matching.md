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
- **Integration:** The reader from #53 (merged, [`graph.ts`](../matcher/mcp-server/src/graph.ts)) flattens graphs into daily events and loses relationship information. Preserve the original nodes, edges, evidence and attributes in the matcher contract (section 4).
## 2. Questions Our Matching Proposal Must Answer

Working example: a patient has diagnosis A treated with medication B. A paper about B for A should be distinguished from a paper about B for C. Mentioning the same concepts does not necessarily establish the same relationship.

The following is a proposed design, not an implemented algorithm. Numerical weights and unresolved extraction details must be validated experimentally.

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

**Contract change.** The current `JourneyState` exposes focus/context events, not graph triples. Add an optional graph payload retaining node IDs, labels, codes, edge types, endpoints, fact text, timestamps and source references where available. Preserve the query cutoff. Normalize after patient graph updates, but apply temporal selection per query. If only a timeline is supplied, explicitly use concept-only or keyword fallback; do not claim relation matching.

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
