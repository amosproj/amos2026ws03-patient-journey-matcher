import type { JourneyState } from "@matcher/core";
import { readGraph } from "./graph-reader.ts";
import { LUNG, NSCLC, SCLC } from "./histology.ts";
import {
  type ClinicalEvidence,
  isLocalTherapy,
  latest,
  type Reading,
  ROLES,
  type Role,
  roleOf,
  startReading,
  tripleKey,
} from "./reading.ts";
import {
  broaderDiagnosis,
  type Concept,
  conceptOf,
  defaultTerminology,
  isProstateCancer,
  type Terminology,
} from "./resolve.ts";
import {
  type PatientStage,
  patientStage,
  unspecificDiagnoses,
} from "./stages.ts";
import { readTimeline } from "./timeline-reader.ts";
import type { Status } from "./types.ts";

export { ROLES };

/** A patient concept the matcher looks for in papers. */
export interface QueryConcept {
  /** The IDs a paper may have for it: its own first, then other vocabularies (PSA: gene and MeSH). */
  ids: string[];
  /** Paper diagnosis IDs compatible with an explicit patient link, including narrower forms. */
  diagnoses?: string[];
  /** Original targets of the patient's links, before expansion for retrieval. */
  documentedTargets?: { active: string[]; planned: string[] };
  /** These targets have only a plan, without an active treatment relationship. */
  plannedFor?: string[];
  name: string;
  role: Role;
  /** Role weight × certainty × focus; broader concepts and aspects get a share of it. */
  weight: number;
  /** A statement of the focus day. */
  focus: boolean;
}

export interface GraphQuery {
  /** The patient has prostate cancer: its stage and care rules apply to the papers on it. */
  prostateContext: boolean;
  histology?: { observed: string; conflicting: string };
  evidence: ClinicalEvidence[];
  cutoff: string;
  /** A paper needs one of these to be a candidate: the diagnoses and their narrower forms. */
  diagnoses: Map<string, number>;
  concepts: QueryConcept[];
  stage: PatientStage;
  /** The patient's drugs, for papers that link one to his diagnosis. */
  treatments: Map<string, number>;
  /** Patient relations between two concepts, by `tripleKey`. */
  relations: Map<string, number>;
  /** The sex a diagnosis implies (prostate cancer: male), for papers on the other sex only. */
  sex?: string;
  conceptOnly: boolean;
}

/** The weights the query gives; the matcher can override them (`tuning`). */
export interface QueryWeights {
  roles: Record<Role, number>;
  /** Factor for the statements of the focus day. */
  focus: number;
  /** Share of a concept's weight for a broader concept, such as radiotherapy for IMRT. */
  broader: number;
  /** Share of a concept's weight for its MeSH qualifier aspect (Prostatic Neoplasms/surgery). */
  aspect: number;
  /** Read disease-state cues from the sentences of the patient's statements, not only names. */
  sentences: boolean;
  /** Share of the focus factor for a measurement of the focus day, such as a PSA value. */
  measurement: number;
}

export const DEFAULT_WEIGHTS: QueryWeights = {
  roles: {
    diagnosis: 1,
    stage: 2,
    drug: 3,
    procedure: 3,
    test: 1.5,
    gene: 2,
    finding: 1,
    symptom: 1.5,
    aspect: 1,
  },
  focus: 3,
  broader: 0.5,
  aspect: 0.25,
  sentences: true,
  measurement: 0.5,
};

// MeSH qualifiers of a diagnosis that say what a paper does with it.
const DRUG_THERAPY = "Q000188";
const ADVERSE_EFFECTS = "Q000009";

/** Collects weighted concepts; a concept found twice keeps its highest weight. */
class ConceptSet {
  readonly byId = new Map<string, QueryConcept>();
  private readonly weights: QueryWeights;

  private readonly excluded: ReadonlySet<string>;

  constructor(weights: QueryWeights, excluded: ReadonlySet<string>) {
    this.weights = weights;
    this.excluded = excluded;
  }

