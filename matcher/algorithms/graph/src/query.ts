import type { JourneyEvent, JourneyState } from "@matcher/core";
import timeline from "../data/timeline.json" with { type: "json" };
import { normalizePatientGraph } from "./patient.ts";
import {
  broaderDiagnosis,
  type Concept,
  conceptOf,
  findConcepts,
  findDiseases,
  icdCodesFor,
  resolveIcd,
} from "./resolve.ts";
import { type PatientStage, patientStage, STAGE_CONCEPTS } from "./stages.ts";
import { statusFromText } from "./status.ts";
import { normalizeName } from "./text.ts";
import type { EntityType, Status, Triple } from "./types.ts";

/** What a concept is for the patient; the matcher weighs each role on its own. */
export const ROLES = [
  "diagnosis",
  "stage",
  "drug",
  "procedure",
  "test",
  "gene",
  "finding",
  "symptom",
  "aspect",
] as const;
export type Role = (typeof ROLES)[number];

/** A patient concept the matcher looks for in papers. */
export interface QueryConcept {
  /** The IDs a paper may have for it: its own first, then other vocabularies (PSA: gene and MeSH). */
  ids: string[];
  name: string;
  role: Role;
  /** Role weight × certainty × focus; broader concepts and aspects get a share of it. */
  weight: number;
  /** A statement of the focus day. */
  focus: boolean;
}

export interface GraphQuery {
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

export function tripleKey({ subject, predicate, object }: Triple): string {
  return JSON.stringify([subject, predicate, object]);
}

const CERTAINTY: Record<Status, number> = {
  asserted: 1,
  unknown: 0.65,
  planned: 0.55,
  suspected: 0.45,
  negated: 0,
};

// Graphiti supplies day precision. On a tie prefer explicit evidence, with a veto for negation.
const STATUS_ORDER: Record<Status, number> = {
  unknown: 0,
  planned: 1,
  suspected: 2,
  asserted: 3,
  negated: 4,
};

const EXPLICIT_STATUSES: ReadonlySet<Status> = new Set([
  "asserted",
  "suspected",
  "negated",
]);

/** Roles whose statements are new measurements each time, such as a PSA value. */
const MEASUREMENTS: ReadonlySet<Role> = new Set(["test", "gene", "finding"]);

// MeSH qualifiers of a diagnosis that say what a paper does with it.
const DRUG_THERAPY = "Q000188";
const ADVERSE_EFFECTS = "Q000009";

type DatedStatus = { validAt?: string; invalidAt?: string; status: Status };

function latest<T extends DatedStatus>(
  statements: T[],
  keyOf: (statement: T) => string,
  cutoff: string,
): T[] {
  const byKey = new Map<string, T[]>();
  for (const statement of statements) {
    const { validAt, invalidAt } = statement;
    if (!validAt || validAt > cutoff || (invalidAt && invalidAt <= cutoff))
      continue;
    const key = keyOf(statement);
    const list = byKey.get(key) ?? [];
    list.push(statement);
    byKey.set(key, list);
  }
  const result: T[] = [];
  for (const list of byKey.values()) {
    list.sort(
      (a, b) =>
        (a.validAt ?? "").localeCompare(b.validAt ?? "") ||
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    );
    // An un-cued follow-up (`unknown`) advances the date without erasing an established status.
    let current = list[0];
    for (let i = 1; i < list.length; i++) {
      const next = list[i];
      current =
        next.status === "unknown" && EXPLICIT_STATUSES.has(current.status)
          ? { ...next, status: current.status }
          : next;
    }
    result.push(current);
  }
  return result;
}

function timelineConditions(events: JourneyEvent[]) {
  const diagnoses = new Map<string, { since: string; names: Set<string> }>();
  const notes: { date: string; text: string; diagnoses: Set<string> }[] = [];
  for (const event of events) {
    const type = normalizeName(event.type);
    if (type === "family history") continue;
    const diagnosis = event.parameters?.diagnosis;
    const code = event.parameters?.icd_code;
    const fields = typeof diagnosis === "string" ? [diagnosis] : [];
    if (["diagnosis", "pathology", "progression"].includes(type))
      fields.push(event.label);
    const hits = fields.flatMap(findDiseases);
    const byCode = resolveIcd(code);
    if (byCode?.type === "disease")
      hits.push({ concept: byCode, code: String(code) });
    const eventDiagnoses = new Set<string>();
    for (const { concept, code: matchedCode } of hits) {
      eventDiagnoses.add(concept.id);
      const known = diagnoses.get(concept.id) ?? {
        since: event.date,
        names: new Set([
          concept.name,
          ...concept.names,
          ...icdCodesFor(concept.id),
        ]),
      };
      if (event.date < known.since) known.since = event.date;
      if (matchedCode) known.names.add(matchedCode);
      diagnoses.set(concept.id, known);
    }
    const text =
      typeof diagnosis === "string"
        ? `${diagnosis}. ${event.label}`
        : event.label;
    notes.push({ date: event.date, text, diagnoses: eventDiagnoses });
  }
  // Same-day evidence is evaluated together, regardless of the order of the events.
  const statements: (DatedStatus & { entity: string })[] = [];
  for (const [entity, { since, names }] of diagnoses) {
    const aliases = [...names];
    for (const note of notes) {
      if (note.date < since) continue;
      const status = statusFromText(note.text, aliases)?.status;
      if (status || note.diagnoses.has(entity))
        statements.push({
          entity,
          validAt: note.date,
          status: status ?? "unknown",
        });
    }
  }
  return statements;
}

/** The text of an event that names concepts: its label and its text parameters. */
function eventText(event: JourneyEvent): string {
  const values = Object.values(event.parameters ?? {}).flatMap((value) =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [],
  );
  return [event.label, ...values].join(". ");
}

/** The role of a patient concept; `kind` and `conditionRole` come from the patient fact. */
function roleOf(
  concept: Pick<Concept, "id" | "type" | "diagnostic" | "role">,
  conditionRole: string | undefined,
): Role {
  if (STAGE_CONCEPTS.has(concept.id)) return "stage";
  if (
    concept.role !== undefined &&
    (ROLES as readonly string[]).includes(concept.role)
  )
    return concept.role as Role;
  const byType: Record<EntityType, Role> = {
    disease: conditionRole === "diagnosis" ? "diagnosis" : "symptom",
    chemical: "drug",
    gene: "gene",
    variant: "gene",
    procedure: concept.diagnostic ? "test" : "procedure",
    finding: "finding",
    device: "finding",
  };
  return byType[concept.type];
}

/** Collects weighted concepts; a concept found twice keeps its highest weight. */
class ConceptSet {
  readonly byId = new Map<string, QueryConcept>();
  private readonly weights: QueryWeights;
  private readonly diagnosisIds: Set<string>;

