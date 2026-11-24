import type { JourneyEvent, JourneyState } from "@matcher/core";
import timeline from "../data/timeline.json" with { type: "json" };
import { normalizePatientGraph, parseDay } from "./patient.ts";
import {
  broaderDiagnosis,
  type Concept,
  conceptOf,
  defaultTerminology,
  icdCodesFor,
  resolveIcd,
  type Terminology,
} from "./resolve.ts";
import { type PatientStage, patientStage, STAGE_CONCEPTS } from "./stages.ts";
import {
  patientText,
  statusFromAttribute,
  statusFromText,
  treatmentStatus,
} from "./status.ts";
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
  /** Explicitly linked patient diagnoses for this finding or intervention. */
  diagnoses?: string[];
  /** These targets have only a plan, without an active treatment relationship. */
  plannedFor?: string[];
  name: string;
  role: Role;
  /** Role weight × certainty × focus; broader concepts and aspects get a share of it. */
  weight: number;
  /** A statement of the focus day. */
  focus: boolean;
}

type ClinicalEvidence = {
  ref: string;
  date: string;
  detail: string;
  concept?: string;
  diagnosis?: string;
  status?: Status;
};

export interface GraphQuery {
  prostateContext: boolean;
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

type DatedStatus = {
  validAt?: string;
  invalidAt?: string;
  status: Status;
  text?: string;
};

function latest<T extends DatedStatus>(
  statements: T[],
  keyOf: (statement: T) => string,
  cutoff: string,
  stageTexts?: string[],
): (T & { validAt: string })[] {
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
  const result: (T & { validAt: string })[] = [];
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
    // Several still-valid statements for the same entity can describe different aspects
    // of its stage. Ignore them all when the latest status rules out that entity.
    if (
      stageTexts &&
      (current.status === "asserted" || current.status === "unknown")
    ) {
      for (const item of list) {
        if (
          item.text &&
          (item.status === "asserted" || item.status === "unknown")
        )
          stageTexts.push(normalizeName(item.text));
      }
    }
    if (current.validAt) result.push({ ...current, validAt: current.validAt });
  }
  return result;
}

function timelineConditions(
  events: JourneyEvent[],
  terminology: Terminology,
  evidence: ClinicalEvidence[],
) {
  const diagnoses = new Map<string, { since: string; names: Set<string> }>();
  const notes: { event: JourneyEvent; text: string; diagnoses: Set<string> }[] =
    [];
  for (const event of events) {
    const type = normalizeName(event.type);
    const diagnosis = event.parameters?.diagnosis;
    const code = event.parameters?.icd_code;
    const fields = typeof diagnosis === "string" ? [diagnosis] : [];
    const indication = event.parameters?.indication;
    if (
      typeof indication === "string" &&
      (GIVES.has(type) || treatmentStatus(event.label) === "asserted") &&
      !["planned", "negated", "unknown"].includes(
        treatmentStatus(event.label) ?? "",
      )
    ) {
      const indicated = terminology.findDiseases(indication);
      if (
        indicated.length &&
        !indicated.some((hit) => diagnoses.has(hit.concept.id))
      )
        fields.push(indication);
    }
    if (
      !fields.length &&
      !resolveIcd(code) &&
      ["diagnosis", "pathology", "progression"].includes(type)
    )
      fields.push(event.label);
    // An explicit exclusion also counts on a follow-up that never introduced a diagnosis.
    const excluded = terminology
      .findDiseases(event.label)
      .filter(
        ({ concept, code }) =>
          statusFromText(event.label, [
            concept.name,
            ...concept.names,
            ...(code ? [code] : []),
          ])?.status === "negated",
      );
    const hits = [
      ...fields.flatMap((field) => terminology.findDiseases(field)),
      ...excluded,
    ];
    const byCode = resolveIcd(code);
    if (byCode?.type === "disease") {
      if (
        typeof diagnosis === "string" &&
        terminology
          .findDiseases(diagnosis)
          .some(
            (hit) =>
              hit.concept.id !== byCode.id &&
              !byCode.narrower?.includes(hit.concept.id),
          )
      ) {
        evidence.push({
          ref: event.id,
          date: event.date,
          detail: "Diagnostic name and ICD code disagree",
        });
        continue;
      }
      hits.push({ concept: byCode, code: String(code) });
    }
    if (!hits.length && (fields.length || code))
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: "No unambiguous mapped diagnosis in diagnostic field",
      });
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
    notes.push({ event, text, diagnoses: eventDiagnoses });
  }
  // Same-day evidence is evaluated together, regardless of the order of the events.
  const statements: (DatedStatus & { entity: string; ref: string })[] = [];
  for (const [entity, { since, names }] of diagnoses) {
    const aliases = [...names];
    for (const note of notes) {
      if (note.event.date < since) continue;
      const status =
        statusFromText(note.text, aliases)?.status ??
        (note.diagnoses.has(entity)
          ? statusFromAttribute(note.event.parameters?.diagnosis_status)
          : undefined);
      if (status || note.diagnoses.has(entity))
        statements.push({
          entity,
          validAt: note.event.date,
          ref: note.event.id,
          text: [
            note.text,
            note.event.parameters?.icd_code,
            note.event.parameters?.indication,
          ]
            .filter(Boolean)
            .join(" "),
          status: status ?? "unknown",
        });
    }
  }
  return statements;
}