  add(
    concept: Concept,
    role: Role,
    weight: number,
    focus: boolean,
    scope: Pick<QueryConcept, "diagnoses" | "documentedTargets" | "plannedFor">,
    aspects: string[],
  ): void {
    // A paper on a narrower form (castration-resistant) is a paper on the diagnosis too.
    const ids =
      role === "diagnosis"
        ? diagnosisIds(concept, this.excluded)
        : [concept.id, ...(concept.also ?? [])];
    this.put({ ids, name: concept.name, role, weight, focus, ...scope });
    for (const id of concept.broader ?? []) {
      if (this.excluded.has(id)) continue;
      const broader = conceptOf(id);
      this.put({
        ...scope,
        ids: [id, ...(broader?.also ?? [])],
        name: broader?.name ?? id,
        role,
        weight: weight * this.weights.broader,
        focus,
      });
    }
    // What a paper does with the diagnosis or the concept: surgery, drug therapy, side effects.
    const aspect = (id: string) =>
      this.put({
        ids: [id],
        name: `${concept.name} (${id.endsWith(ADVERSE_EFFECTS) ? "adverse effects" : "aspect"})`,
        role: "aspect",
        weight: weight * this.weights.aspect,
        focus,
      });
    const qualifier =
      concept.qualifier ?? (role === "drug" ? DRUG_THERAPY : undefined);
    if (qualifier !== undefined)
      for (const diagnosis of aspects) aspect(`${diagnosis}${qualifier}`);
    if (role === "drug" || role === "procedure")
      aspect(`${concept.id}${ADVERSE_EFFECTS}`);
  }

  private put(concept: QueryConcept): void {
    const key = concept.ids[0];
    const known = this.byId.get(key);
    if (known === undefined || known.weight < concept.weight)
      this.byId.set(key, {
        ...concept,
        focus: concept.focus || (known?.focus ?? false),
      });
    else if (concept.focus) known.focus = true;
  }
}

// shortcut: a heading with more narrower forms than this is a whole field, not a diagnosis
// ("Neoplasms" has 702, "Infections" 785; every MeSH heading above 100 is such a category). It
// is searched by its own ID only: with all its forms a match took seconds on 30,000 documents.
const MAX_NARROWER = 100;

/** The IDs a paper may have for a diagnosis: the concept, its other IDs and narrower forms. */
function diagnosisIds(
  concept: Concept,
  excluded: ReadonlySet<string>,
): string[] {
  const narrower = concept.narrower ?? [];
  return [
    concept.id,
    ...(concept.also ?? []),
    ...(narrower.length > MAX_NARROWER ? [] : narrower),
  ].filter((id) => !excluded.has(id));
}