  constructor(weights: QueryWeights, diagnosisIds: Set<string>) {
    this.weights = weights;
    this.diagnosisIds = diagnosisIds;
  }

  add(concept: Concept, role: Role, weight: number, focus: boolean): void {
    // A paper on a narrower form (castration-resistant) is a paper on the diagnosis too.
    const ids = [
      concept.id,
      ...(concept.also ?? []),
      ...(role === "diagnosis" ? (concept.narrower ?? []) : []),
    ];
    this.put({ ids, name: concept.name, role, weight, focus });
    for (const id of concept.broader ?? []) {
      const broader = conceptOf(id);
      this.put({
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
      for (const diagnosis of this.diagnosisIds)
        aspect(`${diagnosis}${qualifier}`);
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

/** The IDs a paper may have for a diagnosis: the concept, its other IDs and narrower forms. */
function diagnosisIds(id: string): string[] {
  const concept = conceptOf(id);
  return [id, ...(concept?.also ?? []), ...(concept?.narrower ?? [])];
}

type Implied = { id: string; status: Status };
type ParameterRule = {
  concepts?: string[];
  values?: Record<string, string[]>;
  implies?: Record<string, string>;
  atLeast?: number;
  events?: string[];
};
const PLANS = new Set(timeline.plans.map(normalizeName));
const GIVES = new Set(timeline.gives.map(normalizeName));
const PARAMETERS: Record<string, ParameterRule> = timeline.parameters;

/** What the parameters of an event say: concepts, and diagnoses they assert or make suspected. */
function parameterFacts(event: JourneyEvent): {
  concepts: Concept[];
  implied: Implied[];
} {
  const concepts: Concept[] = [];
  const implied: Implied[] = [];
  const type = normalizeName(event.type);
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    const rule = PARAMETERS[key];
    if (rule === undefined || value === null || value === undefined) continue;
    if (rule.events && !rule.events.map(normalizeName).includes(type)) continue;
    if (rule.atLeast !== undefined && !(Number(value) >= rule.atLeast))
      continue;
    const ids = [
      ...(rule.concepts ?? []),
      ...(rule.values?.[String(value)] ?? []),
    ];
    for (const id of ids) {
      const concept = conceptOf(id);
      if (concept !== undefined) concepts.push(concept);
    }
    for (const [id, status] of Object.entries(rule.implies ?? {}))
      implied.push({ id, status: status as Status });
  }
  return { concepts, implied };
}

const LOCAL_THERAPY =
  /prostatektom|prostatectom|\brpe\b|\brarp\b|radiotherap|bestrahl|strahlenther|\bimrt\b|brachyther/;
const SYSTEMIC_THERAPY =
  /\badt\b|androgen|hormonther|hormone therap|leupro|gosere|degarel|relugol|bicalut|abirater|enzalut|apalut|darolut|docetax|cabazitax|olaparib|radium|chemother/;

export function patientQuery(
  { focus, context, graph }: JourneyState,
  weights: QueryWeights = DEFAULT_WEIGHTS,
): GraphQuery {
  const cutoff = graph?.as_of ?? focus.date;
  const factor = (date: string | undefined, status: Status) =>
    CERTAINTY[status] * (date === focus.date ? weights.focus : 1);
  // What the focus day is about: the news of the day (a one-time event such as a surgery is
  // news only on the day it first appears, later documents restate it), the current therapy
  // (the latest one started, also when restated), and partly the measurements of the day.
  const multiplier = (news: boolean, current: boolean, measurement: boolean) =>
    news || current
      ? weights.focus
      : measurement
        ? 1 + (weights.focus - 1) * weights.measurement
        : 1;
  const isTherapy = (role: Role) => role === "drug" || role === "procedure";
  const diagnoses = new Map<string, number>();
  const treatments = new Map<string, number>();
  const relations = new Map<string, number>();
  // For the disease state: concept IDs of the active statements, texts of all so far.
  const stageIds: string[] = [];
  const stageTexts: string[] = [];
  const therapy = {
    diagnosed: false,
    localTherapy: false,
    systemicTherapy: false,
    plannedTherapy: false,
    diagnosticFocus: false,
  };
  // Concepts come in two passes: the diagnoses first, so aspects know them.
  const found: {
    concept: Concept;
    role: Role;
    weight: number;
    focus: boolean;
  }[] = [];

  if (!graph) {
    const events = [...context, focus];
    const conditions = timelineConditions(events);
    for (const fact of latest(conditions, (fact) => fact.entity, cutoff)) {
      if (fact.status === "negated") continue;
      const concept = conceptOf(fact.entity);
      if (concept === undefined) continue;
      const role = roleOf(concept, "diagnosis");
      const weight = weights.roles[role] * factor(fact.validAt, fact.status);
      if (role === "diagnosis" || broaderDiagnosis(concept.id) !== undefined)
        diagnoses.set(concept.id, weight);
      if (fact.status === "asserted") therapy.diagnosed = true;
      found.push({ concept, role, weight, focus: fact.validAt === focus.date });
      stageIds.push(concept.id);
    }
    // Per event: the concepts its texts name and its parameters give, whether it plans or gives
    // the therapies among them, and the diagnoses it implies.
    const read = events.map((event) => {
      const type = normalizeName(event.type);
      const parameters = parameterFacts(event);
      const concepts = [
        ...new Set([...findConcepts(eventText(event)), ...parameters.concepts]),
      ].filter((concept) => !diagnoses.has(concept.id));
      const plans = PLANS.has(type);
      const implied = [...parameters.implied];
      for (const concept of concepts)
        if (concept.implies !== undefined && !plans)
          implied.push({ id: concept.implies, status: "asserted" });
      if (
        plans &&
        concepts.some((concept) => isTherapy(roleOf(concept, undefined)))
      )
        implied.push({ id: "mesh:D011471", status: "asserted" });
      return { event, type, concepts, plans, gives: GIVES.has(type), implied };
    });
    // A journey that names no diagnosis implies one: a Gleason grade, a prostatectomy or a
    // decision on a prostate cancer therapy asserts it, an elevated PSA or PI-RADS makes it
    // suspected (data/timeline.json, concepts.json `implies`).
    const inferred = new Map<string, Status>();
    for (const { implied } of read)
      for (const { id, status } of implied)
        if (!diagnoses.has(id) && inferred.get(id) !== "asserted")
          inferred.set(id, status);
    for (const [id, status] of inferred) {
      const concept = conceptOf(id);
      if (concept === undefined) continue;
      const weight = weights.roles.diagnosis * CERTAINTY[status];
      diagnoses.set(id, weight);
      if (status === "asserted") therapy.diagnosed = true;
      found.push({ concept, role: "diagnosis", weight, focus: false });
      stageIds.push(id);
    }
    // The current therapy: the therapies of the latest event that gives one, or of the focus
    // event when it decides them.
    const isGiven = (index: number) =>
      read[index].gives ||
      (!read[index].plans && read[index].type !== "tumor board");
    const lastTherapy = read.findLastIndex(
      ({ concepts }, index) =>
        (isGiven(index) || index === read.length - 1) &&
        concepts.some((concept) => isTherapy(roleOf(concept, undefined))),
    );
    read.forEach(({ event, concepts, plans }, index) => {
      const text = normalizeName(eventText(event));
      stageTexts.push(text);
      const therapies = concepts.filter((concept) =>
        isTherapy(roleOf(concept, undefined)),
      );
      if (plans && therapies.length > 0) therapy.plannedTherapy = true;
      if (!plans && isGiven(index)) {
        if (
          therapies.some(
            (concept) =>
              roleOf(concept, undefined) === "procedure" &&
              concept.id !== "mesh:D057832",
          )
        )
          therapy.localTherapy = true;
        if (therapies.some((concept) => roleOf(concept, undefined) === "drug"))
          therapy.systemicTherapy = true;
      }
      const news = event === focus;
      for (const concept of concepts) {
        const role = roleOf(concept, undefined);
        const current = index === lastTherapy && isTherapy(role);
        const status: Status = plans && isTherapy(role) ? "planned" : "unknown";
        if (role === "drug") treatments.set(concept.id, weights.roles.drug);
        found.push({
          concept,
          role,
          weight:
            weights.roles[role] *
            CERTAINTY[status] *
            multiplier(news, current, false),
          focus: news || current,
        });
        if (status !== "planned") stageIds.push(concept.id);
      }
    });
  } else {
    // Future-only nodes must not contribute aliases or labels to a historical snapshot.
    const edges = graph.edges.filter(
      (edge) => edge.valid_at && edge.valid_at.slice(0, 10) <= cutoff,
    );
    const ends = new Set(
      edges.flatMap((edge) => [edge.source_node_uuid, edge.target_node_uuid]),
    );
    const normalized = normalizePatientGraph({
      nodes: graph.nodes.filter((node) => ends.has(node.uuid)),
      edges,
    });
    const entities = new Map(
      normalized.entities.map((entity) => [entity.key, entity]),
    );
    // Since when an entity holds without a break: its earliest statement that is still valid at
    // the cutoff. Graphiti ends the earlier ones when something changes (a drug stopped, then
    // started again), so this is the start of the current episode.
    const firstSeen = new Map<string, string>();
    for (const fact of normalized.facts) {
      if (fact.validAt === undefined || fact.validAt > cutoff) continue;
      if (fact.invalidAt !== undefined && fact.invalidAt <= cutoff) continue;
      const known = firstSeen.get(fact.entity);
      if (known === undefined || fact.validAt < known)
        firstSeen.set(fact.entity, fact.validAt);
    }
    const items: {
      fact: (typeof normalized.facts)[number];
      concept: Concept;
      role: Role;
    }[] = [];
    for (const fact of latest(
      normalized.facts,
      (f) => `${f.conditionRole ?? f.kind}:${f.entity}`,
      cutoff,
    )) {
      const entity = entities.get(fact.entity);
      if (entity === undefined || fact.status === "negated") continue;
      const names = entity.names.map(normalizeName);
      if (entity.id !== null) stageIds.push(entity.id);
      stageTexts.push(...names);
      if (fact.kind === "receives" && fact.status !== "planned") {
        if (names.some((name) => LOCAL_THERAPY.test(name)))
          therapy.localTherapy = true;
        if (names.some((name) => SYSTEMIC_THERAPY.test(name)))
          therapy.systemicTherapy = true;
      }
      if (
        fact.kind === "receives" &&
        fact.status === "planned" &&
        names.some(
          (name) => LOCAL_THERAPY.test(name) || SYSTEMIC_THERAPY.test(name),
        )
      )
        therapy.plannedTherapy = true;
      // An unresolved entity counts with the curated concepts its names contain, such as
      // radiotherapy in "Strahlentherapie der Prostataloge".
      const known = entity.id === null ? undefined : conceptOf(entity.id);
      const concepts =
        known !== undefined
          ? [known]
          : entity.id === null
            ? findConcepts(entity.names.join(". "))
            : [];
      for (const concept of concepts) {
        const role = roleOf(
          concept,
          known !== undefined ? fact.conditionRole : undefined,
        );
        items.push({ fact, concept, role });
      }
    }
    // The current therapy: the therapies that started last, whatever edge states them (a
    // radiotherapy can come as RELATES_TO). A plan counts once it is news: decided that day.
    const begins = (fact: (typeof items)[number]["fact"]) =>
      fact.status !== "planned" || firstSeen.get(fact.entity) === focus.date;
    const started = items
      .filter(({ fact, role }) => isTherapy(role) && begins(fact))
      .map(({ fact }) => firstSeen.get(fact.entity) ?? "");
    // ISO dates sort as text.
    const latestStart = started.sort().at(-1) ?? "";
    for (const { fact, concept, role } of items) {
      {
        const onFocusDay = fact.validAt === focus.date;
        const news = onFocusDay && firstSeen.get(fact.entity) === focus.date;
        const current =
          isTherapy(role) &&
          begins(fact) &&
          latestStart !== "" &&
          firstSeen.get(fact.entity) === latestStart;
        const measurement = onFocusDay && MEASUREMENTS.has(role);
        const weight =
          weights.roles[role] *
          CERTAINTY[fact.status] *
          multiplier(news, current, measurement);
        const narrower =
          fact.conditionRole === "diagnosis" &&
          broaderDiagnosis(concept.id) !== undefined;
        if (role === "diagnosis" || narrower) {
          diagnoses.set(
            concept.id,
            Math.max(weight, diagnoses.get(concept.id) ?? 0),
          );
          if (fact.status === "asserted") therapy.diagnosed = true;
        }
        if (role === "drug") treatments.set(concept.id, weight);
        found.push({
          concept,
          role,
          weight,
          focus: news || current || measurement,
        });
        // A plan is no evidence of the state it would imply (radium-223: castration-resistant).
        if (fact.status !== "planned") stageIds.push(concept.id);
      }
    }
    for (const statement of [...normalized.facts, ...normalized.relations]) {
      if (
        weights.sentences &&
        statement.text &&
        statement.status !== "negated" &&
        statement.validAt !== undefined &&
        statement.validAt <= cutoff
      )
        stageTexts.push(normalizeName(statement.text));
    }
    for (const relation of latest(normalized.relations, tripleKey, cutoff)) {
      // An unspecified relationship on both sides is no evidence that their meanings agree.
      if (
        relation.predicate === "related" ||
        !entities.get(relation.subject)?.id ||
        !entities.get(relation.object)?.id
      )
        continue;
      relations.set(
        tripleKey(relation),
        factor(relation.validAt, relation.status),
      );
    }
  }

  // A diagnosis that a narrower one implies (castration-resistant: prostate cancer) is known too.
  const gate = new Map<string, number>();
  for (const [id, weight] of diagnoses) {
    const broader = broaderDiagnosis(id);
    for (const one of [
      ...diagnosisIds(id),
      ...(broader === undefined ? [] : diagnosisIds(broader)),
    ])
      gate.set(one, Math.max(weight, gate.get(one) ?? 0));
  }
  const concepts = new ConceptSet(weights, new Set(diagnoses.keys()));
  for (const { concept, role, weight, focus: isFocus } of found)
    concepts.add(concept, role, weight, isFocus);
  if (therapy.localTherapy || therapy.systemicTherapy) therapy.diagnosed = true;
  therapy.diagnosticFocus = found.some(
    ({ role, focus: isFocus }) => role === "test" && isFocus,
  );
  const sex = [...diagnoses.keys()]
    .map((id) => conceptOf(id)?.sex)
    .find((one) => one !== undefined);

  return {
    cutoff,
    diagnoses: gate,
    concepts: [...concepts.byId.values()],
    stage: patientStage(stageIds, stageTexts, therapy),
    treatments,
    relations,
    ...(sex !== undefined && { sex }),
    conceptOnly: graph === undefined,
  };
}
