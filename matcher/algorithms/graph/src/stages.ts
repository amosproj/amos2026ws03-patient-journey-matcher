// Disease states (Documentation/design/graph-normalization.md#ranking): which states a
// paper is about and which the patient is in. A paper about states that all contradict the
// patient's ranks lower; one about his current state ranks higher.

import { normalizeName } from "@matcher/terminology";
import neoplasms from "../data/neoplasms.json" with { type: "json" };
import data from "../data/stages.json" with { type: "json" };
import {
  conceptOf,
  HISTOLOGY,
  PROCESSES,
  QUALIFIERS,
  type Terminology,
} from "./resolve.ts";
import { MESH_MAJOR } from "./schema.ts";
import { statusFromText } from "./status.ts";
import type { Status } from "./types.ts";

export const STAGES = [
  "screening",
  "surveillance",
  "localized",
  "recurrence",
  "metastatic",
  "hormone_sensitive",
  "castration_resistant",
] as const;
export type Stage = (typeof STAGES)[number];

/**
 * Which rules a paper gets: all of them for a prostate cancer paper of a prostate cancer patient,
 * the states every cancer has for a paper on another of his cancers.
 */
export type Scope = "prostate" | "cancer";

type StageData = {
  id: Stage;
  title: RegExp;
  mesh: string[];
  concepts: string[];
  names: RegExp | undefined;
  /** A state of prostate cancer only, such as castration-resistant. */
  prostate: boolean;
};

const STAGE_DATA: readonly StageData[] = data.stages.map((stage) => ({
  id: stage.id as Stage,
  title: new RegExp(stage.title, "i"),
  mesh: stage.mesh,
  concepts: stage.concepts,
  names: stage.names === "" ? undefined : new RegExp(stage.names),
  prostate: "prostate" in stage && stage.prostate === true,
}));

/** Patient concepts that tell a state, such as bone metastases. */
export const STAGE_CONCEPTS: ReadonlySet<string> = new Set(
  STAGE_DATA.flatMap((stage) => stage.concepts),
);

const TREATMENT_TOPICS: readonly string[] = data.treatment;
const DIAGNOSIS_TOPICS: readonly string[] = data.diagnosis;
const ALTERNATIVES: readonly string[] = data.alternatives;
const NEOPLASMS: ReadonlySet<string> = new Set(neoplasms.ids);
const GENERIC_NEOPLASMS: ReadonlySet<string> = new Set(neoplasms.generic);

/** A neoplasm of tree C04, specific or not. */
export function isNeoplasm(id: string): boolean {
  return NEOPLASMS.has(id);
}

/** A specific cancer, not a heading such as Neoplasms or a kind of carcinoma such as carcinoma in situ. */
export function isCancer(id: string): boolean {
  return NEOPLASMS.has(id) && !isGenericNeoplasm(id);
}

// For any disease: what a paper does with the patient's diagnosis (Breast Neoplasms/surgery).
const TREATMENT_QUALIFIERS = [
  QUALIFIERS.surgery,
  QUALIFIERS.radiotherapy,
  QUALIFIERS.drug,
  "Q000628", // therapy
];
const DIAGNOSIS_QUALIFIERS = ["Q000175", QUALIFIERS.imaging]; // diagnosis
const ANTINEOPLASTIC_AGENTS = "mesh:D000970";

/** Where the patient stands at the cutoff. */
export interface PatientStage {
  states: Set<Stage>;
  /** The diagnosis is asserted, not only suspected. */
  diagnosed: boolean;
  /** Had a prostatectomy or radiotherapy. */
  localTherapy: boolean;
  /** A prostatectomy is recorded as performed. */
  prostatectomy?: boolean;
  /** PSA is in focus during investigation of suspected prostate cancer. */
  psaWorkup?: boolean;
  /** Had a drug against the cancer, such as hormone therapy or chemotherapy. */
  systemicTherapy: boolean;
  /** A treatment is planned (a tumor board decided one). */
  plannedTherapy?: boolean;
  /** The focus day is about a test, such as a biopsy or a PSMA PET/CT. */
  diagnosticFocus?: boolean;
}

