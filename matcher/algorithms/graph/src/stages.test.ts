import { normalizeName } from "@matcher/terminology";
import { expect, test } from "vitest";
import { lung } from "./profiles/lung.ts";
import { prostate } from "./profiles/prostate.ts";
import { defaultTerminology } from "./resolve.ts";
import { MESH_MAJOR, MESH_MINOR } from "./schema.ts";
import {
  isCancer,
  isGenericNeoplasm,
  otherCondition,
  otherDisease,
  otherTreatment,
  type PatientStage,
  paperStages,
  patientStage,
  phaseConflict,
  stageCues,
  stageFactor,
} from "./stages.ts";

const none = {
  diagnosed: true,
  localTherapy: false,
  systemicTherapy: false,
  flags: {},
};
const factors = { fit: 2, strong: 0.1, moderate: 0.5, mild: 0.8 };

test("a paper's states come from its title or a major MeSH topic, not a minor one", () => {
  expect(
    paperStages(
      "Enzalutamide in metastatic castration-resistant prostate cancer",
      {},
      prostate,
    ),
  ).toEqual(new Set(["metastatic", "castration_resistant"]));
  expect(paperStages("Outcomes of active surveillance", {}, prostate)).toEqual(
    new Set(["surveillance"]),
  );
  expect(
    paperStages("Radiotherapy for locally advanced disease", {}, prostate),
  ).toEqual(new Set());
  expect(
    paperStages(
      "A cohort",
      { "mesh:D064129": MESH_MAJOR | MESH_MINOR },
      prostate,
    ),
  ).toEqual(new Set(["castration_resistant"]));
  expect(
    paperStages("A cohort", { "mesh:D064129": MESH_MINOR }, prostate),
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
  expect(patientStage(["mesh:D001859"], [], none, [prostate]).states).toEqual(
    new Set(["metastatic"]),
  );
  // Radium-223 is given in castration-resistant disease, which is metastatic here.
  expect(
    patientStage(["mesh:C000615150"], [], none, [prostate]).states,
  ).toEqual(new Set(["metastatic", "castration_resistant"]));
  expect(
    patientStage([], ["hormonsensitiv", "kastrationsresistent"], none, [
      prostate,
    ]).states,
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
  expect(stageFactor(crpc, patient([]), factors, prostate).factor).toBe(0.5);
  // Castration resistance is the likely next phase of a metastatic patient on hormone therapy.
  expect(
    stageFactor(crpc, patient(["metastatic"]), factors, prostate),
  ).toMatchObject({
    factor: 0.8,
    contradicting: ["castration_resistant"],
  });
  expect(
    stageFactor(
      new Set(["hormone_sensitive"] as const),
      patient(["metastatic", "castration_resistant"]),
      factors,
      prostate,
    ).factor,
  ).toBe(0.1);
  expect(
    stageFactor(
      crpc,
      patient(["metastatic", "castration_resistant"]),
      factors,
      prostate,
    ).factor,
  ).toBe(2);
  expect(stageFactor(new Set(), patient([]), factors, prostate).factor).toBe(1);
});

test("surveillance and recurrence papers depend on the patient's course", () => {
  const surveillance = new Set(["surveillance"] as const);
  expect(
    stageFactor(surveillance, patient(["surveillance"]), factors, prostate)
      .factor,
  ).toBe(2);
  expect(
    stageFactor(
      surveillance,
      patient(["surveillance"], { localTherapy: true }),
      factors,
      prostate,
    ).factor,
  ).toBe(0.1);
  // A recurrence paper is context after surgery or radiotherapy, wrong before them.
  const recurrence = new Set(["recurrence"] as const);
  expect(
    stageFactor(
      recurrence,
      patient([], { localTherapy: true }),
      factors,
      prostate,
    ).factor,
  ).toBe(1);
  expect(stageFactor(recurrence, patient([]), factors, prostate).factor).toBe(
    0.1,
  );
  expect(
    stageFactor(
      recurrence,
      patient(["recurrence"], { localTherapy: true }),
      factors,
      prostate,
    ).factor,
  ).toBe(2);
});

test("localized and metastatic together span the disease and count as neither", () => {
  const both = new Set(["localized", "metastatic"] as const);
  expect(stageFactor(both, patient([]), factors, prostate).factor).toBe(1);
  expect(
    stageFactor(both, patient(["metastatic"]), factors, prostate).factor,
  ).toBe(1);
  expect(
    stageFactor(
      new Set(["localized"] as const),
      patient(["metastatic"]),
      factors,
      prostate,
    ).factor,
  ).toBe(0.1);
});

test("treatment papers wait for a treatment decision, diagnosis papers for a test", () => {
  const treatment = { "mesh:D011468": MESH_MAJOR };
  const diagnosis = { "mesh:D001706": MESH_MAJOR };
  expect(
    phaseConflict(treatment, patient([], { diagnosed: false }), prostate.phase),
  ).toBe("strong");
  expect(
    phaseConflict(
      treatment,
      patient([], { plannedTherapy: true }),
      prostate.phase,
    ),
  ).toBeUndefined();
  expect(
    phaseConflict(
      diagnosis,
      patient([], { localTherapy: true }),
      prostate.phase,
    ),
  ).toBe("mild");
  expect(
    phaseConflict(
      diagnosis,
      patient([], { localTherapy: true, diagnosticFocus: true }),
      prostate.phase,
    ),
  ).toBeUndefined();
  expect(
    phaseConflict({ "mesh:D011468": MESH_MINOR }, patient([]), prostate.phase),
  ).toBeUndefined();
});

test("a patient keeps the states of each of his profiles, not those of another", () => {
  // castration-resistant prostate cancer beside lung cancer
  expect(
    patientStage(["mesh:D064129"], [], none, [lung, prostate]).states,
  ).toEqual(new Set(["castration_resistant"]));
  expect(patientStage(["mesh:D064129"], [], none, [lung]).states).toEqual(
    new Set(),
  );
});

test("a profile's patterns for a general state hold only for papers on its disease", () => {
  // BCR-ABL is a leukemia gene, not a biochemical recurrence
  expect(
    paperStages("BCR-ABL inhibitors in chronic myeloid leukemia", {}),
  ).toEqual(new Set());
  const bcr = "Imaging at biochemical recurrence";
  expect(paperStages(bcr, {}).has("recurrence")).toBe(false);
  expect(paperStages(bcr, {}, prostate).has("recurrence")).toBe(true);
  expect(paperStages("Outcomes in mCRPC", {}).has("metastatic")).toBe(false);
});

test("resistance, regional nodes and a metastasis-free endpoint do not establish distant disease", () => {
  for (const title of [
    "Treatment of non-metastatic CRPC",
    "Metastasis-free survival in nmCRPC",
    "Locally advanced N1 M0 prostate cancer",
    "Regional lymph node metastases",
  ]) {
    expect(paperStages(title, {}, prostate).has("metastatic"), title).toBe(
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
    expect(paperStages(title, {}, prostate).has("metastatic"), title).toBe(
      true,
    );
    expect(stageCues(normalizeName(title)).has("metastatic"), title).toBe(true);
  }
  expect(
    patientStage(["mesh:C531550"], ["mhspc"], none, [prostate]).states,
  ).toEqual(new Set(["metastatic", "hormone_sensitive"]));
  expect(patientStage(["mesh:D064129"], [], none, [prostate]).states).toEqual(
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
  expect(otherTreatment(brachy, own, treated, prostate.alternatives)).toBe(
    true,
  );
  expect(
    otherTreatment(
      brachy,
      new Set([...own, "mesh:D001918"]),
      treated,
      prostate.alternatives,
    ),
  ).toBe(false);
});

test("without cancer, another disease as major topic makes a paper about another disease", () => {
  const type2 = "mesh:D003924";
  const other = (mesh: Record<string, number>) =>
    otherCondition(
      mesh,
      new Set([type2]),
      new Set([type2]),
      defaultTerminology,
    );
  const asthma = "mesh:D001249";
  expect(other({ [asthma]: MESH_MAJOR })).toBe(true);
  expect(other({ [asthma]: MESH_MINOR })).toBe(false);
  expect(other({ [asthma]: MESH_MAJOR, [type2]: MESH_MAJOR })).toBe(false);
  // Diabetes in general includes type 2; fatigue comes with any disease.
  expect(other({ "mesh:D003920": MESH_MAJOR })).toBe(false);
  expect(other({ "mesh:D005221": MESH_MAJOR })).toBe(false);
});

test("surveillance follow-up needs evidence of monitoring or treatment decisions", () => {
  const active = patient(["surveillance"]);
  const surveillance = paperStages("Active surveillance", {}, prostate);
  const outcome = { "mesh:D005500": MESH_MINOR, "mesh:D016896": MESH_MINOR };
  const title = "Conversion to active treatment during active surveillance";
  expect(prostate.careContext(active, surveillance, title, {})).toBe(
    "surveillance follow-up",
  );
  expect(prostate.careContext(active, surveillance, "Outcomes", outcome)).toBe(
    "surveillance follow-up",
  );
  expect(
    prostate.careContext(active, surveillance, "Biopsy technique", {}),
  ).toBeUndefined();
  expect(
    prostate.careContext(
      { ...active, diagnosticFocus: true },
      surveillance,
      title,
      outcome,
    ),
  ).toBeUndefined();
  expect(
    prostate.careContext(
      { ...active, localTherapy: true },
      surveillance,
      title,
      outcome,
    ),
  ).toBeUndefined();
  expect(
    prostate.careContext(active, new Set(), title, outcome),
  ).toBeUndefined();
});

test("salvage radiotherapy after surgery is a different pathway from salvage prostatectomy", () => {
  const recurrent = patient(["recurrence"], {
    localTherapy: true,
    flags: { prostatectomy: true },
  });
  const papers = paperStages("", {}, prostate);
  const after = "Salvage radiotherapy following radical prostatectomy";
  expect(
    prostate.careContext(
      recurrent,
      papers,
      "Salvage radiation prior to radical prostatectomy",
      {},
    ),
  ).toBeUndefined();
  expect(prostate.careContext(recurrent, papers, after, {})).toBe(
    "postoperative salvage radiotherapy",
  );
  expect(
    prostate.careContext(
      { ...recurrent, flags: { prostatectomy: false } },
      papers,
      after,
      {},
    ),
  ).toBeUndefined();
  expect(
    prostate.careContext(
      recurrent,
      papers,
      "Salvage prostatectomy after radiotherapy",
      {},
    ),
  ).toBeUndefined();
  expect(
    prostate.careContext(
      recurrent,
      papers,
      "Salvage radiotherapy after primary radiotherapy",
      {},
    ),
  ).toBeUndefined();
});

test("another cancer has the states every cancer has, not those of prostate cancer", () => {
  const states = (title: string, mesh = {}) => paperStages(title, mesh);
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
  expect(stageFactor(recurrence, metastatic, factors).factor).toBe(1);
  expect(stageFactor(recurrence, metastatic, factors, prostate).factor).toBe(
    0.1,
  );
  expect(stageFactor(recurrence, patient([]), factors).factor).toBe(0.1);
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

test("a kind of carcinoma names no disease, a melanoma does", () => {
  expect(isGenericNeoplasm("mesh:D002278")).toBe(true); // carcinoma in situ
  expect(isGenericNeoplasm("mesh:D002295")).toBe(true); // transitional cell carcinoma
  expect(isCancer("mesh:D002278")).toBe(false);
  expect(isGenericNeoplasm("mesh:D008545")).toBe(false); // melanoma
  expect(isCancer("mesh:D008545")).toBe(true);
  expect(isGenericNeoplasm("mesh:D002292")).toBe(false); // renal cell carcinoma
});

test("what a tumour does names no disease, a cancer of unknown primary does", () => {
  expect(isGenericNeoplasm("mesh:D008207")).toBe(true); // lymphatic metastasis
  expect(isCancer("mesh:D061206")).toBe(false); // micrometastasis
  expect(isCancer("mesh:D009382")).toBe(true); // unknown primary
});
