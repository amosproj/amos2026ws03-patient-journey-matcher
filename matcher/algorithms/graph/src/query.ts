import type { JourneyEvent, JourneyState } from "@matcher/core";
import timeline from "../data/timeline.json" with { type: "json" };
import { LUNG, lungHistology, NSCLC, SCLC } from "./histology.ts";
import { normalizePatientGraph, parseDay } from "./patient.ts";
import {
  broaderDiagnosis,
  type Concept,
  compatibleDiagnoses,
  conceptOf,
  defaultTerminology,
  resolveIcd,
  type Terminology,
} from "./resolve.ts";
import {
  conceptStages,
  type PatientStage,
  patientStage,
  STAGE_CONCEPTS,
  type Stage,
  type StageObservation,
  stageObservations,
} from "./stages.ts";
import {
  diseaseMentions,
  patientText,
  statusFromAttribute,
  statusFromText,
  treatmentClauses,
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
type Role = (typeof ROLES)[number];

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

function tripleKey({ subject, predicate, object }: Triple): string {
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
          stageTexts.push(item.text);
      }
    }
    if (current.validAt) result.push({ ...current, validAt: current.validAt });
  }
  return result;
}

function timelineTreatments(event: JourneyEvent, terminology: Terminology) {
  const courses = new Map<string, Status>();
  const clauses = treatmentClauses(event.label);
  const therapies = (text: string) =>
    terminology
      .findConcepts(text)
      .filter((concept) => isTherapy(roleOf(concept, undefined)));
  const attribute = event.parameters?.treatment_status;
  const type = normalizeName(event.type);
  const fallback =
    (typeof attribute === "string" ? treatmentStatus(attribute) : undefined) ??
    statusFromAttribute(attribute) ??
    (PLANS.has(type) ? "planned" : GIVES.has(type) ? "asserted" : "unknown");
  let namedAction = false;
  for (const clause of clauses) {
    for (const concept of therapies(clause.text)) {
      const cue = statusFromText(clause.text, [
        concept.name,
        ...concept.names,
      ])?.status;
      const status =
        cue === "negated" || cue === "suspected" ? cue : clause.status;
      if (status) namedAction = true;
      if (status || !courses.has(concept.id))
        courses.set(concept.id, status ?? fallback);
    }
  }
  const actions = new Set(clauses.flatMap((clause) => clause.status ?? []));
  const unnamed =
    !namedAction && actions.size === 1 ? [...actions][0] : undefined;
  for (const concept of therapies(eventText(event))) {
    if (!courses.has(concept.id)) courses.set(concept.id, unnamed ?? fallback);
  }
  return courses;
}

