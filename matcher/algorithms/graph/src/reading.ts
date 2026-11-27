import type { JourneyState } from "@matcher/core";
import { normalizeName } from "@matcher/terminology";
import { LUNG, lungHistology, NSCLC, SCLC } from "./histology.ts";
import { PROFILES } from "./profile.ts";
import type { QueryWeights } from "./query.ts";
import { type Concept, QUALIFIERS, type Terminology } from "./resolve.ts";
import { STAGE_CONCEPTS, type Stage } from "./stages.ts";
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

export type ClinicalEvidence = {
  ref: string;
  date: string;
  detail: string;
  concept?: string;
  diagnosis?: string;
  status?: Status;
};

export function tripleKey({ subject, predicate, object }: Triple): string {
  return JSON.stringify([subject, predicate, object]);
}

export const CERTAINTY: Record<Status, number> = {
  asserted: 1,
  unknown: 0.65,
  planned: 0.55,
  suspected: 0.45,
  negated: 0,
};

// Graphiti supplies day precision. On a tie prefer explicit evidence, with a veto for negation.
export const STATUS_ORDER: Record<Status, number> = {
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

export type DatedStatus = {
  validAt?: string;
  invalidAt?: string;
  status: Status;
  text?: string;
};

export function latest<T extends DatedStatus>(
  statements: T[],
  keyOf: (statement: T) => string,
  cutoff: string,
  stageTexts?: string[],
  findings = false,
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
    // A finding is different: metastases named on a later day follow "keine Fernmetastasen".
    let current = list[0];
    for (let i = 1; i < list.length; i++) {
      const next = list[i];
      const later = findings && (next.validAt ?? "") > (current.validAt ?? "");
      current =
        next.status === "unknown" &&
        EXPLICIT_STATUSES.has(current.status) &&
        !later
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

export const isTherapy = (role: Role) =>
  role === "drug" || role === "procedure";

export type ClinicalLink = Triple &
  DatedStatus & { ref: string; validAt: string };

/** The role of a patient concept; `kind` and `conditionRole` come from the patient fact. */
export function roleOf(
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
export function diagnosisRole(concept: Concept, text: string): Role {
  const role = roleOf(concept, "diagnosis");
  if (
    role === "stage" &&
    concept.name.endsWith(" Neoplasms") &&
    !/metasta|secondary|sekund[aä]r|\bc7[789]\b/i.test(text)
  )
    return "diagnosis";
  return role;
}

// radiotherapy, plus the profiles' operations
const LOCAL_THERAPY = new RegExp(
  [
    /radiotherap|bestrahl|strahlenther|\bimrt\b|brachyther/.source,
    ...PROFILES.flatMap((profile) => profile.therapyNames?.local ?? []),
  ].join("|"),
);

/** Operation concept ID → the profile flag it sets */
export const OPERATION_FLAGS: ReadonlyMap<string, string> = new Map(
  PROFILES.flatMap((profile) =>
    Object.entries(profile.flags ?? {}).flatMap(
      ([name, flag]): [string, string][] =>
        "operation" in flag ? [[flag.operation, name]] : [],
    ),
  ),
);

/** An operation or a radiotherapy: by the kind of its procedure, or by a name it was written with. */
export function isLocalTherapy(
  concept: Concept | undefined,
  names: readonly string[],
): boolean {
  return (
    (concept?.type === "procedure" &&
      !concept.diagnostic &&
      (concept.qualifier === QUALIFIERS.surgery ||
        concept.qualifier === QUALIFIERS.radiotherapy)) ||
    names.some((name) => LOCAL_THERAPY.test(normalizeName(name)))
  );
}

/** The shared state of reading one patient: what the readers find and the query is built from. */
export function startReading(
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
    systemicTherapy: false,
    plannedTherapy: false,
    diagnosticFocus: false,
    flags: Object.fromEntries(
      PROFILES.flatMap((profile) => Object.keys(profile.flags ?? {})).map(
        (name): [string, boolean] => [name, false],
      ),
    ),
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
export type Reading = ReturnType<typeof startReading>;