/** The text of an event that names concepts: its label and its text parameters. */
function eventText(event: JourneyEvent): string {
  const {
    participants: _departments,
    family_history: _relatives,
    ...parameters
  } = event.parameters ?? {};
  const values = Object.values(parameters).flatMap((value) =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [],
  );
  return [event.label, ...values].join(". ");
}

const isTherapy = (role: Role) => role === "drug" || role === "procedure";

type ClinicalLink = Triple & DatedStatus & { ref: string; validAt: string };

/** Only explicitly paired fields describe what the intervention or finding refers to. */
function* timelineRelations(
  event: JourneyEvent,
  text: string,
  plans: boolean,
  gives: boolean,
  course: Status | undefined,
  terminology: Terminology,
  evidence: ClinicalEvidence[],
): Generator<ClinicalLink> {
  for (const [field, predicate, keys] of [
    ["indication", "treats", ["drug", "medication", "procedure"]],
    ["indicates", "indicates", ["finding", "test"]],
  ] as const) {
    const target = event.parameters?.[field];
    if (typeof target !== "string") continue;
    const targets = [
      ...new Set(terminology.findDiseases(target).map((hit) => hit.concept.id)),
    ];
    if (targets.length !== 1) {
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: `No single mapped diagnosis for ${field}`,
      });
      continue;
    }
    let resolved = false;
    for (const key of keys) {
      const value = event.parameters?.[key];
      if (typeof value !== "string") continue;
      for (const subject of terminology.findConcepts(value)) {
        const role = roleOf(subject, undefined);
        if (predicate === "treats" ? !isTherapy(role) : isTherapy(role))
          continue;
        const status =
          statusFromText(text, [subject.name, ...subject.names])?.status ??
          course ??
          (plans ? "planned" : "asserted");
        if (predicate === "treats" && !plans && !gives && status !== "negated")
          continue;
        resolved = true;
        yield {
          subject: subject.id,
          predicate,
          object: targets[0],
          ref: event.id,
          validAt: event.date,
          status,
        };
      }
    }
    if (!resolved)
      evidence.push({
        ref: event.id,
        date: event.date,
        diagnosis: targets[0],
        detail:
          predicate === "treats"
            ? "Indication lacks a mapped, dated intervention"
            : "Diagnosis lacks a mapped finding",
      });
  }
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

/** An organ neoplasm can be a diagnosis or a site of spread. The shared MeSH ID alone cannot tell them apart. */
function diagnosisRole(concept: Concept, text: string): Role {
  const role = roleOf(concept, "diagnosis");
  if (
    role === "stage" &&
    concept.name.endsWith(" Neoplasms") &&
    !/metasta|secondary|sekund[aä]r|\bc7[789]\b/i.test(text)
  )
    return "diagnosis";
  return role;
}

/** Collects weighted concepts; a concept found twice keeps its highest weight. */
class ConceptSet {
  readonly byId = new Map<string, QueryConcept>();
  private readonly weights: QueryWeights;

  constructor(weights: QueryWeights) {
    this.weights = weights;
  }