function timelineConditions(
  events: JourneyEvent[],
  terminology: Terminology,
  evidence: ClinicalEvidence[],
  courses: Map<JourneyEvent, Map<string, Status>>,
) {
  type Statement = DatedStatus & { entity: string; ref: string };
  const since = new Map<string, string>();
  const notes: {
    event: JourneyEvent;
    text: string;
    statuses: Map<string, Status>;
    introduced: Set<string>;
  }[] = [];
  const conflicts = new Set<JourneyEvent>();
  for (const event of events) {
    const { diagnosis, icd_code: code, indication } = event.parameters ?? {};
    const diagnostic = ["diagnosis", "pathology", "progression"].includes(
      normalizeName(event.type),
    );
    const label = diseaseMentions(event.label, terminology);
    const field =
      typeof diagnosis === "string"
        ? diseaseMentions(diagnosis, terminology)
        : [];
    const byCode = resolveIcd(code);
    const labelHits = diagnostic || byCode?.type === "disease" ? label : [];
    const codes = [...field, ...labelHits]
      .filter((hit) => hit.code)
      .map((hit) => hit.concept);
    const codeConflict =
      byCode && codes.some((item) => !compatibleDiagnoses(byCode, item));
    if (byCode?.type === "disease") codes.push(byCode);
    const nameConflict = [field, labelHits].some((hits) => {
      const names = hits.filter((hit) => !hit.code);
      const positive = names.filter((hit) => hit.status !== "negated");
      const diagnosticNames = positive.length ? positive : names;
      return (
        diagnosticNames.length > 0 &&
        codes.some(
          (id) =>
            !diagnosticNames.some((hit) =>
              compatibleDiagnoses(id, hit.concept),
            ),
        )
      );
    });
    if (codeConflict || nameConflict) {
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: "Diagnostic name and ICD code disagree",
      });
      conflicts.add(event);
      continue;
    }
    const introduced = new Set<string>();
    for (const hit of [
      ...(field.length ? field : diagnostic ? label : []),
      ...label.filter((hit) => hit.status === "negated"),
    ])
      introduced.add(hit.concept.id);
    if (byCode?.type === "disease") introduced.add(byCode.id);
    if (
      typeof indication === "string" &&
      [...(courses.get(event)?.values() ?? [])].includes("asserted")
    ) {
      const targets = new Set(
        terminology.findDiseases(indication).map((hit) => hit.concept.id),
      );
      const [target] = targets;
      if (targets.size === 1 && !since.has(target)) introduced.add(target);
    }
    if (!introduced.size && (diagnostic || diagnosis || code))
      evidence.push({
        ref: event.id,
        date: event.date,
        detail: "No unambiguous mapped diagnosis in diagnostic field",
      });
    for (const id of introduced) if (!since.has(id)) since.set(id, event.date);
    const statuses = new Map<string, Status>();
    for (const hit of [...field, ...label]) {
      const prior = statuses.get(hit.concept.id) ?? "unknown";
      if (hit.status && STATUS_ORDER[hit.status] > STATUS_ORDER[prior])
        statuses.set(hit.concept.id, hit.status);
    }
    notes.push({
      event,
      introduced,
      statuses,
      text: [diagnosis, event.label, code, indication]
        .filter(Boolean)
        .join(". "),
    });
  }
  const statements: Statement[] = [];
  for (const { event, introduced, statuses, text } of notes) {
    for (const entity of new Set([...introduced, ...statuses.keys()])) {
      const start = since.get(entity);
      if (!start || event.date < start) continue;
      statements.push({
        entity,
        validAt: event.date,
        ref: event.id,
        text,
        status:
          statuses.get(entity) ??
          statusFromAttribute(event.parameters?.diagnosis_status) ??
          "unknown",
      });
    }
  }
  return { statements, conflicts };
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
  courses: Map<string, Status>,
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
          predicate === "treats"
            ? courses.get(subject.id)
            : (statusFromText(text, [subject.name, ...subject.names])?.status ??
              "asserted");
        if (
          !status ||
          (predicate === "treats" &&
            (status === "unknown" || status === "suspected"))
        )
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