/** How strongly a paper's state contradicts the patient's; see `stageFactor`. */
export type Severity = "strong" | "moderate" | "mild";

// A cue after these words, or before "free", says the patient is not in the state.
const NEGATED_BEFORE =
  /\b(?:kein\w*|no|not|nicht|without|ohne|negativ\w*|frei von|free of|ausschluss|ausgeschlossen|excluded)\b(?: \w+){0,3} $/;
const NEGATED_AFTER =
  /^\w* (?:free|frei|ausgeschlossen|ruled out|excluded)\b|^\w*(?:free|frei)\b/;

export type StageObservation = {
  stage: Stage;
  entity?: string;
  status: Status;
};

export function conceptStages(id: string): Stage[] {
  return STAGE_DATA.filter((stage) => stage.concepts.includes(id)).map(
    (stage) => stage.id,
  );
}

/** Keep the site of a stage cue so a later negative bone scan can revise that finding alone. */
export function* stageObservations(
  text: string,
  terminology?: Terminology,
): Generator<StageObservation> {
  for (const part of text.split(
    /[;!?]|\.(?=\s|$)|,|\b(?:but|aber|jedoch)\b/i,
  )) {
    const clause = normalizeName(part);
    const mentions = terminology?.findMentions(clause);
    if (/\b[cp]?m0\b/.test(clause))
      yield { stage: "metastatic", status: "negated" };
    for (const stage of STAGE_DATA) {
      if (!stage.names) continue;
      for (const match of clause.matchAll(
        new RegExp(stage.names.source, "g"),
      )) {
        const before = clause.slice(0, match.index);
        const after = clause.slice(match.index + match[0].length);
        // The configured patterns include word stems, whereas status cues need the full name.
        const phrase =
          (/\w*$/.exec(before)?.[0] ?? "") +
          match[0] +
          (/^\w*/.exec(after)?.[0] ?? "");
        const site = mentions?.find(
          (hit) =>
            hit.start <= match.index &&
            match.index < hit.end &&
            stage.concepts.includes(hit.concept.id),
        );
        const status =
          NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after)
            ? "negated"
            : (statusFromText(part, [site?.mention ?? phrase])?.status ??
              "unknown");
        yield { stage: stage.id, entity: site?.concept.id, status };
      }
    }
  }
}

export function stageCues(text: string): Set<Stage> {
  return new Set(
    [...stageObservations(text)]
      .filter((cue) => cue.status === "asserted" || cue.status === "unknown")
      .map((cue) => cue.stage),
  );
}

/**
 * The states of a patient: from the concept IDs of his active statements (bone metastases), the
 * states their concepts imply (radium-223: metastatic and castration-resistant) and the cues in
 * the normalized names and sentences of his statements so far.
 */
export function patientStage(
  ids: readonly string[],
  texts: readonly string[],
  therapy: Omit<PatientStage, "states">,
  prostateContext = true,
  observed: Iterable<Stage> = [],
): PatientStage {
  const states = new Set<Stage>(observed);
  for (const stage of STAGE_DATA) {
    if (ids.some((id) => stage.concepts.includes(id))) states.add(stage.id);
  }
  if (prostateContext) {
    for (const id of ids)
      for (const stage of conceptOf(id)?.stages ?? [])
        states.add(stage as Stage);
  }
  for (const text of texts)
    for (const stage of stageCues(text)) states.add(stage);
  if (!prostateContext) {
    states.delete("castration_resistant");
    states.delete("hormone_sensitive");
  }
  if (states.has("castration_resistant")) {
    states.delete("hormone_sensitive");
  }
  return { states, ...therapy };
}

