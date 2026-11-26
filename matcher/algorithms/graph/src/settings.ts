import type { MatchOptions } from "@matcher/core";
import { DEFAULT_WEIGHTS, type QueryWeights } from "./query.ts";

// Ranking constants; `tuning` sets others within min..max (`explain`, benchmark).
const SETTINGS = {
  // How strongly a paper has a concept; the strongest evidence counts.
  title: { value: 1, min: 0, max: 5, whole: false }, // PubTator3 found it in the title
  major: { value: 1, min: 0, max: 5, whole: false }, // a MeSH major topic
  substance: { value: 0.7, min: 0, max: 5, whole: false }, // the chemical list
  minor: { value: 0.5, min: 0, max: 5, whole: false }, // another MeSH heading
  text: { value: 0.4, min: 0, max: 5, whole: false }, // PubTator3, abstract only
  // What a concept is worth for the patient, by its role.
  diagnosis: {
    value: DEFAULT_WEIGHTS.roles.diagnosis,
    min: 0,
    max: 20,
    whole: false,
  },
  stage: { value: DEFAULT_WEIGHTS.roles.stage, min: 0, max: 20, whole: false },
  drug: { value: DEFAULT_WEIGHTS.roles.drug, min: 0, max: 20, whole: false },
  procedure: {
    value: DEFAULT_WEIGHTS.roles.procedure,
    min: 0,
    max: 20,
    whole: false,
  },
  test: { value: DEFAULT_WEIGHTS.roles.test, min: 0, max: 20, whole: false },
  gene: { value: DEFAULT_WEIGHTS.roles.gene, min: 0, max: 20, whole: false },
  finding: {
    value: DEFAULT_WEIGHTS.roles.finding,
    min: 0,
    max: 20,
    whole: false,
  },
  symptom: {
    value: DEFAULT_WEIGHTS.roles.symptom,
    min: 0,
    max: 20,
    whole: false,
  },
  focus: { value: DEFAULT_WEIGHTS.focus, min: 1, max: 20, whole: false },
  broader: { value: DEFAULT_WEIGHTS.broader, min: 0, max: 1, whole: false },
  aspect: { value: DEFAULT_WEIGHTS.aspect, min: 0, max: 5, whole: false },
  // Share of the focus factor for a measurement of the focus day (PSA), which recurs.
  measurement: {
    value: DEFAULT_WEIGHTS.measurement,
    min: 0,
    max: 1,
    whole: false,
  },
  // 1: disease-state cues also from the sentences of the statements, 0: names only.
  sentences: { value: 1, min: 0, max: 1, whole: true },
  // The patient's drug linked to his diagnosis by PubTator3, as a share of the drug's worth.
  relation: { value: 0.5, min: 0, max: 5, whole: false },
  // How much a paper loses when the diagnosis is not its main topic (only in the abstract).
  mainTopic: { value: 0.5, min: 0, max: 1, whole: false },
  // A paper about the patient's disease state, or about a state or phase he is not in; how
  // strongly it contradicts his (stages.ts) picks the factor.
  stageFit: { value: 1.3, min: 1, max: 5, whole: false },
  conflictStrong: { value: 0.15, min: 0, max: 1, whole: false },
  conflictModerate: { value: 0.4, min: 0, max: 1, whole: false },
  conflictMild: { value: 0.7, min: 0, max: 1, whole: false },
  // Lab or animal research without patients (MeSH), which can only be generic for him.
  research: { value: 0.25, min: 0, max: 1, whole: false },
  // A paper only on the other sex (MeSH check tags), e.g. women for prostate cancer.
  population: { value: 0.25, min: 0, max: 1, whole: false },
  // A paper about another cancer (major MeSH topic), or about a treatment option he did not get.
  otherDisease: { value: 0.15, min: 0, max: 1, whole: false },
  // Without cancer: another disease as major MeSH topic. Milder, so another cancer stays below it.
  otherCondition: { value: 0.5, min: 0, max: 1, whole: false },
  otherTreatment: { value: 0.7, min: 0, max: 1, whole: false },
  // How much the publication type counts (guidelines and reviews up, case reports down).
  format: { value: 1, min: 0, max: 3, whole: false },
  // Papers re-ranked after the concept score.
  candidates: { value: 300, min: 1, max: 5000, whole: true },
  // Papers naming a diagnosis that are scored at most, the newest first: bounds the work for
  // very common diagnoses in a large corpus.
  pool: { value: 50_000, min: 1, max: 1_000_000, whole: true },
};
type Setting = keyof typeof SETTINGS;
export type Values = Record<Setting, number>;

export function settings(tuning: MatchOptions["tuning"] = {}): Values {
  const names = Object.keys(SETTINGS) as Setting[];
  const values = Object.fromEntries(
    names.map((name) => [name, tuning[name] ?? SETTINGS[name].value]),
  ) as Values;
  for (const name of names) {
    const { min, max, whole } = SETTINGS[name];
    const value = values[name];
    if (
      !(value >= min && value <= max && (!whole || Number.isInteger(value)))
    ) {
      throw new RangeError(
        `${name} must be a ${whole ? "whole " : ""}number from ${min} to ${max}, not ${value}`,
      );
    }
  }
  return values;
}

export function queryWeights(values: Values): QueryWeights {
  const { roles } = DEFAULT_WEIGHTS;
  return {
    roles: Object.fromEntries(
      Object.keys(roles).map((role) => [
        role,
        role in values
          ? values[role as Setting]
          : roles[role as keyof typeof roles],
      ]),
    ) as QueryWeights["roles"],
    focus: values.focus,
    broader: values.broader,
    aspect: values.aspect,
    sentences: values.sentences === 1,
    measurement: values.measurement,
  };
}