/** The IDs a paper may have for a diagnosis: the concept, its other IDs and narrower forms. */
function diagnosisIds(
  concept: Concept,
  excluded: ReadonlySet<string>,
): string[] {
  return [
    concept.id,
    ...(concept.also ?? []),
    ...(concept.narrower ?? []),
  ].filter((id) => !excluded.has(id));
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

/** The shared state of reading one patient: what the readers find and the query is built from. */
function startReading(
  { focus, graph }: JourneyState,
  weights: QueryWeights,
  terminology: Terminology,
) {
  const cutoff = graph?.as_of ?? focus.date;
  const evidence: ClinicalEvidence[] = [];
  const links: ClinicalLink[] = [];
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
  const excluded = new Set<string>();
  const diagnosisDates = new Map<string, string>();
  const histologyNotes: {
    validAt: string;
    ref: string;
    subtype: string;
    status: Status;
  }[] = [];
  function recordHistology(
    text: string,
    date: string,
    ref: string,
    site?: string,
    field?: unknown,
    statementStatus?: Status,
  ) {
    const result = lungHistology(text, field);
    if (
      !result ||
      (result.status === "asserted" &&
        statementStatus &&
        !["asserted", "unknown"].includes(statementStatus))
    )
      return;
    const sites = site?.startsWith("mesh:")
      ? [site]
      : terminology.findDiseases(site || text).map(({ concept }) => concept.id);
    // A standalone pathology value can refer to a single already documented diagnosis.
    if (!sites.length && !site)
      for (const condition of latest(
        reading.diagnosticHistory,
        (c) => c.entity,
        date,
      ))
        if (condition.status !== "negated" && condition.status !== "planned")
          sites.push(condition.entity);
    if (
      sites.length &&
      sites.every((id) => id === LUNG || id === NSCLC || id === SCLC)
    )
      histologyNotes.push({
        validAt: date,
        ref,
        subtype: result.id,
        status: result.status,
      });
  }
  // For the disease state: concept IDs of the active statements, texts of all so far.
  const stageIds: string[] = [];
  const stageTexts: string[] = [];
  const observed = new Set<Stage>();
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
  const reading = {
    focus,
    weights,
    terminology,
    cutoff,
    conceptOf,
    factor,
    multiplier,
    recordHistology,
    evidence,
    links,
    diagnoses,
    excluded,
    diagnosisDates,
    diagnosticHistory: [] as (DatedStatus & { entity: string; ref: string })[],
    histologyNotes,
    stageIds,
    stageTexts,
    observed,
    therapy,
    found,
  };
  return reading;
}
type Reading = ReturnType<typeof startReading>;

/** Reads a timeline: the diagnoses, therapies and findings of its events up to the cutoff. */
function readTimeline(context: JourneyEvent[], reading: Reading): void {
  const {
    focus,
    weights,
    terminology,
    cutoff,
    conceptOf,
    factor,
    multiplier,
    recordHistology,
    evidence,
    links,
    diagnoses,
    excluded,
    diagnosisDates,
    observed,
    therapy,
    found,
  } = reading;
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
      if (familyEvent) return [];
      const originalIds = new Set(
        terminology.findDiseases(event.label).map((hit) => hit.concept.id),
      );
      const patientIds = new Set(
        terminology.findDiseases(label).map((hit) => hit.concept.id),
      );
      const parameters = Object.fromEntries(
        Object.entries(event.parameters ?? {}).flatMap(([key, value]) => {
          if (typeof value !== "string") return [[key, value]];
          const cleaned = patientText(value);
          if (!cleaned) return [];
          if (
            label !== event.label &&
            ["diagnosis", "icd_code"].includes(key)
          ) {
            const hits = terminology.findDiseases(cleaned);
            if (
              hits.some(
                ({ concept }) =>
                  originalIds.has(concept.id) && !patientIds.has(concept.id),
              )
            )
              return [];
          }
          return [[key, cleaned]];
        }),
      );
      if (!label && !parameters.diagnosis && !parameters.icd_code) return [];
      return [{ ...event, label, parameters }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const courses = new Map(
    events.map((event) => [event, timelineTreatments(event, terminology)]),
  );
  const { statements: conditions, conflicts } = timelineConditions(
    events,
    terminology,
    evidence,
    courses,
  );
  reading.diagnosticHistory = conditions;
  const staging: (StageObservation & { validAt: string })[] = [];
  const recordStage = (id: string, status: Status, validAt: string) => {
    for (const stage of conceptStages(id))
      staging.push({ stage, entity: id, status, validAt });
  };
  for (const fact of latest(conditions, (fact) => fact.entity, cutoff)) {
    diagnosisDates.set(fact.entity, fact.validAt);
    evidence.push({
      ref: fact.ref,
      date: fact.validAt,
      diagnosis: fact.entity,
      status: fact.status,
      detail: "Dated diagnostic statement",
    });
    const concept = conceptOf(fact.entity);
    if (concept === undefined) continue;
    const role = diagnosisRole(concept, fact.text ?? "");
    if (role === "stage") recordStage(concept.id, fact.status, fact.validAt);
    if (fact.status === "negated" || fact.status === "planned") {
      excluded.add(fact.entity);
      continue;
    }
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
  }
  const cancellations = new Map<
    JourneyEvent,
    { subjects: Set<string>; indication?: string }
  >();
  const indicationOf = (event: JourneyEvent) => {
    const name = event.parameters?.indication;
    if (typeof name !== "string") return undefined;
    const ids = new Set(
      terminology.findDiseases(name).map((hit) => hit.concept.id),
    );
    return ids.size === 1 ? [...ids][0] : normalizeName(name);
  };
  // Per event: the concepts its texts name and its parameters give, whether it plans or gives
  // the therapies among them, and the diagnoses it implies.
  const read = events
    .filter((event) => !conflicts.has(event))
    .map((event) => {
      const parameters = parameterFacts(event);
      const text = eventText(event);
      const p = event.parameters;
      const site = p?.diagnosis ?? p?.indication ?? p?.icd_code;
      recordHistology(
        event.label,
        event.date,
        event.id,
        typeof site === "string" ? site : undefined,
        p?.histology,
        statusFromAttribute(p?.diagnosis_status),
      );
      const treatments = courses.get(event) ?? new Map<string, Status>();
      const actions = [...treatments.values()];
      const onlyPlan =
        !actions.includes("asserted") &&
        (PLANS.has(normalizeName(event.type)) || actions.includes("planned"));
      if (!onlyPlan) {
        for (const observation of stageObservations(text, terminology)) {
          staging.push({ ...observation, validAt: event.date });
        }
        for (const concept of parameters.concepts)
          recordStage(concept.id, "asserted", event.date);
        for (const [key, value] of Object.entries(event.parameters ?? {}))
          if (value === false)
            for (const id of PARAMETERS[key]?.values?.true ?? [])
              recordStage(id, "negated", event.date);
      }
      const cancelled = [...treatments].filter(
        ([, status]) => status === "negated",
      );
      if (cancelled.length)
        cancellations.set(event, {
          subjects: new Set(cancelled.map(([id]) => id)),
          indication: indicationOf(event),
        });
      const concepts = [
        ...new Set([...terminology.findConcepts(text), ...parameters.concepts]),
      ].filter(
        (concept) =>
          !diagnoses.has(concept.id) &&
          (!excluded.has(concept.id) || STAGE_CONCEPTS.has(concept.id)) &&
          (isTherapy(roleOf(concept, undefined))
            ? treatments.get(concept.id) !== "negated"
            : statusFromText(text, [concept.name, ...concept.names])?.status !==
              "negated"),
      );
      const implied = [...parameters.implied];
      for (const concept of concepts)
        if (
          concept.implies !== undefined &&
          treatments.get(concept.id) === "asserted" &&
          (concept.id !== "mesh:D011468" ||
            /\bradical|\bradikal|\brpe\b|\brarp\b|\bralp\b/.test(
              normalizeName(text),
            ))
        )
          implied.push({ id: concept.implies, status: "asserted" });
      const prostateWorkup =
        parameters.implied.length > 0 ||
        treatments.get("mesh:D011468") === "asserted";
      return {
        event,
        text,
        concepts,
        treatments,
        implied,
        prostateWorkup,
      };
    });
  // A cancellation withdraws earlier plans for the named intervention. Past administrations
  // and plans made after the cancellation still contribute at their own cutoffs.
  for (const plan of read) {
    if (
      !cancellations.size ||
      ![...plan.treatments.values()].includes("planned")
    )
      continue;
    const indication = indicationOf(plan.event);
    for (const [event, cancel] of cancellations) {
      if (
        event.date < plan.event.date ||
        (cancel.indication && indication && cancel.indication !== indication)
      )
        continue;
      plan.concepts = plan.concepts.filter(
        (concept) =>
          plan.treatments.get(concept.id) !== "planned" ||
          !cancel.subjects.has(concept.id),
      );
    }
  }
  // An exclusion of distant spread (M0) applies to earlier sites; a site-specific
  // exclusion leaves evidence for other sites available.
  const activeStages = latest(
    staging,
    (item) => `${item.stage}/${item.entity ?? ""}`,
    cutoff,
  );
  const stageStatus = new Map<string, Status>();
  for (const item of activeStages) {
    const general = activeStages.find(
      (other) =>
        other.stage === item.stage &&
        (!other.entity || other.entity === "mesh:D009362") &&
        other.status === "negated" &&
        other.validAt >= item.validAt,
    );
    const status = general ? "negated" : item.status;
    if (item.entity) {
      stageStatus.set(item.entity, status);
      if (status === "negated" || status === "planned") {
        excluded.add(item.entity);
        diagnoses.delete(item.entity);
      } else excluded.delete(item.entity);
    }
    if (status === "asserted" || status === "unknown") observed.add(item.stage);
  }
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
  }
  // The current therapy: the therapies of the latest event that gives one, or of the focus
  // event when it decides them.
  const lastTherapy = read.findLastIndex(({ concepts, treatments, event }) =>
    concepts.some(
      ({ id }) =>
        treatments.get(id) === "asserted" ||
        (event.id === focus.id && treatments.get(id) === "planned"),
    ),
  );
  read.forEach(({ event, text, concepts, treatments }, index) => {
    for (const relation of timelineRelations(
      event,
      text,
      treatments,
      terminology,
      evidence,
    )) {
      if (
        relation.status !== "planned" ||
        concepts.some((c) => c.id === relation.subject)
      )
        links.push(relation);
    }
    const news = event.id === focus.id;
    for (const concept of concepts) {
      const role = roleOf(concept, undefined);
      const course = treatments.get(concept.id);
      const received = course === "asserted";
      const planned = course === "planned";
      if (planned) therapy.plannedTherapy = true;
      if (received) {
        if (LOCAL_THERAPY.test(normalizeName(concept.name)))
          therapy.localTherapy = true;
        if (
          normalizeName(event.type) === "surgery" &&
          concept.id === "mesh:D011468"
        )
          therapy.prostatectomy = true;
        if (role === "drug") therapy.systemicTherapy = true;
      }
      const current = index === lastTherapy && (received || planned);
      const status = planned
        ? "planned"
        : course === "suspected" || stageStatus.get(concept.id) === "suspected"
          ? "suspected"
          : "unknown";
      found.push({
        concept,
        role,
        weight:
          weights.roles[role] *
          CERTAINTY[status] *
          multiplier(news, current, false),
        focus: news || current,
        received,
      });
    }
  });
}

/** Reads a patient graph: the statements that are valid at the cutoff. */
function readGraph(
  graph: NonNullable<JourneyState["graph"]>,
  reading: Reading,
): void {
  const {
    focus,
    weights,
    terminology,
    cutoff,
    conceptOf,
    factor,
    multiplier,
    recordHistology,
    evidence,
    links,
    diagnoses,
    excluded,
    diagnosisDates,
    stageIds,
    stageTexts,
    therapy,
    found,
  } = reading;
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
            (node.attributes as { icd_code?: unknown } | undefined)?.icd_code ??
              "",
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
    { terminology },
  );
  const familyRefs = new Set(
    normalized.skipped
      .filter((s) => s.reason === "family history")
      .map((s) => s.ref),
  );
  reading.diagnosticHistory = normalized.facts
    .filter((fact) => fact.conditionRole === "diagnosis")
    .map((fact) => ({ ...fact, ref: fact.origin.ref }));
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
      diagnosisDates.set(fact.entity, fact.validAt);
    if (
      fact.conditionRole === "diagnosis" &&
      (fact.status === "negated" || fact.status === "planned")
    )
      excluded.add(fact.entity);
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
      concept.type !== "chemical" &&
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
        ["LabTest", "TumorMarker", "ImagingResult", "PathologyResult"].includes(
          label,
        ),
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
            (fact.entity === relation.subject && fact.kind === "has_finding")),
      ) ||
      !target?.labels.includes("Diagnosis") ||
      concept?.type !== "disease" ||
      roleOf(concept, "diagnosis") !== "diagnosis"
    )
      continue;
    const weight =
      weights.roles.diagnosis * factor(relation.validAt, "suspected");
    diagnoses.set(concept.id, Math.max(weight, diagnoses.get(concept.id) ?? 0));
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
  for (const fact of [...normalized.facts, ...normalized.relations]) {
    if (
      !fact.text ||
      !fact.validAt ||
      (fact.invalidAt && fact.invalidAt <= cutoff)
    )
      continue;
    const site =
      "object" in fact
        ? fact.object
        : fact.conditionRole === "diagnosis"
          ? fact.entity
          : undefined;
    recordHistology(
      fact.text,
      fact.validAt,
      fact.origin.ref,
      site,
      undefined,
      fact.status,
    );
  }
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
        else if (LOCAL_THERAPY.test(normalizeName(concept.name)))
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
    if (
      role === "diagnosis" &&
      status === "suspected" &&
      concept.id !== "mesh:D011471" &&
      broaderDiagnosis(concept.id) !== "mesh:D011471"
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
      targets.length || diagnoses.size !== 1 ? targets : [...diagnoses.keys()],
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