/** The states a paper is about: from its title, or a major MeSH topic. */
export function paperStages(
  title: string,
  mesh: Readonly<Record<string, number>>,
  scope: Scope,
): Set<Stage> {
  const states = new Set<Stage>();
  for (const stage of STAGE_DATA) {
    if (stage.prostate && scope !== "prostate") continue;
    if (stage.title.test(title) || stage.mesh.some((id) => isMajor(mesh, id)))
      states.add(stage.id);
  }
  return states;
}

/** A paper about this state is meant for the patient. `localized` is too broad to count, and screening papers are only background in the workup. */
function fits(stage: Stage, patient: PatientStage): boolean {
  const { states } = patient;
  switch (stage) {
    case "screening":
    case "localized":
      return false;
    case "surveillance":
      return states.has("surveillance") && !patient.localTherapy;
    case "hormone_sensitive":
      return states.has("metastatic") && !states.has("castration_resistant");
    default:
      return states.has(stage);
  }
}

/**
 * How strongly a paper about this state is meant for patients in another situation. The
 * strengths follow the LLM grades of the sample journeys (research/graph-based-matching.md#7-results): papers on an earlier
 * phase or on the opposite situation are almost never relevant, a paper on the likely next phase
 * (castration resistance for a metastatic patient on hormone therapy) often is.
 */
function contradicts(
  stage: Stage,
  patient: PatientStage,
  scope: Scope,
): Severity | undefined {
  const { states } = patient;
  const advanced =
    states.has("metastatic") || states.has("castration_resistant");
  const treated = patient.localTherapy || patient.systemicTherapy;
  switch (stage) {
    case "screening":
      return patient.diagnosed || treated || advanced ? "moderate" : undefined;
    case "surveillance":
      return treated || advanced || states.has("recurrence")
        ? "strong"
        : undefined;
    case "localized":
      return advanced ? "strong" : undefined;
    case "recurrence":
      // A biochemical recurrence of prostate cancer follows local therapy and is not metastatic.
      // Elsewhere a relapse is often metastatic ("recurrent or metastatic breast cancer").
      if (scope === "prostate")
        return !patient.localTherapy || advanced ? "strong" : undefined;
      return treated ? undefined : "strong";
    case "metastatic":
      return states.has("metastatic") ? undefined : "moderate";
    case "hormone_sensitive":
      return states.has("castration_resistant") ? "strong" : undefined;
    case "castration_resistant":
      return states.has("castration_resistant")
        ? undefined
        : states.has("metastatic")
          ? "mild"
          : "moderate";
  }
}

type Phase = "treatment" | "diagnosis" | undefined;

/** A prostate cancer paper about treating the disease, or only about finding it, by its major MeSH topics. */
function prostatePhase(mesh: Readonly<Record<string, number>>): Phase {
  const major = (ids: readonly string[]) => ids.some((id) => isMajor(mesh, id));
  if (major(TREATMENT_TOPICS)) return "treatment";
  if (major(DIAGNOSIS_TOPICS)) return "diagnosis";
  return undefined;
}

/**
 * A paper about treating one of the patient's diagnoses or only about finding it, for any disease:
 * by the qualifiers of his diagnosis (Breast Neoplasms/surgery, /diagnostic imaging) and by the
 * kind of a procedure, both as a major topic.
 */
function diseasePhase(
  mesh: Readonly<Record<string, number>>,
  diagnoses: ReadonlySet<string>,
): Phase {
  let phase: Phase;
  for (const id of Object.keys(mesh)) {
    if (!isMajor(mesh, id)) continue;
    const [, descriptor, qualifier] = /^(mesh:D\d+)(Q\d+)?$/.exec(id) ?? [];
    if (descriptor === undefined) continue;
    if (qualifier !== undefined) {
      if (!diagnoses.has(descriptor)) continue;
      if (TREATMENT_QUALIFIERS.includes(qualifier)) return "treatment";
      if (DIAGNOSIS_QUALIFIERS.includes(qualifier)) phase = "diagnosis";
      continue;
    }
    if (id === ANTINEOPLASTIC_AGENTS) return "treatment";
    const concept = conceptOf(id);
    if (concept?.type !== "procedure") continue;
    if (!concept.diagnostic) return "treatment";
    phase = "diagnosis";
  }
  return phase;
}

