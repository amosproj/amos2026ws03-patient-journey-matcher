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
- **Integration:** The original reader from #53 ([`graph.ts`](../matcher/mcp-server/src/graph.ts)) flattened graphs into daily events and lost relationship information. The server still derives daily events, and the matcher contract also passes the original nodes and edges (`JourneyState.graph`).
- **Synthetic graphs run ahead of the timeline:** Patient-5's diagnosis text names the later recurrence a month before the surgery, Patient-8's names enzalutamide years before it is given, and Patient-10's graph ends two months before the palliative care. The matcher reads a graph as it is.

## 2. Proposal and what was built

The team proposed graph matching before building it. The matcher keeps the proposal's base and is simpler where the annotations or the measurements called for it; its design is in [graph matching](../Documentation/design/graph-normalization.md).

| Topic | Proposed | Built |
|---|---|---|
| Patient input | The graph's nodes and edges, passed intact to the matcher; only what is known at `as_of` | As proposed: `JourneyState.graph` carries the Graphiti nodes and edges. The matcher reads a graph or a timeline per request. |
| Paper side | PubTator3 triples per PMID, fetched while indexing, never at query time | As proposed, plus each paper's MeSH headings, because PubTator3 annotates no procedures and misses some drugs |
| Match | Entity–relation–entity triples and small connected patterns, with typed placeholders such as `?Treatment – treats → A` | Shared concept IDs, weighted by evidence, rarity (IDF) and role. The only relation compared is `treats`. The placeholder remains as one rule: at confirmation, before any treatment, a paper that links a treatment to the patient's diagnosis counts as relevant. |
| Candidates | Papers naming a non-negated patient diagnosis; broader diagnoses do not count | As proposed, including narrower forms such as castration-resistant prostate cancer |
| Ranking | Weights to be specified and evaluated | A SQL score, then a re-rank by disease state, phase of care, other diseases, sex, lab research and publication type. The rules of one disease are a disease profile. |
| Storage | Entity mentions and triples in PostgreSQL, no graph database | As proposed: one row per paper with its entities, relations and MeSH headings, and tables derived from it for the search ([graph index](../Documentation/design/storage.md#graph-index)) |
| Keyword fusion | Optional, by reciprocal rank fusion | Built as `graph_keyword` |

**Why PostgreSQL and no graph database.** Matching needs one hop: the patient's concepts and each paper's `treats` links. SQL selects the candidates and scores their evidence; the rules that need the matcher's dictionaries run in TypeScript. A graph database pays off for deep traversals or paths across a large shared graph, which this workflow does not have, and PostgreSQL can query recursively if it ever needs to. The patient graph stays in the request. There is no shared patient–paper graph; a future one must keep the source of each statement.

## 3. Literature Research

### Narrative query graphs

**[A discovery system for narrative query graphs: entity-interaction-aware document retrieval](https://doi.org/10.1007/s00799-023-00356-3)** - Kroll et al., published online in 2023.

- **Graph model:** Document titles and abstracts are converted into subject-predicate-object triples through entity linking, relationship extraction and cleaning.
- **Variable nodes:** Queries can contain fixed concepts and typed placeholders. `?X: Disease` represents an unknown disease, not simply a different node type.
- **Matching:** Fixed concepts, relation labels and directions must match. All query patterns must occur in the same document, with shared variables bound consistently. Additional document nodes are allowed; subclasses can be included through query expansion.
- **Requirements:** Shared entity IDs/types and a normalized relationship vocabulary on both sides. Detailed ranking remains to be reviewed.
- **What we took:** a fixed diagnosis, and the typed treatment placeholder as one ranking rule (section 2). Partial matches are ranked, where the paper requires all query patterns to match; connected patterns were not built.

### PubTator 3.0

**[PubTator 3.0: an AI-powered literature resource for unlocking biomedical knowledge](https://doi.org/10.1093/nar/gkae235)** - Wei et al., 2024, Nucleic Acids Research. [Open-access full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC11223843/).

- **What it is:** An NCBI biomedical literature resource offering precomputed entity annotations and relation search for PubMed and the PMC Open Access subset.
- **Processing:** Recognizes biomedical entities, maps mentions to standardized identifiers, and extracts supported relationships using BioREx.
- **Coverage:** Includes diseases, chemicals/drugs, genes, variants, species and cell lines. Coverage is limited to supported entity and relationship types; it is not a complete medical graph of every paper.
- **Access:** Provides a web interface and an API for searching literature and exporting annotations.
- **Use in AMOS:** the indexer fetches the annotations of crawled PubMed papers by PMID and stores them with the paper (section 2).
- **Limits:** no procedures, some drugs missed, and only PubMed papers are annotated ([known limitations](../Documentation/design/graph-normalization.md#known-limitations)).

## 4. Results

**Status.** Measured on 2026-11-24 and 2026-11-25 at the commits named below. Later changes to the rankings were not measured again: `262ff55` ranks papers on another disease lower for patients without cancer, which can change the lists of those journeys, and made the graph search faster, so the latency columns predate it; `8429df6` translates German words that keyword matching does not know through the German MeSH, which changes keyword lists of patient graphs and of other diseases. The disease profiles added afterwards leave every graph ranking unchanged: the lists of all journeys and dates were compared before and after.

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

The offline comparator combines each method's first 30 hits by equal-weight reciprocal rank fusion with k = 60. Every returned top-ten hit has an LLM grade. The latest round added 163 judgments and included 44 hidden calibration pairs. Agreement with the earlier grades was 59% exact and 98% within one grade. The table gives newer judgments precedence where the pools overlap. Giving earlier judgments precedence yields 0.535 for graph versus 0.512 for keyword on patient graphs, and 0.640 versus 0.626 on timelines. Keyword still leads on the five holdout patients with graph input under the main grading order. These are retrospective results on ten synthetic cases. Performance on new patients or with clinician judgments remains open. [Rank fusion method](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf) · [Pooled judgments](../matcher/evaluation/graph-llm-judgments.json) · [Patient graph limitations](#input-format-and-findings)

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

**Diagnoses of untested diseases.** The next revision adds reviewed ICD-10 categories for the malignant neoplasms (a code such as C67.2 takes its category's disease), German clinical forms of neoplasm names (`Rektumkarzinom` beside MeSH's `Rektumkrebs`), and lets no general heading such as carcinoma set the filter alone ([codes and names](../Documentation/design/graph-normalization.md#entities)). On the rectal journey, now development data, it recognised the cancer at all four milestones (0.083 → 0.505 on the enlarged pool, grade-0 hits 36 → 7 of 40). A second holdout of five journeys, written and frozen as before (bladder and pancreatic cancer, myeloma, type 2 diabetes and heart failure, chosen by the author for their coverage in the corpus), changed six of twenty lists. Graded by one blind grader (6 of 6 calibration pairs exact), mean nDCG@10 over the twenty points rose by 0.090; on the six changed points it rose by 0.300, and their grade-0 hits fell from 31 to 12 of 60. The pancreatic cancer was recognised at three milestones instead of none, the bladder cancer only at the last: the journey's "carcinoma in situ", a histological heading outside the general ones, made the pathology report contradict its code. The first milestone of the pancreatic, myeloma and heart failure journeys stays empty in every version, as no diagnosis is named yet. The prostate lists and the other development lists did not change.

**Kinds of carcinoma, side findings and ICD subcodes.** A third revision treats a kind of carcinoma without a site, such as carcinoma in situ, as a general word; reads another finding in a progression or pathology label as no diagnosis once a cancer is named; lets a code below a category that Mondo maps to one disease take that disease (E11.74, I50.14); and counts only two different cancers as a contradiction between name and code. On the development journeys it kept every event (one was discarded before) and recognised the bladder cancer at three milestones instead of one, but its graded lists summed 0.10 lower: the first bladder milestone is now empty where the carcinoma-in-situ filter had found some relevant papers. A third holdout (stomach and kidney cancer, melanoma, depression and stroke, written and frozen as before) changed one of twenty lists, by +0.001, so it gives no evidence either way. Against the original baseline it recognised the cancers better (stomach 4 of 4 milestones instead of none, kidney 4 instead of 2) and left fewer lists empty (5 instead of 9), which the second revision achieved already. Depression and stroke stayed weak in every version: their diagnoses appear as German clinical terms (`mittelgradige depressive Episode`) or with codes that no mapping covers (F32), and the acute stroke events carry neither. Holdout 3 was graded only on the changed list.

**Metastases beside the primary, ICD-10-CM subcodes and German forms.** A fourth revision treats what a tumour does, such as lymphatic metastasis, as a general word; lets a metastasis code (C77 to C79) contradict no name of the primary; reads the categories that Mondo maps only in ICD-10-CM for codes with a subcode (F32.1); reads the ICD-10-GM side after a code (`C50.4 L`); takes a code in a text only in capitals and standing alone (not `HLA-B27` or `p53`); and adds the genitive of one-word German disease names (`Magenkarzinoms`). The prostate lists did not change. Of 80 development lists, 5 changed: two rose a little (+0.04, +0.03), one was only reordered, and the two depression milestones, empty before, now return ten papers each. The depression is recognised now, but 16 of its 20 new papers are grade 0, mostly antidepressants in other patients (tinnitus, kidney disease, dementia). A fourth holdout (colon and thyroid cancer, myocardial infarction, gout, and COPD as a control), chosen after the revision was built where its rules can apply and written and frozen as before, changed 7 of 20 milestone lists. Mean nDCG@10 rose by 0.013 over the twenty milestones and by 0.036 over the seven (one blind grader, 5 of 6 calibration pairs exact). The gain comes from the infarction journey (+0.43 over three lists), against a loss at the first gout milestone (−0.24): the code adds the broader heading beside the specific name (myocardial infarction beside STEMI, gout beside gouty arthritis). That helps where the specific heading has few papers and hurts where it was the sharper filter. Six of the seven changed lists come from this one rule. The metastasis rule changed one graded list (−0.004), the genitive one query and no list, and the code shape and the ICD-10-GM side none; for these, and for a code where no name resolves (the depression on the development data), the holdout gives no evidence. The thyroid journey keeps an event that the previous revision discarded (a lymph node metastasis code beside the papillary carcinoma); COPD did not change. The expected diagnosis was recognised at 18 of 20 milestones in both revisions (14 in the original baseline). Of the 76 event lists, 25 changed; they were not graded.
