import { expect, test } from "vitest";
import { MESH_MAJOR, MESH_MINOR } from "./schema.ts";
import {
  careContext,
  otherDisease,
  otherTreatment,
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
      "prostate",
    ),
  ).toEqual(new Set(["metastatic", "castration_resistant"]));
  expect(
    paperStages("Outcomes of active surveillance", {}, "prostate"),
  ).toEqual(new Set(["surveillance"]));
  expect(
    paperStages("Radiotherapy for locally advanced disease", {}, "prostate"),
  ).toEqual(new Set());
  expect(
    paperStages(
      "A cohort",
      { "mesh:D064129": MESH_MAJOR | MESH_MINOR },
      "prostate",
    ),
  ).toEqual(new Set(["castration_resistant"]));
  expect(
    paperStages("A cohort", { "mesh:D064129": MESH_MINOR }, "prostate"),
  ).toEqual(new Set());
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
  ).toEqual(new Set(["castration_resistant"]));
});

const patient = (states: string[], therapy: Partial<PatientStage> = {}) =>
  ({
    ...none,
    ...therapy,
    states: new Set(states),
  }) as PatientStage;

test("one contradicting state demotes a paper as strongly as it contradicts, a fitting one promotes it", () => {
  const crpc = new Set(["metastatic", "castration_resistant"] as const);
  expect(stageFactor(crpc, patient([]), factors, "prostate").factor).toBe(0.5);
  // Castration resistance is the likely next phase of a metastatic patient on hormone therapy.
  expect(
    stageFactor(crpc, patient(["metastatic"]), factors, "prostate"),
  ).toMatchObject({
    factor: 0.8,
    contradicting: ["castration_resistant"],
  });
  expect(
    stageFactor(
      new Set(["hormone_sensitive"] as const),
      patient(["metastatic", "castration_resistant"]),
      factors,
      "prostate",
    ).factor,
  ).toBe(0.1);
  expect(
    stageFactor(
      crpc,
      patient(["metastatic", "castration_resistant"]),
      factors,
      "prostate",
    ).factor,
  ).toBe(2);
  expect(stageFactor(new Set(), patient([]), factors, "prostate").factor).toBe(
    1,
  );
});

test("surveillance and recurrence papers depend on the patient's course", () => {
  const surveillance = new Set(["surveillance"] as const);
  expect(
    stageFactor(surveillance, patient(["surveillance"]), factors, "prostate")
      .factor,
  ).toBe(2);
  expect(
    stageFactor(
      surveillance,
      patient(["surveillance"], { localTherapy: true }),
      factors,
      "prostate",
    ).factor,
  ).toBe(0.1);
  // A recurrence paper is context after surgery or radiotherapy, wrong before them.
  const recurrence = new Set(["recurrence"] as const);
  expect(
    stageFactor(
      recurrence,
      patient([], { localTherapy: true }),
      factors,
      "prostate",
    ).factor,
  ).toBe(1);
  expect(stageFactor(recurrence, patient([]), factors, "prostate").factor).toBe(
    0.1,
  );
  expect(
    stageFactor(
      recurrence,
      patient(["recurrence"], { localTherapy: true }),
      factors,
      "prostate",
    ).factor,
  ).toBe(2);
});