/**
 * Whether a paper's phase contradicts the patient's: treatment papers while he is still being
 * diagnosed (no treatment given, planned or watched; for other diseases than prostate cancer also
 * not yet confirmed, as treatment papers fit a confirmed diagnosis), papers only on diagnosis once
 * his treatment began and the focus day is not about a test. Without `diagnoses` the prostate
 * cancer topics decide the phase of a paper.
 */
export function phaseConflict(
  mesh: Readonly<Record<string, number>>,
  patient: PatientStage,
  diagnoses?: ReadonlySet<string>,
): Severity | undefined {
  const phase =
    diagnoses === undefined
      ? prostatePhase(mesh)
      : diseasePhase(mesh, diagnoses);
  const treated = patient.localTherapy || patient.systemicTherapy;
  if (
    phase === "treatment" &&
    !treated &&
    !patient.plannedTherapy &&
    !patient.states.has("surveillance") &&
    !patient.states.has("metastatic") &&
    (diagnoses === undefined || !patient.diagnosed)
  )
    return "strong";
  if (phase === "diagnosis" && treated && !patient.diagnosticFocus)
    return "mild";
  return undefined;
}

/** Evidence of the clinical question within a disease state. */
export function careContext(
  patient: PatientStage,
  paper: ReadonlySet<Stage>,
  title: string,
  mesh: Readonly<Record<string, number>>,
):
  | "diagnostic workup"
  | "surveillance follow-up"
  | "postoperative salvage radiotherapy"
  | undefined {
  // Differential diagnosis distinguishes a raised PSA from population screening.
  if (patient.psaWorkup && "mesh:D017430" in mesh && "mesh:D003937" in mesh)
    return "diagnostic workup";
  if (
    patient.states.has("surveillance") &&
    !patient.localTherapy &&
    !patient.systemicTherapy &&
    !patient.diagnosticFocus &&
    !patient.states.has("metastatic") &&
    !patient.states.has("recurrence") &&
    paper.has("surveillance")
  ) {
    // Follow-Up Studies and Treatment Outcome together describe what happens on surveillance.
    if (
      ("mesh:D005500" in mesh && "mesh:D016896" in mesh) ||
      /reclassif|discontinu\w* (?:of )?(?:active )?surveillance|(?:switch|conversion) to (?:active |definitive |curative )?(?:treatment|therapy)|treatment triggers?/i.test(
        title,
      )
    )
      return "surveillance follow-up";
  }
  if (patient.prostatectomy && patient.states.has("recurrence")) {
    const salvageRadiation =
      /\bsalvage (?:external[- ]beam |conformal )?(?:radio(?:therapy|therapies)|radiation|irradiation)\b/i.test(
        title,
      );
    const salvageSurgery =
      /\bsalvage (?:radical )?prostatectom(?:y|ies)\b/i.test(title);
    if (
      salvageRadiation &&
      !salvageSurgery &&
      /\b(?:after|following|prior(?!\s+to\b)) (?:\w+[ -]){0,3}prostatectomy\b|\bpost[- ]?prostatectomy\b/i.test(
        title,
      )
    )
      return "postoperative salvage radiotherapy";
  }
  return undefined;
}

/**
 * How a paper's states change its score. A title's states narrow each other ("metastatic
 * castration-resistant"), so one contradicting state gives the factor of its severity; else a
 * fitting one gives `fit`. Localized and metastatic together span the disease and count as
 * neither.
 */
