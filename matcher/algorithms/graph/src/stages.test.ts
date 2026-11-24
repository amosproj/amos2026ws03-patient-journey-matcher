import { expect, test } from "vitest";
import { MESH_MAJOR, MESH_MINOR } from "./schema.ts";
import {
  type PatientStage,
  paperStages,
  patientStage,
  phaseConflict,
  stageCues,
  stageFactor,
} from "./stages.ts";
import { normalizeName } from "./text.ts";

const none = { diagnosed: true, localTherapy: false, systemicTherapy: false };
const factors = { fit: 2, strong: 0.1, moderate: 0.5, mild: 0.8 };

test("a paper's states come from its title or a major MeSH topic, not a minor one", () => {
  expect(
    paperStages(
      "Enzalutamide in metastatic castration-resistant prostate cancer",
      {},
    ),
  ).toEqual(new Set(["metastatic", "castration_resistant"]));
  expect(paperStages("Outcomes of active surveillance", {})).toEqual(
    new Set(["surveillance"]),
  );
  expect(paperStages("Radiotherapy for locally advanced disease", {})).toEqual(
    new Set(),
  );
  expect(
    paperStages("A cohort", { "mesh:D064129": MESH_MAJOR | MESH_MINOR }),
  ).toEqual(new Set(["castration_resistant"]));
  expect(paperStages("A cohort", { "mesh:D064129": MESH_MINOR })).toEqual(
    new Set(),
  );
});

test("negated or 'free' cues name no state", () => {
  const cues = (text: string) => stageCues(normalizeName(text));
  expect(cues("Kein Fernmetastasennachweis im PSMA-PET/CT")).toEqual(new Set());
  expect(cues("metastasis-free survival")).toEqual(new Set());
  expect(cues("Progression to castration resistance")).toEqual(
    new Set(["castration_resistant"]),
  );
  expect(cues("Multiple Knochenmetastasen")).toEqual(new Set(["metastatic"]));
});

test("a patient's states come from concepts, the states they imply and cues", () => {
  expect(patientStage(["mesh:D001859"], [], none).states).toEqual(
    new Set(["metastatic"]),
  );
  // Radium-223 is given in castration-resistant disease, which is metastatic here.
  expect(patientStage(["mesh:C000615150"], [], none).states).toEqual(
    new Set(["metastatic", "castration_resistant"]),
  );
  expect(
    patientStage([], ["hormonsensitiv", "kastrationsresistent"], none).states,
  ).toEqual(new Set(["castration_resistant", "metastatic"]));
});

const patient = (states: string[], therapy: Partial<PatientStage> = {}) =>
  ({
    ...none,
    ...therapy,
    states: new Set(states),
  }) as PatientStage;

test("one contradicting state demotes a paper as strongly as it contradicts, a fitting one promotes it", () => {
  const crpc = new Set(["metastatic", "castration_resistant"] as const);
  expect(stageFactor(crpc, patient([]), factors).factor).toBe(0.5);
  // Castration resistance is the likely next phase of a metastatic patient on hormone therapy.
  expect(stageFactor(crpc, patient(["metastatic"]), factors)).toMatchObject({
    factor: 0.8,
    contradicting: ["castration_resistant"],
  });
  expect(
    stageFactor(
      new Set(["hormone_sensitive"] as const),
      patient(["metastatic", "castration_resistant"]),
      factors,
    ).factor,
  ).toBe(0.1);
  expect(
    stageFactor(crpc, patient(["metastatic", "castration_resistant"]), factors)
      .factor,
  ).toBe(2);
  expect(stageFactor(new Set(), patient([]), factors).factor).toBe(1);
});

test("surveillance and recurrence papers depend on the patient's course", () => {
  const surveillance = new Set(["surveillance"] as const);
  expect(
    stageFactor(surveillance, patient(["surveillance"]), factors).factor,
  ).toBe(2);
  expect(
    stageFactor(
      surveillance,
      patient(["surveillance"], { localTherapy: true }),
      factors,
    ).factor,
  ).toBe(0.1);
  // A recurrence paper is context after surgery or radiotherapy, wrong before them.
  const recurrence = new Set(["recurrence"] as const);
  expect(
    stageFactor(recurrence, patient([], { localTherapy: true }), factors)
      .factor,
  ).toBe(1);
  expect(stageFactor(recurrence, patient([]), factors).factor).toBe(0.1);
  expect(
    stageFactor(
      recurrence,
      patient(["recurrence"], { localTherapy: true }),
      factors,
    ).factor,
  ).toBe(2);
});

test("localized and metastatic together span the disease and count as neither", () => {
  const both = new Set(["localized", "metastatic"] as const);
  expect(stageFactor(both, patient([]), factors).factor).toBe(1);
  expect(stageFactor(both, patient(["metastatic"]), factors).factor).toBe(1);
  expect(
    stageFactor(
      new Set(["localized"] as const),
      patient(["metastatic"]),
      factors,
    ).factor,
  ).toBe(0.1);
});

test("treatment papers wait for a treatment decision, diagnosis papers for a test", () => {
  const treatment = { "mesh:D011468": MESH_MAJOR };
  const diagnosis = { "mesh:D001706": MESH_MAJOR };
  expect(phaseConflict(treatment, patient([], { diagnosed: false }))).toBe(
    "strong",
  );
  expect(
    phaseConflict(treatment, patient([], { plannedTherapy: true })),
  ).toBeUndefined();
  expect(phaseConflict(diagnosis, patient([], { localTherapy: true }))).toBe(
    "mild",
  );
  expect(
    phaseConflict(
      diagnosis,
      patient([], { localTherapy: true, diagnosticFocus: true }),
    ),
  ).toBeUndefined();
  expect(
    phaseConflict({ "mesh:D011468": MESH_MINOR }, patient([])),
  ).toBeUndefined();
});
