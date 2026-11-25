# Graph normalization

The first part of the graph approach. Graph matching compares the patient graph with the PubTator3 annotations of a paper: the entities that PubTator3 found in the title and abstract, and the relations between them; and with the paper's PubMed MeSH headings ([research](../../research/graph-based-matching.md)). The two inputs say the same things in different words, IDs and relation types:

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

It gives every name a shared ID, maps every edge and relation type to one predicate with one direction, and gives each patient statement a status. It runs offline and sends nothing about the patient out. During indexing, only PubMed IDs go to PubTator3. The index keeps concept IDs, names, title mentions, relations and the MeSH headings of `documents.subjects` for papers under any licence. Patient queries read this index locally. Code: [`matcher/algorithms/graph/`](../../matcher/algorithms/graph/src/). What the patient graph holds and lacks: [input findings](../../research/graph-based-matching.md#input-format-and-findings).

## Shared representation

Both inputs become entities and relations between them; the patient graph also gives facts about the patient ([`types.ts`](../../matcher/algorithms/graph/src/types.ts)).

**Entity types:** `disease`, `chemical`, `gene`, `variant`, `procedure`, `finding`, `device`. PubTator3 has no procedure, finding or device type, so these match no paper triple; they stay for context and the keyword fallback.

**Entity IDs:** the IDs that PubTator3 uses, `mesh:<ID>` for diseases and chemicals and `ncbigene:<ID>` for genes. A variant gets one ID from the parts PubTator3 writes: its dbSNP number (`dbsnp:rs113488022`), else its HGVS name with the gene (`hgvs:673:p.V599E`). A patient entity without a mapping has no ID. It keeps its names but takes no part in triple matching, because a made-up ID could never match a paper.

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

An unknown relation type between two entities becomes `related`; it is not rejected. An unknown edge type from the patient is left out. Symmetric predicates store their two ends in a fixed order, so `A compared_with B` and `B compared_with A` are one triple.

**Status** of a patient statement: `asserted`, `suspected`, `negated`, `planned` or `unknown` ([status](#status)). PubTator3 relations are `asserted` and keep their score.

Each triple keeps where it came from: the patient edge, or the PMID and the relation; the original type; the fact sentence or the score; and for patient edges `valid_at` and `invalid_at`.

## Entities

The matcher resolves a patient entity locally. Both input formats use the same concepts for retrieval. [Resolver](../../matcher/algorithms/graph/src/resolve.ts)

- **Codes.** The matcher uses reviewed ICD entries and unambiguous ICD-10-WHO mappings through Mondo to MeSH. A code for a group does not establish a particular subtype.
- **Names.** Clinical aliases, German and English MeSH disease names and the names PubTator3 gives the concepts of the local index can identify a concept. How a paper spells a concept is not learned. Ambiguous names need more evidence. MeSH descendants can retrieve a paper on a more specific disease, for example a non-small-cell carcinoma in a lung cancer journey. A heading for a whole field, such as Neoplasms, is searched without its descendants.
- **Terminology sources.** The offline dictionary uses NLM MeSH 2026, its German translation by ZB MED and the November 2026 Mondo mapping files. No patient text is needed to build either dictionary. [German MeSH 2026](https://www.zbmed.de/en/about/press/latest-news/article/for-research-libraries-and-ai-zb-med-publishes-the-german-mesh-2026) · [Mondo mappings](https://github.com/monarch-initiative/mondo/tree/v2026-11-03/src/ontology/mappings) · [Build the dictionary](../../matcher/algorithms/graph/scripts/build-terminology.py)
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
- **Left out:** `Provider`, `Appointment`, `Referral` and `VitalSigns` nodes with their edges, the PubTator3 types `Species` and `CellLine`, variants without a dbSNP number or HGVS name (`C>G` alone names no one variant), edges whose two ends became one entity, and PubTator3 relations below a minimum score (0 by default; the value is still to be chosen). Each is listed with the reason. A node or edge that cannot be read is left out too and does not reject the graph.
- **Duplicates:** relations with the same triple in one paper become one, with the highest score.
## Ranking

At referral, a test that indicates a diagnosis can supply a suspected diagnosis if the graph has no direct diagnosis. A paper is a candidate when its PubTator3 annotations or MeSH headings name one of the patient's non-negated diagnoses or a narrower form that has not been ruled out, such as castration-resistant prostate cancer ([`matcher.ts`](../../matcher/algorithms/graph/src/matcher.ts)). A general word such as tumor or adenocarcinoma beside a specific cancer is no diagnosis of its own.

- **Concepts:** the patient's statements active on `as_of` become weighted concepts: diagnoses, disease states, drugs, procedures, tests, genes, findings and symptoms. A concept counts with the IDs a paper may carry for it: `also`, `broader` and `narrower` in [`concepts.json`](../../matcher/algorithms/graph/data/concepts.json), and MeSH qualifiers such as Prostatic Neoplasms/surgery. The focus day weighs the news of the day, the current therapy (the one started last, also when a document restates it) and, at half strength, measurements such as PSA.
- **Score:** each concept counts once, with its strongest evidence on the paper (PubTator3 title or abstract, MeSH major topic, other heading or substance), times its inverse frequency among the candidates. The general ranking gives diagnosis groups a minimum IDF of one so title and major-topic evidence still count when all candidates share a diagnosis. The prostate ranking retains its calibrated IDF.
- **Rerank:** a mapped concept in a candidate’s title can supply evidence missing from its annotations, including an unindexed procedure. Each concept still counts once. An explicit patient indication restricts the treatment to papers with a compatible diagnosis. A matching paper relation earns extra weight. At a confirmed diagnosis with no treatment or other focus concept, a paper studying a treatment for that diagnosis can also earn a bonus. A paper that links the same drug only to another disease gets no drug contribution. If the patient's indication is unknown, the explanation attributes the link to the paper. When only the paper names a narrower diagnosis, the explanation identifies it as the paper's subtype. An explicit small-cell or non-small-cell lung histology lowers the rank of papers that cover only the other subtype. Prostate care and stage rules apply only to papers on prostate cancer, for a patient who has it, whatever else he has. At PSA workup, on active surveillance and after a prostatectomy with recurrence, a paper can also match the specific care question. Papers lose weight when they are about another state ([`stages.ts`](../../matcher/algorithms/graph/src/stages.ts), [`stages.json`](../../matcher/algorithms/graph/data/stages.json)), about treatment before any treatment decision, lab research, about the other sex, another cancer ([`neoplasms.json`](../../matcher/algorithms/graph/data/neoplasms.json)) or a treatment option he did not get. The publication type counts a little: guidelines and reviews up, case reports down.

The constants are `SETTINGS` in `matcher.ts`. In the debug UI, a `tuning` object in the arguments overrides them. How they were set and what they achieve: [results](../../research/graph-based-matching.md#7-results).

## Status

Status belongs to one statement at its time, not to the concept: in Patient-5, prostate cancer is suspected in November 2026 and confirmed in December. The matcher uses dated statements active on `as_of`, or on the last journey day if omitted. `invalid_at` is the first inactive day. For a fact or triple it takes the latest active statement. A negation wins on a same-day tie. The focus day carries extra weight. For each patient edge, the first of these rules applies ([`status.ts`](../../matcher/algorithms/graph/src/status.ts), cue words in [`status-cues.json`](../../matcher/algorithms/graph/data/status-cues.json)):

1. **A cue word near the entity in the fact sentence, in the same clause:** `suspected`, `Verdacht auf`, `cannot be ruled out` → `suspected`; `no evidence of`, `ruled out`, `ausgeschlossen` → `negated`; `confirmed`, `diagnosed with` → `asserted`. Of two overlapping cues the longer wins. A confirmation after the name beats a suspicion before it: `the suspected prostate cancer was confirmed`. A cue right after a negation says nothing: `could not be ruled out`, `has not been confirmed`. German cues are kept because German terms leak into Graphiti's English facts.
2. **`planned`** for a treatment plan.
3. **The node attribute `status: active` or `confirmed`** → `asserted`, but only from the node's `date_confirmed` on. Graphiti rewrites a node with every document, so the attribute describes the end of the record, not its first weeks.
4. **`unknown`.** The matcher gives `unknown` less weight than `asserted`. A diagnosis with unknown status becomes `asserted` from the day a pathology result of the same concept confirms it (`CONFIRMED_BY`).

## Try it

From the repository root:

```sh
pnpm --dir matcher --filter @matcher/graph normalize patientdata/Patient-5/graph.json
pnpm --dir matcher --filter @matcher/graph normalize matcher/algorithms/graph/fixtures/pubtator/32343890.json --min-score 0.5
```

It prints each entity with its ID and the tier that found it, the patient facts, the relations and what was left out. The Index › Graph screen of the [debug UI](../../debug/README.md) shows the same, with the sentence and cue behind each status. The papers are trimmed PubTator3 exports ([test fixtures](../../matcher/algorithms/graph/fixtures/pubtator/README.md)).

After crawling PubMed papers, run `make index APPROACHES=graph`. In the debug UI, select **Matcher → Graph** and choose Patient-5. Each result explains its strongest match. On a timeline, a diagnosis, pathology or progression event can supply a mapped diagnosis name or ICD code in its label. Other events can supply `parameters.diagnosis` or `parameters.icd_code`. Later events can confirm or rule out a known diagnosis. Family history is excluded. The other concepts come from the labels and text parameters of the events, and from the parameters in [`timeline.json`](../../matcher/algorithms/graph/data/timeline.json). A tumor board plans the therapies it names; the latest event that gives one sets the current therapy. A cancellation withdraws the named plan from that day onward.

The query trace shows dated diagnostic evidence, explicit links and missing indications. If the entity has no usable ID at the cutoff, check its spelling or code in the local terminology. If the ID is present and the candidate pool is empty, check the annotations and headings of the indexed papers.

## Known limitations

- **PubTator3's `treat` is a negative correlation:** the chemical lowers the disease. A `treats` triple says that a paper links the drug and the disease, not that the drug works. `causes` can be a side effect, such as olaparib causing anemia.
- **PubTator3 has no negation, no evidence sentence and no date.** A relation covers the whole abstract. A drug linked to the patient's diagnosis earns a relation bonus. The title provides separate evidence that a concept is central to the paper. Neither signal establishes whether the study found a benefit.
- **Gaps in PubTator3:** it does not annotate leuprorelin, leuprolide, goserelin, the drug class PARP inhibitor or any procedure, so only the MeSH headings find them. It often annotates "PSA" as the gene NPEPPS instead of KLK3, and it gives abiraterone two IDs that do not match each other.
- **`TREATED_BY` is missing from some patient graphs**, Patient-5 among them. A paper can still match a treatment for the diagnosis. The matcher does not extract additional indications from free text.
- **Vocabulary coverage.** The distributed vocabulary covers MeSH diseases and substances with a listed pharmacological action. Code mappings are partial, especially for national ICD extensions. Each graph index run refreshes the PubTator3 concept names that the matcher learns from the index. A paper with neither a matching annotation nor a MeSH heading misses the diagnosis gate even if its title would be relevant.
- **Status comes from rules** over sentences that an LLM has already rewritten: a hedge it dropped is lost. There is no status for past conditions ("history of", "Z. n.") yet. Of a label, a parameter or a fact sentence, the matcher reads the first 2,000 characters.
- **Relation types.** The original relation tables used Patient-5 and three papers. Less frequent types such as `Bind` follow the source documentation.
- **A journey often names no diagnosis.** On timelines, a Gleason grade or a radical prostatectomy can establish a prostate workup context. Within that context a disease-specific drug can strengthen the inference. A PSA from 4 ng/ml at referral or a PI-RADS from 3 can supply a suspected diagnosis. These rules are written for prostate cancer.
- **The synthetic patient graphs name the pathway early and lag the timeline:** Patient-5's diagnosis text names the later recurrence a month before the surgery, Patient-8's names enzalutamide years before he gets it, and Patient-10's graph ends two months before his palliative care. The matcher reads a graph as it is.
- **Source coverage:** PubMed papers can match through PubTator3 or MeSH. Other sources can match when they carry mapped MeSH headings. Missing, malformed or individually oversized records are checked again after two days. Earlier annotations stay searchable during retries. A failed request is retried on the next index run. The keyword approach also covers other sources.
