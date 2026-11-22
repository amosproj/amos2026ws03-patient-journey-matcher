# Graph normalization

The first part of the graph approach. Graph matching compares the patient graph with the PubTator3 annotations of a paper: the entities that PubTator3 found in the title and abstract, and the relations between them ([research](../../research/graph-based-matching.md)). The two inputs say the same things in different words, IDs and relation types:

| | Patient graph | PubTator3 annotations of a paper |
|---|---|---|
| Disease | `C61 Prostatakarzinom`, `Adenokarzinom der Prostata` | `Prostatic Neoplasms` (`MESH:D011471`) |
| Treatment | edge `TREATED_BY`, from the disease to the drug | relation `Negative_Correlation`, from the drug to the disease |
| Certainty | `Vd. a. Prostatakarzinom` (suspected), confirmed weeks later | none: what the abstract states |

Normalization rewrites both into one form, for example:

```
patient:  mesh:C531550 (olaparib)  treats  mesh:D011471 (prostate cancer)   asserted, from 2026-12-08
paper:    mesh:C531550 (olaparib)  treats  mesh:D011471 (prostate cancer)   score 0.998
```

It gives every name a shared ID, maps every edge and relation type to one predicate with one direction, and gives each patient statement a status. It runs offline and sends nothing about the patient out. It does not rank papers: that is the job of the graph matcher, which is not built yet, like the graph indexer. Until both exist, the approach is not in the registry. Code: [`matcher/algorithms/graph/`](../../matcher/algorithms/graph/src/). What the patient graph holds and lacks: [input findings](../../research/graph-based-matching.md#input-format-and-findings).

## Shared representation

Both inputs become entities and relations between them; the patient graph also gives facts about the patient ([`types.ts`](../../matcher/algorithms/graph/src/types.ts)).

**Entity types:** `disease`, `chemical`, `gene`, `variant`, `procedure`, `finding`, `device`. PubTator3 has no procedure, finding or device type, so these match no paper triple; they stay for context and the keyword fallback.

**Entity IDs:** the IDs that PubTator3 uses, `mesh:<ID>` for diseases and chemicals and `ncbigene:<ID>` for genes. A patient entity without a mapping has no ID. It keeps its names but takes no part in triple matching, because a made-up ID could never match a paper.

**Predicates:**

| Predicate | Direction | Patient graph | PubTator3 |
|---|---|---|---|
| `treats` | chemical or procedure → disease | `TREATED_BY`, reversed | `Negative_Correlation` chemical → disease |
| `causes` | chemical → disease | none | `Positive_Correlation` chemical → disease |
| `improves_outcome`, `worsens_outcome` | chemical → outcome | none | `treats` or `causes` with an outcome such as Death |
| `indicates` | finding → disease | `INDICATES`, `CONFIRMED_BY`, `SYMPTOM_OF` | none |
| `associated_with` | symmetric | none | `Association` |
| `positive_correlation`, `negative_correlation` | as stored | none | the correlations without a disease |
| `cotreated_with`, `compared_with` | symmetric | none | `Cotreatment`, `Comparison` |
| `interacts_with` | symmetric | none | `Bind`, `Drug_Interaction`, `Conversion` |
| `related` | as stored | `RELATES_TO` between findings | none |
| `has_condition`, `receives`, `has_finding` | patient → entity | edges from the `Patient` node, such as `HAS_DIAGNOSIS`, `UNDERWENT`, `HAS_PATHOLOGY` | none |

Unknown relation types become `related`; they are not rejected. Symmetric predicates store their two ends in a fixed order, so `A compared_with B` and `B compared_with A` are one triple.

**Status** of a patient statement: `asserted`, `suspected`, `negated`, `planned` or `unknown` ([status](#status)). PubTator3 relations are `asserted` and keep their score.

Each triple keeps where it came from: the patient edge, or the PMID and the relation; the original type; the fact sentence or the score; and for patient edges `valid_at` and `invalid_at`.

## Entities

A patient entity gets its ID from the first tier that knows its code or name ([`resolve.ts`](../../matcher/algorithms/graph/src/resolve.ts)):

| Tier | Looks up | Example | Built |
|---|---|---|---|
| 1. Code | The ICD-10 code of a diagnosis, in [`icd10-mesh.json`](../../matcher/algorithms/graph/data/icd10-mesh.json) | C61 → `mesh:D011471` | yes |
| 2. Curated name | German and English names and abbreviations, in [`concepts.json`](../../matcher/algorithms/graph/data/concepts.json) | `Prostatakarzinom`, `PCa`, `prostate cancer` → `mesh:D011471`; `RPE` → Prostatectomy | yes |
| 3. Corpus dictionary | The mention texts and IDs of the PubTator3 annotations that the graph indexer stores | a spelling that our papers use → the ID PubTator3 gave it | no: needs the graph indexer |
| 4. MeSH entry terms | The MeSH files of NLM | `Leuprorelin`, an entry term of Leuprolide | no, optional |

- **Tier 3 finds only IDs that can match:** it holds exactly the IDs of our papers, with their spellings. Tiers 1 and 2 cover what it cannot: German names, clinical abbreviations and the ICD codes of the patient. The curated IDs were checked with the PubTator3 entity lookup and the NLM MeSH lookup, sending only generic drug and disease names.
- **Names match whole**, after case, accents and punctuation are normalized ([`text.ts`](../../matcher/algorithms/graph/src/text.ts)). There is no fuzzy matching: `prostatitis` and `prostate cancer` are close as strings and far as concepts, and a wrong ID is worse than none.
- **The concept decides the type**, not the node label: a catheter labelled `Medication` becomes a `device` and can never match `olaparib treats …`, and PSA labelled `LabTest` becomes the gene KLK3, as PubTator3 annotates it. Without a concept, the label decides: a diagnosis, symptom or allergy is a disease, a medication a chemical, a procedure or treatment plan a procedure, and a lab test, tumor marker, pathology or imaging result a finding.
- **Duplicates merge:** nodes with the same ID become one entity with all their names. In Patient-5, `C61 Prostatakarzinom`, `prostate cancer` and `Adenokarzinom der Prostata` are one entity. Nodes without an ID merge only when their names are the same.

**Not done, by decision:**

- **Sending patient names to PubTator3's annotation service, an LLM or an embedding API.** That sends journey data out and needs a team decision ([rules](../../matcher/algorithms/README.md#rules)).
- **UMLS crosswalks from ICD-10 to MeSH.** They need a UMLS licence per user and may not be put in the repository.
- **IDs from the graph builder.** The LLM that builds the patient graph ([patient graph tool](../../tools/patient-graph/README.md)) could write a MeSH ID per node, but the graph builder of the real app belongs to AIlixir. This is a question for them.

## Relations

Each input has one table that maps a relation by its type and the types of both ends: [`patient-relations.json`](../../matcher/algorithms/graph/data/patient-relations.json) and [`pubtator-relations.json`](../../matcher/algorithms/graph/data/pubtator-relations.json). A new type is a new row.

- **One direction:** `treats` and `causes` always point from the drug or procedure to the disease. `TREATED_BY`, stored from the disease to the drug, is reversed.
- **Outcomes are not diseases:** with an outcome from [`outcomes.json`](../../matcher/algorithms/graph/data/outcomes.json), `olaparib treats Death` becomes `olaparib improves_outcome Death`, so it never matches a patient's disease.
- **Left out:** `Provider`, `Appointment`, `Referral` and `VitalSigns` nodes with their edges, the PubTator3 types `Species` and `CellLine`, edges whose two ends became one entity, and PubTator3 relations below a minimum score (0 by default; the value is still to be chosen). Each is listed with the reason. A node or edge that cannot be read is left out too and does not reject the graph.
- **Duplicates:** relations with the same triple in one paper become one, with the highest score.
- **Patient facts are not paper triples.** Matching combines them into patterns: `has_condition(A)` and `receives(B)` give the query `B treats A`.
- **Treatment links only with evidence (not built yet).** For the patient, `B treats A` is derived only from a text that names both and resolves to a diagnosis of the patient: the indication of a procedure, the recommendation of a treatment plan or the fact of an edge. Without such a text, matching uses the pattern above with a lower weight.

## Status

Status belongs to one statement at its time, not to the concept: in Patient-5, prostate cancer is suspected in November 2026 and confirmed in December. The matcher is to take the latest statement per concept up to `as_of`. For each patient edge, the first of these rules applies ([`status.ts`](../../matcher/algorithms/graph/src/status.ts), cue words in [`status-cues.json`](../../matcher/algorithms/graph/data/status-cues.json)):

1. **A cue word near the entity in the fact sentence, in the same clause:** `suspected`, `Verdacht auf`, `cannot be ruled out` → `suspected`; `no evidence of`, `ruled out`, `ausgeschlossen` → `negated`; `confirmed`, `diagnosed with` → `asserted`. Of two overlapping cues the longer wins. German cues are kept because German terms leak into Graphiti's English facts.
2. **`planned`** for a treatment plan.
3. **The node attribute `status: active`** → `asserted`, but only from the node's `date_confirmed` on. Graphiti rewrites a node with every document, so the attribute describes the end of the record, not its first weeks.
4. **`unknown`.** Never `asserted` by default; the matcher is to treat `unknown` as weaker than `asserted`, not as a negative. One exception: a condition that is still `unknown` becomes `asserted` from the day a pathology result of the same concept confirms it (`CONFIRMED_BY`).

## Try it

From the repository root:

```sh
pnpm --dir matcher --filter @matcher/graph normalize patientdata/Patient-5/graph.json
pnpm --dir matcher --filter @matcher/graph normalize matcher/algorithms/graph/fixtures/pubtator/32343890.json --min-score 0.5
```

It prints each entity with its ID and the tier that found it, the patient facts, the relations and what was left out. The Index › Graph screen of the [debug UI](../../debug/README.md) shows the same, with the sentence and cue behind each status. The papers are trimmed PubTator3 exports ([test fixtures](../../matcher/algorithms/graph/fixtures/pubtator/README.md)).

An entity without an ID can never match a paper. Close the gap with a row in `concepts.json`, not with a looser match; [`data.test.ts`](../../matcher/algorithms/graph/src/data.test.ts) checks the data files against each other.

## Known limitations

- **PubTator3's `treat` is a negative correlation:** the chemical lowers the disease. A `treats` triple says that a paper links the drug and the disease, not that the drug works. `causes` can be a side effect, such as olaparib causing anemia.
- **PubTator3 has no negation, no evidence sentence and no date.** A relation holds for the whole title and abstract, with a confidence score only, so a central result and a background mention look the same.
- **Gaps in PubTator3:** it does not annotate leuprorelin, leuprolide or goserelin, the drugs of several synthetic patients, so their facts never meet a paper triple. It often annotates "PSA" as the gene NPEPPS instead of KLK3, and it gives abiraterone two IDs that do not match each other.
- **Procedures** such as prostatectomy, radiotherapy and biopsy have IDs on the patient side, but PubTator3 has no procedure type, so they match no paper triple.
- **`TREATED_BY` is missing from some patient graphs**, Patient-5 among them. They give no `treats` triple, and matching starts from the patient facts, as the [research](../../research/graph-based-matching.md#2-questions-our-matching-proposal-must-answer) plans with typed placeholders.
- **Curated names** cover the concepts of the 20 synthetic patients. A name that the graph's LLM writes differently has no ID until it is added. Broader and narrower concepts (castration-resistant prostate cancer under prostate cancer) are not expanded.
- **Status comes from rules** over sentences that an LLM has already rewritten: a hedge it dropped is lost. There is no status for past conditions ("history of", "Z. n.") yet.
- **Worked out on Patient-5 and three papers.** Types absent from them, such as `Bind`, are mapped from their documented meaning, not from data.
- **Out of scope:** PubMed MeSH headings and the concepts of Zenodo, arXiv, podcasts and YouTube. Graph matching covers only PubMed papers with PubTator3 annotations; the keyword approach finds the rest, and the two rankings can be merged with `reciprocalRankFusion`.
