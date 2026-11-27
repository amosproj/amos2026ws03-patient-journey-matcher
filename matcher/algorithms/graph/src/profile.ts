// Disease profiles: one disease's rules on top of the generic ones (graph-normalization.md#ranking)

import { lung } from "./profiles/lung.ts";
import { prostate } from "./profiles/prostate.ts";
import type { Reading } from "./reading.ts";
import { broaderDiagnosis } from "./resolve.ts";
import type {
  PatientStage,
  PhaseTopics,
  Severity,
  Stage,
  StageRow,
} from "./stages.ts";
import type { ParameterRule } from "./timeline-reader.ts";

/** Replaces the generic rule of one state for papers on the disease */
type StateRule = {
  /** Paper meant for the patient; default: he is in the state */
  fits?(patient: PatientStage): boolean;
  /** How strongly the paper is meant for another situation */
  contradicts(patient: PatientStage): Severity | undefined;
};

/** Set once the patient had the operation, or read at the end of reading */
type Flag = { operation: string } | { read(reading: Reading): boolean };

export type DiseaseProfile = {
  /** With its narrower forms (concepts.json), the disease */
  diagnosis: string;
  // reading rules: every journey, as they find the disease
  /** As in data/timeline.json */
  parameters?: Readonly<Record<string, ParameterRule>>;
  /** Parameter → test concept, in these event types, below any threshold */
  measurements?: Readonly<
    Record<string, { concept: string; events: readonly string[] }>
  >;
  /** Concept → pattern the event text needs for its `implies` (concepts.json) */
  impliesWhen?: Readonly<Record<string, string>>;
  /** Name in the evidence; procedures that show a workup, needed to infer the diagnosis */
  workup?: { name: string; procedures: readonly string[] };
  /** Name patterns of unresolved local and systemic therapies */
  therapyNames?: { local?: string; systemic?: string };
  /** Course flags its rules read; every patient has those of every profile */
  flags?: Readonly<Record<string, Flag>>;
  // ranking rules: only for a patient with the disease and papers on it
  /** Own disease states, or patterns for a general one under its id; as in data/stages.json */
  stages?: readonly StageRow[];
  /** States a concept implies for a patient with the disease */
  impliedStages?: Readonly<Record<string, readonly Stage[]>>;
  /** Per state, instead of its generic rule */
  stateRules?: Readonly<Record<Stage, StateRule>>;
  /** Phase of a paper on the disease, instead of the diagnosis qualifiers */
  phase?: PhaseTopics;
  /** Treatment options; once treated, a paper on one not given ranks lower */
  alternatives?: readonly string[];
  /** Clinical question within a state; ranks a paper up like a fitting state */
  careContext?(
    patient: PatientStage,
    paper: ReadonlySet<Stage>,
    title: string,
    mesh: Readonly<Record<string, number>>,
  ): string | undefined;
  /** Two kinds that rule each other out, with the short names of a labelled histology field */
  histology?: {
    /** In the evidence */
    name: string;
    kinds: Readonly<Record<string, readonly string[]>>;
  };
  /** Generic rules for diseases without a profile that it does without */
  skips?: readonly ("idfFloor" | "diagnosisAspect")[];
};

/** One per disease; a patient with two gets the first */
export const PROFILES: readonly DiseaseProfile[] = [prostate, lung];

/** The profile's diagnosis or a narrower form (concepts.json) */
export function isProfileDisease(profile: DiseaseProfile, id: string): boolean {
  return id === profile.diagnosis || broaderDiagnosis(id) === profile.diagnosis;
}

/** First profile whose disease is among the diagnoses */
export function profileOf(
  diagnoses: Iterable<string>,
): DiseaseProfile | undefined {
  const ids = [...diagnoses];
  return PROFILES.find((profile) =>
    ids.some((id) => isProfileDisease(profile, id)),
  );
}