/** The query from what was read: the diagnoses to search by and the weighted concepts. */
function buildQuery(reading: Reading, fromGraph: boolean): GraphQuery {
  const {
    focus,
    weights,
    cutoff,
    conceptOf,
    factor,
    evidence,
    links,
    diagnoses,
    excluded,
    diagnosisDates,
    diagnosticHistory,
    histologyNotes,
    stageIds,
    stageTexts,
    observed,
    therapy,
    found,
  } = reading;
  const scoped = new Map<string, Map<string, Status>>();
  const expand = (id: string) => {
    const concept = conceptOf(id);
    return concept && !excluded.has(id) ? diagnosisIds(concept, excluded) : [];
  };
  const treatments = new Map<string, number>();
  const relations = new Map<string, number>();
  const lungHistologies = new Set<string>();
  if ([LUNG, NSCLC, SCLC].some((id) => diagnoses.has(id))) {
    // A subtype may be documented as a diagnosis in its own right or in a pathology field.
    for (const fact of diagnosticHistory)
      if (
        (fact.entity === NSCLC || fact.entity === SCLC) &&
        fact.validAt &&
        !(fact.invalidAt && fact.invalidAt <= cutoff)
      )
        histologyNotes.push({
          validAt: fact.validAt,
          ref: fact.ref,
          subtype: fact.entity,
          status: fact.status,
        });
    const last = histologyNotes
      .filter((note) => note.status === "asserted")
      .map((note) => note.validAt)
      .sort()
      .at(-1);
    for (const note of latest(histologyNotes, (note) => note.subtype, cutoff)) {
      diagnosisDates.set(note.subtype, note.validAt);
      if (note.status === "negated") {
        excluded.add(note.subtype);
        diagnoses.delete(note.subtype);
      } else if (note.status === "asserted") excluded.delete(note.subtype);
      if (!last || note.validAt < last || note.status !== "asserted") continue;
      lungHistologies.add(note.subtype);
      evidence.push({
        date: note.validAt,
        ref: note.ref,
        concept: note.subtype,
        diagnosis: LUNG,
        status: "asserted",
        detail: "Documented lung histology",
      });
    }
  }
  const histology = [
    { observed: NSCLC, conflicting: SCLC },
    { observed: SCLC, conflicting: NSCLC },
  ].find(
    ({ observed, conflicting }) =>
      lungHistologies.has(observed) && !lungHistologies.has(conflicting),
  );

  // A ruled-out subtype also excludes its descendants unless a later diagnosis names one.
  for (const id of [...excluded]) {
    const date = diagnosisDates.get(id);
    if (!date) continue;
    for (const child of conceptOf(id)?.narrower ?? []) {
      if (!diagnoses.has(child) || (diagnosisDates.get(child) ?? "") <= date)
        excluded.add(child);
    }
  }
  for (const id of excluded) diagnoses.delete(id);
  const unspecific = new Set(unspecificDiagnoses([...diagnoses.keys()]));
  for (const id of unspecific) diagnoses.delete(id);
  if (unspecific.size && !diagnoses.size)
    evidence.push({
      ref: focus.id,
      date: cutoff,
      detail: "Only a general heading such as carcinoma, no specific diagnosis",
    });

  for (const link of latest(links, tripleKey, cutoff)) {
    const { subject, object, predicate, ref, validAt, status } = link;
    evidence.push({
      ref,
      date: validAt,
      concept: subject,
      diagnosis: object,
      detail: predicate,
      status,
    });
    const plan = predicate === "treats" && status === "planned";
    if (status !== "asserted" && status !== "unknown" && !plan) continue;
    if (predicate === "treats" || predicate === "indicates") {
      if (!diagnoses.has(object)) continue;
      const targets = scoped.get(subject) ?? new Map<string, Status>();
      targets.set(object, status);
      scoped.set(subject, targets);
      const concept = conceptOf(subject);
      if (predicate === "treats" && concept) {
        if (plan) therapy.plannedTherapy = true;
        else if (concept.type === "chemical") therapy.systemicTherapy = true;
        else if (isLocalTherapy(concept, [concept.name]))
          therapy.localTherapy = true;
      }
      if (
        concept &&
        !found.some(
          (item) =>
            item.concept.id === subject &&
            (predicate !== "treats" || plan || item.received),
        )
      ) {
        const role = roleOf(concept, undefined);
        found.push({
          concept,
          role,
          weight: weights.roles[role] * factor(validAt, status),
          focus: validAt === focus.date,
          received: predicate === "treats" && !plan,
        });
      }
    }
    if (!plan) relations.set(tripleKey(link), factor(validAt, status));
  }

  // A diagnosis that a narrower one implies (castration-resistant: prostate cancer) is known too.
  const gate = new Map<string, number>();
  for (const [id, weight] of diagnoses) {
    const broader = broaderDiagnosis(id);
    // A stage such as CRPC also needs a diagnosis group, so a parent-heading-only paper
    // can contribute evidence after passing the SQL diagnosis gate.
    if (broader && !diagnoses.has(broader)) {
      const parent = conceptOf(broader);
      if (parent)
        found.push({
          concept: parent,
          role: "diagnosis",
          weight,
          focus: false,
        });
    }
    for (const one of [
      ...expand(id),
      ...(broader === undefined ? [] : expand(broader)),
    ])
      gate.set(one, Math.max(weight, gate.get(one) ?? 0));
  }
  // The aspects of a concept go to the patient's diagnosis when there is one disease: one
  // diagnosis, or several that name it at different specificity (lung cancer and adenocarcinoma
  // of the lung). Unrelated diagnoses, such as a cancer and anemia, need an explicit link.
  const named = [...diagnoses.keys()];
  const roots = named.filter(
    (id) =>
      !named.some(
        (other) => other !== id && conceptOf(other)?.narrower?.includes(id),
      ),
  );
  const family = roots.length === 1 ? named : [];
  const concepts = new ConceptSet(weights, excluded);
  for (const {
    concept,
    role,
    weight,
    focus: isFocus,
    received,
    status,
  } of found) {
    if (excluded.has(concept.id)) continue;
    if (role === "diagnosis" && unspecific.has(concept.id)) continue;
    if (
      role === "diagnosis" &&
      status === "suspected" &&
      !isProstateCancer(concept.id)
    ) {
      const qualifier = `${concept.id}Q000175`;
      concepts.byId.set(qualifier, {
        ids: [qualifier],
        diagnoses: expand(concept.id),
        name: `${concept.name} (diagnosis)`,
        role: "aspect",
        weight: weights.roles.test * weight,
        focus: isFocus,
      });
    }
    // An incidental mention cannot override the role and evidence of an actual diagnosis.
    if (role !== "stage" && role !== "diagnosis" && diagnoses.has(concept.id))
      continue;
    const links = scoped.get(concept.id);
    const targets = [...(links?.keys() ?? [])];
    const active = targets.filter((id) => links?.get(id) !== "planned");
    const planned = targets.filter((id) => links?.get(id) === "planned");
    const activeIds = new Set(active.flatMap(expand));
    const plannedFor = planned
      .flatMap(expand)
      .filter((id) => !activeIds.has(id));
    concepts.add(
      concept,
      role,
      weight,
      isFocus,
      targets.length
        ? {
            diagnoses: targets
              .flatMap(expand)
              .filter((id) => id !== histology?.conflicting),
            documentedTargets: { active, planned },
            ...(plannedFor.length && { plannedFor }),
          }
        : {},
      targets.length ? targets : family,
    );
    if (received && role === "drug")
      for (const id of [concept.id, ...(concept.also ?? [])])
        treatments.set(id, Math.max(weight, treatments.get(id) ?? 0));
  }
  for (const {
    ids: [id],
    role,
  } of concepts.byId.values()) {
    if (
      !scoped.has(id) &&
      (treatments.has(id) ||
        (diagnoses.size > 1 && (role === "test" || role === "finding")))
    )
      evidence.push({
        ref: focus.id,
        date: cutoff,
        concept: id,
        detail: treatments.has(id)
          ? "No active explicit treatment indication"
          : "No explicit link from finding to diagnosis",
      });
  }
  if (!gate.size)
    evidence.push({
      ref: focus.id,
      date: cutoff,
      detail: "No active patient diagnosis could be mapped",
    });
  therapy.diagnosticFocus = found.some(
    ({ role, focus: isFocus }) => role === "test" && isFocus,
  );
  therapy.psaWorkup =
    !therapy.diagnosed &&
    diagnoses.has("mesh:D011471") &&
    found.some(
      ({ concept, focus: isFocus }) => isFocus && concept.id === "ncbigene:354",
    );
  const sexes = new Set(
    [...diagnoses.keys()].flatMap((id) => conceptOf(id)?.sex ?? []),
  );
  const sex = sexes.size === 1 ? [...sexes][0] : undefined;

  const prostateContext = [...gate.keys()].some(isProstateCancer);
  return {
    cutoff,
    prostateContext,
    histology,
    evidence,
    diagnoses: gate,
    concepts: [...concepts.byId.values()],
    stage: patientStage(
      [...stageIds, ...treatments.keys()],
      stageTexts,
      therapy,
      prostateContext,
      observed,
    ),
    treatments,
    relations,
    ...(sex !== undefined && { sex }),
    conceptOnly: !fromGraph && !relations.size,
  };
}

export function patientQuery(
  state: JourneyState,
  weights: QueryWeights = DEFAULT_WEIGHTS,
  terminology: Terminology = defaultTerminology,
): GraphQuery {
  const reading = startReading(state, weights, terminology);
  if (state.graph) readGraph(state.graph, reading);
  else readTimeline(state.context, reading);
  return buildQuery(reading, state.graph !== undefined);
}