export function stageFactor(
  paper: ReadonlySet<Stage>,
  patient: PatientStage,
  factors: { fit: number } & Record<Severity, number>,
  scope: Scope,
): { factor: number; fitting: Stage[]; contradicting: Stage[] } {
  const states = [...paper].filter(
    (stage) =>
      !(
        paper.has("localized") &&
        paper.has("metastatic") &&
        (stage === "localized" || stage === "metastatic")
      ),
  );
  const fitting = states.filter((stage) => fits(stage, patient));
  const severities = states.flatMap((stage) => {
    const severity = contradicts(stage, patient, scope);
    return severity === undefined ? [] : [{ stage, severity }];
  });
  const factor =
    severities.length > 0
      ? Math.min(...severities.map(({ severity }) => factors[severity]))
      : fitting.length > 0
        ? factors.fit
        : 1;
  return {
    factor,
    fitting,
    contradicting: severities.map(({ stage }) => stage),
  };
}

const isMajor = (mesh: Readonly<Record<string, number>>, id: string) =>
  ((mesh[id] ?? 0) & MESH_MAJOR) !== 0;

/**
 * A paper about another cancer: a neoplasm as major topic that is none of the patient's own
 * concepts (his diagnoses, their spread) or a generic heading, while none of his diagnoses is.
 */
export function otherDisease(
  mesh: Readonly<Record<string, number>>,
  own: ReadonlySet<string>,
  diagnoses: Iterable<string>,
): boolean {
  if ([...diagnoses].some((id) => isMajor(mesh, id))) return false;
  return Object.keys(mesh).some(
    (id) =>
      NEOPLASMS.has(id) &&
      !GENERIC_NEOPLASMS.has(id) &&
      !own.has(id) &&
      isMajor(mesh, id),
  );
}

// Symptoms, complications and courses of a disease: papers on any disease have them as topics.
const SIGNS_AND_CONDITIONS = "mesh:D013568"; // Pathological Conditions, Signs and Symptoms
const signsAndConditions = new WeakMap<Terminology, ReadonlySet<string>>();

/**
 * For a patient without cancer: a paper about another disease, a disease of the terminology as
 * major topic that is neither his own concept, a broader heading of a diagnosis nor a symptom or
 * complication, while none of his diagnoses is.
 */
export function otherCondition(
  mesh: Readonly<Record<string, number>>,
  own: ReadonlySet<string>,
  diagnoses: ReadonlySet<string>,
  terms: Terminology,
): boolean {
  if ([...diagnoses].some((id) => isMajor(mesh, id))) return false;
  let signs = signsAndConditions.get(terms);
  if (!signs) {
    signs = new Set([
      SIGNS_AND_CONDITIONS,
      ...(terms.conceptOf(SIGNS_AND_CONDITIONS)?.narrower ?? []),
    ]);
    signsAndConditions.set(terms, signs);
  }
  return Object.keys(mesh).some((id) => {
    if (!isMajor(mesh, id) || own.has(id) || signs.has(id)) return false;
    const concept = terms.conceptOf(id);
    return (
      concept?.type === "disease" &&
      !concept.narrower?.some((narrower) => diagnoses.has(narrower))
    );
  });
}

/**
 * A general heading such as tumor, carcinoma or adenocarcinoma, a kind of carcinoma that names no
 * site, such as carcinoma in situ, or what a tumour does, such as lymphatic metastasis: none names a
 * disease of its own. Only for the patient's diagnoses; on a paper the curated headings of
 * neoplasms.json decide what another cancer is.
 */
export function isGenericNeoplasm(id: string): boolean {
  return GENERIC_NEOPLASMS.has(id) || HISTOLOGY.has(id) || PROCESSES.has(id);
}

/**
 * Diagnoses that name no disease of their own: "Tumor" or "Adenokarzinom" in the pathology report
 * of a prostate cancer say what kind it is, and alone they would let in papers on any cancer.
 */
export function unspecificDiagnoses(diagnoses: readonly string[]): string[] {
  return diagnoses.filter(isGenericNeoplasm);
}

/** After his treatment began: a paper about a treatment option the patient did not get. */
export function otherTreatment(
  mesh: Readonly<Record<string, number>>,
  own: ReadonlySet<string>,
  patient: PatientStage,
): boolean {
  if (!patient.localTherapy && !patient.systemicTherapy) return false;
  return ALTERNATIVES.some((id) => !own.has(id) && isMajor(mesh, id));
}