test("localized and metastatic together span the disease and count as neither", () => {
  const both = new Set(["localized", "metastatic"] as const);
  expect(stageFactor(both, patient([]), factors, "prostate").factor).toBe(1);
  expect(
    stageFactor(both, patient(["metastatic"]), factors, "prostate").factor,
  ).toBe(1);
  expect(
    stageFactor(
      new Set(["localized"] as const),
      patient(["metastatic"]),
      factors,
      "prostate",
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

test("resistance, regional nodes and a metastasis-free endpoint do not establish distant disease", () => {
  for (const title of [
    "Treatment of non-metastatic CRPC",
    "Metastasis-free survival in nmCRPC",
    "Locally advanced N1 M0 prostate cancer",
    "Regional lymph node metastases",
  ]) {
    expect(paperStages(title, {}, "prostate").has("metastatic"), title).toBe(
      false,
    );
    expect(stageCues(normalizeName(title)).has("metastatic"), title).toBe(
      false,
    );
  }
  for (const title of [
    "Outcomes in mCRPC",
    "Distant nodal disease (M1a)",
    "Bone metastases",
  ]) {
    expect(paperStages(title, {}, "prostate").has("metastatic"), title).toBe(
      true,
    );
    expect(stageCues(normalizeName(title)).has("metastatic"), title).toBe(true);
  }
  expect(patientStage(["mesh:C531550"], ["mhspc"], none).states).toEqual(
    new Set(["metastatic", "hormone_sensitive"]),
  );
  expect(patientStage(["mesh:D064129"], [], none).states).toEqual(
    new Set(["castration_resistant"]),
  );
});

test("a patient's own neoplasm and treatment are exempt from alternative-topic penalties", () => {
  const cancer = "mesh:D011471";
  const ovarian = "mesh:D010051";
  const bone = "mesh:D001859";
  const own = new Set([cancer, bone, "mesh:D011878"]);
  expect(
    otherDisease({ [ovarian]: MESH_MAJOR, [cancer]: MESH_MAJOR }, own, [
      cancer,
    ]),
  ).toBe(false);
  expect(
    otherDisease({ [bone]: MESH_MAJOR, "mesh:D014565": MESH_MAJOR }, own, [
      cancer,
    ]),
  ).toBe(false);
  const brachy = { "mesh:D001918": MESH_MAJOR };
  const treated = patient([], { localTherapy: true });
  expect(otherTreatment(brachy, own, treated)).toBe(true);
  expect(
    otherTreatment(brachy, new Set([...own, "mesh:D001918"]), treated),
  ).toBe(false);
});

test("surveillance follow-up needs evidence of monitoring or treatment decisions", () => {
  const active = patient(["surveillance"]);
  const surveillance = paperStages("Active surveillance", {}, "prostate");
  const outcome = { "mesh:D005500": MESH_MINOR, "mesh:D016896": MESH_MINOR };
  const title = "Conversion to active treatment during active surveillance";
  expect(careContext(active, surveillance, title, {})).toBe(
    "surveillance follow-up",
  );
  expect(careContext(active, surveillance, "Outcomes", outcome)).toBe(
    "surveillance follow-up",
  );
  expect(
    careContext(active, surveillance, "Biopsy technique", {}),
  ).toBeUndefined();
  expect(
    careContext(
      { ...active, diagnosticFocus: true },
      surveillance,
      title,
      outcome,
    ),
  ).toBeUndefined();
  expect(
    careContext(
      { ...active, localTherapy: true },
      surveillance,
      title,
      outcome,
    ),
  ).toBeUndefined();
  expect(careContext(active, new Set(), title, outcome)).toBeUndefined();
});

test("salvage radiotherapy after surgery is a different pathway from salvage prostatectomy", () => {
  const recurrent = patient(["recurrence"], {
    localTherapy: true,
    prostatectomy: true,
  });
  const papers = paperStages("", {}, "prostate");
  const after = "Salvage radiotherapy following radical prostatectomy";
  expect(
    careContext(
      recurrent,
      papers,
      "Salvage radiation prior to radical prostatectomy",
      {},
    ),
  ).toBeUndefined();
  expect(careContext(recurrent, papers, after, {})).toBe(
    "postoperative salvage radiotherapy",
  );
  expect(
    careContext({ ...recurrent, prostatectomy: false }, papers, after, {}),
  ).toBeUndefined();
  expect(
    careContext(
      recurrent,
      papers,
      "Salvage prostatectomy after radiotherapy",
      {},
    ),
  ).toBeUndefined();
  expect(
    careContext(
      recurrent,
      papers,
      "Salvage radiotherapy after primary radiotherapy",
      {},
    ),
  ).toBeUndefined();
});

test("another cancer has the states every cancer has, not those of prostate cancer", () => {
  const states = (title: string, mesh = {}) =>
    paperStages(title, mesh, "cancer");
  expect(states("Hormone-sensitive breast cancer")).toEqual(new Set());
  expect(
    states("Olaparib in platinum-sensitive relapsed ovarian cancer"),
  ).toEqual(new Set(["recurrence"]));
  expect(states("Adjuvant letrozole in early breast cancer")).toEqual(
    new Set(["localized"]),
  );
  expect(states("Primary chemotherapy in operable breast cancer")).toEqual(
    new Set(["localized"]),
  );
  expect(states("Unresectable or non-operable disease")).toEqual(new Set());
});

test("a relapse of another cancer can be metastatic and follows any treatment", () => {
  const recurrence = new Set(["recurrence"] as const);
  const metastatic = patient(["metastatic"], { systemicTherapy: true });
  expect(stageFactor(recurrence, metastatic, factors, "cancer").factor).toBe(1);
  expect(stageFactor(recurrence, metastatic, factors, "prostate").factor).toBe(
    0.1,
  );
  expect(stageFactor(recurrence, patient([]), factors, "cancer").factor).toBe(
    0.1,
  );
});

test("for any disease the qualifiers of the diagnosis and the kind of a procedure give a paper's phase", () => {
  const breast = new Set(["mesh:D001943"]);
  const surgery = { "mesh:D001943Q000601": MESH_MAJOR };
  const imaging = { "mesh:D008327": MESH_MAJOR };
  const suspected = patient([], { diagnosed: false });
  expect(phaseConflict(surgery, suspected, breast)).toBe("strong");
  // Treatment papers fit a confirmed diagnosis, even before a decision.
  expect(phaseConflict(surgery, patient([]), breast)).toBeUndefined();
  expect(phaseConflict({ "mesh:D008408": MESH_MAJOR }, suspected, breast)).toBe(
    "strong",
  );
  // The qualifiers of another disease say nothing about the patient's phase.
  expect(
    phaseConflict({ "mesh:D008175Q000601": MESH_MAJOR }, suspected, breast),
  ).toBeUndefined();
  expect(
    phaseConflict(imaging, patient([], { localTherapy: true }), breast),
  ).toBe("mild");
  expect(
    phaseConflict(
      { "mesh:D001943Q000000981": MESH_MAJOR },
      patient([], { systemicTherapy: true }),
      breast,
    ),
  ).toBe("mild");
  // Treatment outweighs diagnosis, as for prostate cancer.
  expect(phaseConflict({ ...imaging, ...surgery }, suspected, breast)).toBe(
    "strong",
  );
});

test("German compounds name distant spread to the brain, lung and peritoneum", () => {
  const cues = (text: string) => stageCues(normalizeName(text));
  expect(cues("Neu aufgetretene Hirnmetastasen")).toEqual(
    new Set(["metastatic"]),
  );
  expect(cues("Keine Lungenmetastasen")).toEqual(new Set());
});

test("recurring complaints are no relapse of the disease", () => {
  const cues = (text: string) => stageCues(normalizeName(text));
  expect(cues("Rezidivierender peranaler Blutabgang")).toEqual(new Set());
  expect(cues("Lokalrezidiv im Becken")).toEqual(new Set(["recurrence"]));
  expect(cues("PSA-Anstieg – Biochemisches Rezidiv")).toEqual(
    new Set(["recurrence"]),
  );
});
