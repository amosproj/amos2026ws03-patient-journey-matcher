// Prostate cancer profile: data in data/profiles/prostate.json, here what cannot be data

import data from "../../data/profiles/prostate.json" with { type: "json" };
import type { DiseaseProfile } from "../profile.ts";
import type { PatientStage } from "../stages.ts";

const PSA = "ncbigene:354";

const advanced = ({ states }: PatientStage) =>
  states.has("metastatic") || states.has("castration_resistant");

export const prostate = {
  ...data,
  flags: {
    // salvage radiotherapy after it: own pathway (careContext)
    prostatectomy: { operation: "mesh:D011468" },
    // PSA on the focus day, cancer suspected but not confirmed
    psaWorkup: {
      read: ({ therapy, diagnoses, found }) =>
        !therapy.diagnosed &&
        diagnoses.has(data.diagnosis) &&
        found.some(({ concept, focus }) => focus && concept.id === PSA),
    },
  },
  stateRules: {
    hormone_sensitive: {
      fits: ({ states }) =>
        states.has("metastatic") && !states.has("castration_resistant"),
      contradicts: ({ states }) =>
        states.has("castration_resistant") ? "strong" : undefined,
    },
    // likely next phase of a metastatic patient on hormone therapy
    castration_resistant: {
      contradicts: ({ states }) =>
        states.has("castration_resistant")
          ? undefined
          : states.has("metastatic")
            ? "mild"
            : "moderate",
    },
    // biochemical recurrence: after local therapy, not metastatic
    recurrence: {
      contradicts: (patient) =>
        !patient.localTherapy || advanced(patient) ? "strong" : undefined,
    },
  },
  careContext(patient, paper, title, mesh) {
    // Differential diagnosis distinguishes a raised PSA from population screening.
    if (
      patient.flags.psaWorkup &&
      "mesh:D017430" in mesh &&
      "mesh:D003937" in mesh
    )
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
    if (patient.flags.prostatectomy && patient.states.has("recurrence")) {
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
  },
  // tuned before these generic rules existed
  skips: ["idfFloor", "diagnosisAspect"],
} satisfies DiseaseProfile;