  add(
    concept: Concept,
    role: Role,
    weight: number,
    focus: boolean,
    diagnoses: string[],
    aspects: string[],
    plannedFor: string[],
  ): void {
    // A paper on a narrower form (castration-resistant) is a paper on the diagnosis too.
    const ids = [
      concept.id,
      ...(concept.also ?? []),
      ...(role === "diagnosis" ? (concept.narrower ?? []) : []),
    ];
    const scope = {
      ...(diagnoses.length && { diagnoses }),
      ...(plannedFor.length && { plannedFor }),
    };
    this.put({ ids, name: concept.name, role, weight, focus, ...scope });
    for (const id of concept.broader ?? []) {
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
  // A measured PSA is a search concept even below the diagnostic threshold. The
  // synthetic journeys also copy PSA onto unrelated events, such as admissions.
  const psa = event.parameters?.psa_value;
  if (
    (type === "lab test" || type === "followup") &&
    typeof psa === "number" &&
    Number.isFinite(psa) &&
    psa >= 0
  ) {
    const marker = conceptOf("ncbigene:354");
    if (marker) concepts.push(marker);
  }
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    const rule = PARAMETERS[key];
    if (rule === undefined || value === null || value === undefined) continue;
    if (rule.events && !rule.events.map(normalizeName).includes(type)) continue;
    if (
      rule.atLeast !== undefined &&
      ((typeof value !== "number" && typeof value !== "string") ||
        !Number.isFinite(Number(value)) ||
        Number(value) < rule.atLeast)
    )
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
  terminology: Terminology = defaultTerminology,
): GraphQuery {
  const cutoff = graph?.as_of ?? focus.date;
  const evidence: ClinicalEvidence[] = [];
  const links: ClinicalLink[] = [];
  const scoped = new Map<string, Map<string, Status>>();
  const conceptOf = (id: string) => terminology.conceptOf(id);
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
  const diagnoses = new Map<string, number>();
  const treatments = new Map<string, number>();
  const relations = new Map<string, number>();
  // For the disease state: concept IDs of the active statements, texts of all so far.
  const stageIds: string[] = [];
  const stageTexts: string[] = [];
  const therapy = {
    diagnosed: false,
    localTherapy: false,
    prostatectomy: false,
    psaWorkup: false,
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
    received?: boolean;
    status?: Status;
  }[] = [];

  if (!graph) {
    const events = [...context, focus]
      .flatMap((event) => {
        if (event.date > cutoff) return [];
        const label = patientText(event.label);
        const familyEvent = normalizeName(event.type) === "family history";
        if (
          !familyEvent &&
          label === event.label &&
          eventText(event) === patientText(eventText(event))
        )
          return [event];
        evidence.push({
          ref: event.id,
          date: event.date,
          detail: "Family history excluded",
        });
        if (familyEvent || !label) return [];
        // For a mixed label, only its patient clause can attribute the diagnosis.
        const parameters = Object.fromEntries(
          Object.entries(event.parameters ?? {}).filter(
            ([key, value]) =>
              (label === event.label ||
                !["diagnosis", "icd_code"].includes(key)) &&
              (typeof value !== "string" || patientText(value) === value),
          ),
        );
        return [{ ...event, label, parameters }];
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    const excluded = new Set<string>();
    const conditions = timelineConditions(events, terminology, evidence);
    for (const fact of latest(conditions, (fact) => fact.entity, cutoff)) {
      evidence.push({
        ref: fact.ref,
        date: fact.validAt,
        diagnosis: fact.entity,
        status: fact.status,
        detail: "Dated diagnostic statement",
      });
      if (fact.status === "negated" || fact.status === "planned") {
        excluded.add(fact.entity);
        continue;
      }
      const concept = conceptOf(fact.entity);
      if (concept === undefined) continue;
      const role = diagnosisRole(concept, fact.text ?? "");
      const weight = weights.roles[role] * factor(fact.validAt, fact.status);
      if (role === "diagnosis" || broaderDiagnosis(concept.id) !== undefined)
        diagnoses.set(concept.id, weight);
      if (fact.status === "asserted" && diagnoses.has(concept.id))
        therapy.diagnosed = true;
      found.push({
        concept,
        role,
        weight,
        focus: fact.validAt === focus.date,
        status: fact.status,
      });
      if (
        fact.status !== "suspected" &&
        !(role === "diagnosis" && STAGE_CONCEPTS.has(concept.id))
      )
        stageIds.push(concept.id);
    }
    // Per event: the concepts its texts name and its parameters give, whether it plans or gives
    // the therapies among them, and the diagnoses it implies.
    const read = events.map((event) => {
      const type = normalizeName(event.type);
      const parameters = parameterFacts(event);
      const text = eventText(event);
      const course =
        treatmentStatus(event.label) ??
        statusFromAttribute(event.parameters?.treatment_status);
      const concepts = [
        ...new Set([...terminology.findConcepts(text), ...parameters.concepts]),
      ].filter(
        (concept) =>
          !diagnoses.has(concept.id) &&
          !excluded.has(concept.id) &&
          !(course === "negated" && isTherapy(roleOf(concept, undefined))) &&
          statusFromText(text, [concept.name, ...concept.names])?.status !==
            "negated",
      );
      const plans = course === "planned" || PLANS.has(type);
      const gives =
        !plans &&
        course !== "negated" &&
        course !== "unknown" &&
        (GIVES.has(type) || course === "asserted");
      const implied = [...parameters.implied];
      for (const concept of concepts)
        if (
          concept.implies !== undefined &&
          gives &&
          (concept.id !== "mesh:D011468" ||
            /\bradical|\bradikal|\brpe\b|\brarp\b|\bralp\b/.test(
              normalizeName(text),
            ))
        )
          implied.push({ id: concept.implies, status: "asserted" });
      const prostateWorkup =
        parameters.implied.length > 0 ||
        concepts.some((c) => c.id === "mesh:D011468" && gives);
      return {
        event,
        text,
        concepts,
        plans,
        gives,
        implied,
        course,
        prostateWorkup,
      };
    });
    // A journey that names no diagnosis implies one: a Gleason grade, a prostatectomy or a
    // disease-specific treatment supports it, an elevated PSA or PI-RADS makes it
    // suspected (data/timeline.json, concepts.json `implies`).
    const prostateWorkup = read.some((event) => event.prostateWorkup);
    const inferred = new Map<string, Status>();
    for (const { implied, event } of read)
      for (const { id, status } of implied)
        if (
          !excluded.has(id) &&
          diagnoses.size === 0 &&
          prostateWorkup &&
          inferred.get(id) !== "asserted"
        ) {
          inferred.set(id, status);
          evidence.push({
            ref: event.id,
            date: event.date,
            diagnosis: id,
            status,
            detail: "Inferred from a prostate workup",
          });
        }
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
    const lastTherapy = read.findLastIndex(
      ({ concepts, gives, plans, event }) =>
        (gives || (plans && event.id === focus.id)) &&
        concepts.some((concept) => isTherapy(roleOf(concept, undefined))),
    );
    read.forEach(({ event, text, concepts, plans, gives, course }, index) => {
      for (const relation of timelineRelations(
        event,
        text,
        plans,
        gives,
        course,
        terminology,
        evidence,
      ))
        links.push(relation);
      if (!plans)
        stageTexts.push(...text.split(/[.;!?](?:\s|$)/).map(normalizeName));
      const therapies = concepts.filter((concept) =>
        isTherapy(roleOf(concept, undefined)),
      );
      if (plans && therapies.length > 0) therapy.plannedTherapy = true;
      if (gives) {
        if (
          therapies.some((concept) =>
            LOCAL_THERAPY.test(normalizeName(concept.name)),
          )
        )
          therapy.localTherapy = true;
        if (
          normalizeName(event.type) === "surgery" &&
          therapies.some(
            (concept) =>
              concept.id === "mesh:D011468" &&
              statusFromText(text, [concept.name, ...concept.names])?.status !==
                "suspected",
          )
        )
          therapy.prostatectomy = true;
        if (therapies.some((concept) => roleOf(concept, undefined) === "drug"))
          therapy.systemicTherapy = true;
      }
      const news = event.id === focus.id;
      for (const concept of concepts) {
        const role = roleOf(concept, undefined);
        const current = index === lastTherapy && isTherapy(role);
        const status: Status = plans && isTherapy(role) ? "planned" : "unknown";
        found.push({
          concept,
          role,
          weight:
            weights.roles[role] *
            CERTAINTY[status] *
            multiplier(news, current, false),
          focus: news || current,
          received: gives && isTherapy(role),
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
    const activeNodes = graph.nodes
      .filter((node) => ends.has(node.uuid))
      .map((node) => {
        const attributes = node.attributes as
          | { icd_code?: unknown; date_confirmed?: unknown }
          | undefined;
        const confirmed = parseDay(attributes?.date_confirmed);
        if (!attributes?.icd_code || !confirmed || confirmed <= cutoff)
          return node;
        // Graphiti may attach the final diagnosis code to a node that already existed at referral.
        return { ...node, attributes: { ...attributes, icd_code: undefined } };
      });
    const secondarySites = new Set(
      activeNodes
        .filter((node) =>
          /^C7[789]\b/i.test(
            String(
              (node.attributes as { icd_code?: unknown } | undefined)
                ?.icd_code ?? "",
            ),
          ),
        )
        .map((node) => node.uuid),
    );
    const normalized = normalizePatientGraph(
      {
        nodes: activeNodes,
        edges,
      },
      { dictionaries: terminology.dictionaries },
    );
    const familyRefs = new Set(
      normalized.skipped
        .filter((s) => s.reason === "family history")
        .map((s) => s.ref),
    );
    for (const edge of edges) {
      if (edge.valid_at && familyRefs.has(edge.uuid))
        evidence.push({
          ref: edge.uuid,
          date: edge.valid_at.slice(0, 10),
          detail: "Family history excluded",
        });
    }
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
    const sentences = weights.sentences ? stageTexts : undefined;
    const activeFacts = latest(
      normalized.facts,
      (fact) => `${fact.conditionRole ?? fact.kind}:${fact.entity}`,
      cutoff,
      sentences,
    );
    const activeRelations = latest(
      normalized.relations,
      tripleKey,
      cutoff,
      sentences,
    );
    for (const fact of activeFacts) {
      const entity = entities.get(fact.entity);
      if (fact.conditionRole === "diagnosis")
        evidence.push({
          ref: fact.origin.ref,
          date: fact.validAt,
          diagnosis: entity?.id ?? undefined,
          status: fact.status,
          detail: entity?.id
            ? "Dated diagnostic statement"
            : "No unambiguous mapped diagnosis for node",
        });
      if (
        entity === undefined ||
        fact.status === "negated" ||
        (fact.conditionRole === "diagnosis" && fact.status === "planned")
      )
        continue;
      const names = entity.names.map(normalizeName);
      if (fact.status !== "planned" && fact.status !== "suspected")
        stageTexts.push(...names);
      if (
        fact.kind === "receives" &&
        (fact.status === "asserted" || fact.status === "unknown")
      ) {
        if (names.some((name) => LOCAL_THERAPY.test(name)))
          therapy.localTherapy = true;
        if (entity.id === "mesh:D011468") therapy.prostatectomy = true;
        if (
          entity.type === "chemical" ||
          names.some((name) => SYSTEMIC_THERAPY.test(name))
        )
          therapy.systemicTherapy = true;
      }
      if (
        fact.kind === "receives" &&
        fact.status === "planned" &&
        (entity.type === "chemical" || entity.type === "procedure")
      )
        therapy.plannedTherapy = true;
      // An unresolved entity counts with the curated concepts its names contain, such as
      // radiotherapy in "Strahlentherapie der Prostataloge".
      const known = entity.id === null ? undefined : conceptOf(entity.id);
      const concepts = known
        ? [known]
        : fact.conditionRole === "diagnosis"
          ? []
          : terminology.findConcepts(entity.names.join(". "));
      for (const concept of concepts) {
        const role =
          fact.conditionRole === "allergy"
            ? "finding"
            : known &&
                fact.conditionRole === "diagnosis" &&
                !entity.sources.some((id) => secondarySites.has(id))
              ? diagnosisRole(
                  concept,
                  [...entity.names, fact.text ?? ""].join(" "),
                )
              : roleOf(concept, fact.conditionRole);
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
      found.push({
        concept,
        role,
        weight,
        focus: news || current || measurement,
        status: fact.status,
        received:
          fact.kind === "receives" &&
          fact.status !== "planned" &&
          fact.status !== "suspected",
      });
      // A plan is no evidence of the state it would imply (radium-223: castration-resistant).
      if (
        fact.status !== "planned" &&
        fact.status !== "suspected" &&
        !(role === "diagnosis" && STAGE_CONCEPTS.has(concept.id))
      )
        stageIds.push(concept.id);
    }
    // At referral the only diagnosis evidence may be a test that indicates a diagnosis.
    // A later exclusion by the patient or pathology must still veto this weaker inference.
    for (const relation of activeRelations) {
      if (
        diagnoses.has(relation.object) ||
        relation.predicate !== "indicates" ||
        relation.status === "negated" ||
        relation.status === "planned"
      )
        continue;
      const source = entities.get(relation.subject);
      const finding = conceptOf(relation.subject);
      const measured = finding && MEASUREMENTS.has(roleOf(finding, undefined));
      if (
        !measured &&
        !source?.labels.some((label) =>
          [
            "LabTest",
            "TumorMarker",
            "ImagingResult",
            "PathologyResult",
          ].includes(label),
        )
      )
        continue;
      const target = entities.get(relation.object);
      const concept = conceptOf(relation.object);
      if (
        activeFacts.some(
          (fact) =>
            fact.status === "negated" &&
            ((fact.entity === relation.object &&
              fact.conditionRole === "diagnosis") ||
              (fact.entity === relation.subject &&
                fact.kind === "has_finding")),
        ) ||
        !target?.labels.includes("Diagnosis") ||
        concept?.type !== "disease" ||
        roleOf(concept, "diagnosis") !== "diagnosis"
      )
        continue;
      const weight =
        weights.roles.diagnosis * factor(relation.validAt, "suspected");
      diagnoses.set(
        concept.id,
        Math.max(weight, diagnoses.get(concept.id) ?? 0),
      );
      found.push({
        concept,
        role: "diagnosis",
        weight,
        status: "suspected",
        focus: relation.validAt === focus.date,
      });
      if (measured) {
        const role = roleOf(finding, undefined);
        found.push({
          concept: finding,
          role,
          weight: weights.roles[role] * factor(relation.validAt, "unknown"),
          focus: relation.validAt === focus.date,
        });
      }
    }
    for (const relation of activeRelations) {
      // An unspecified relationship on both sides is no evidence that their meanings agree.
      if (relation.predicate === "related") continue;
      if (
        !entities.get(relation.subject)?.id ||
        !entities.get(relation.object)?.id
      ) {
        evidence.push({
          ref: relation.origin.ref,
          date: relation.validAt,
          detail: `Missing mapped endpoint for ${relation.predicate}`,
        });
        continue;
      }
      const subject = conceptOf(relation.subject);
      const incompatible =
        relation.predicate === "treats" &&
        (!subject || !isTherapy(roleOf(subject, undefined)));
      if (incompatible) continue;
      const blocked = activeFacts.some(
        (fact) =>
          fact.entity === relation.subject &&
          (fact.kind === "receives" || fact.kind === "has_finding") &&
          fact.status === "negated",
      );
      links.push({
        ...relation,
        validAt: relation.validAt,
        ref: relation.origin.ref,
        status: blocked ? "negated" : relation.status,
      });
    }
  }

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
      if (plan) therapy.plannedTherapy = true;
      const concept = conceptOf(subject);
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
      ...diagnosisIds(id),
      ...(broader === undefined ? [] : diagnosisIds(broader)),
    ])
      gate.set(one, Math.max(weight, gate.get(one) ?? 0));
  }
  const concepts = new ConceptSet(weights);
  for (const {
    concept,
    role,
    weight,
    focus: isFocus,
    received,
    status,
  } of found) {
    if (
      role === "diagnosis" &&
      status === "suspected" &&
      concept.id !== "mesh:D011471" &&
      broaderDiagnosis(concept.id) !== "mesh:D011471"
    ) {
      const qualifier = `${concept.id}Q000175`;
      concepts.byId.set(qualifier, {
        ids: [qualifier],
        diagnoses: diagnosisIds(concept.id),
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
    const activeIds = targets
      .filter((id) => links?.get(id) !== "planned")
      .flatMap(diagnosisIds);
    const plannedFor = targets
      .filter((id) => links?.get(id) === "planned")
      .flatMap(diagnosisIds)
      .filter((id) => !activeIds.includes(id));
    concepts.add(
      concept,
      role,
      weight,
      isFocus,
      targets.flatMap(diagnosisIds),
      targets.length || diagnoses.size !== 1 ? targets : [...diagnoses.keys()],
      plannedFor,
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
  const sexes = new Set([...diagnoses.keys()].map((id) => conceptOf(id)?.sex));
  const sex = sexes.size === 1 ? [...sexes][0] : undefined;

  const prostateContext =
    gate.has("mesh:D011471") &&
    [...diagnoses.keys()].every(
      (id) => id === "mesh:D011471" || broaderDiagnosis(id) === "mesh:D011471",
    );
  return {
    cutoff,
    prostateContext,
    evidence,
    diagnoses: gate,
    concepts: [...concepts.byId.values()],
    stage: patientStage(stageIds, stageTexts, therapy, prostateContext),
    treatments,
    relations,
    ...(sex !== undefined && { sex }),
    conceptOnly: graph === undefined && !relations.size,
  };
}
