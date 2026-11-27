import { readFileSync } from "node:fs";
import type { JourneyState } from "@matcher/core";
import { expect, test } from "vitest";
import { prostate } from "./profiles/prostate.ts";
import { patientQuery } from "./query.ts";

const cancer = "mesh:D011471";
const crpc = "mesh:D064129";
const drug = "mesh:C531550";
const liver = "mesh:D008113";
const date = "2026-12-08";
const focus = { id: date, date, label: "follow-up", type: "facts" };

const conceptOf = (query: ReturnType<typeof patientQuery>, id: string) =>
  query.concepts.find((concept) => concept.ids[0] === id);

test("only active evidence of distant spread contributes to the timeline stage", () => {
  const dx = {
    ...focus,
    type: "diagnosis",
    label: "Confirmed prostate cancer.",
    date: "2026-01-01",
  };
  const imaging = (date: string, label: string, parameters = {}) => ({
    id: date,
    date,
    type: "imaging",
    label,
    parameters,
  });
  const suspect = imaging("2026-01-02", "Suspected bone metastases.");
  const confirmed = imaging("2026-01-03", "Bone metastases confirmed.");
  const retracted = imaging("2026-01-05", "Bone metastases ruled out.");
  const scan = (...events: ReturnType<typeof imaging>[]) =>
    patientQuery({
      context: [dx, ...events.slice(0, -1)],
      focus: events[events.length - 1],
    });
  expect(scan(suspect).stage.states.has("metastatic")).toBe(false);
  expect(
    scan(
      imaging("2026-01-02", "Staging", {
        diagnosis: "Bone metastases",
        diagnosis_status: "suspected",
      }),
    ).stage.states.has("metastatic"),
  ).toBe(false);
  expect(scan(suspect, confirmed).stage.states.has("metastatic")).toBe(true);
  const after = scan(suspect, confirmed, retracted);
  expect(after.stage.states.has("metastatic")).toBe(false);
  expect(conceptOf(after, "mesh:D001859")).toBeUndefined();
  const independent = imaging("2026-01-04", "Staging", { liver_mets: true });
  expect(
    scan(confirmed, independent, retracted).stage.states.has("metastatic"),
  ).toBe(true);
  expect(
    scan(
      confirmed,
      independent,
      retracted,
      imaging("2026-01-06", "Staging", { liver_mets: false }),
    ).stage.states.has("metastatic"),
  ).toBe(false);
  expect(
    scan(confirmed, independent, imaging("2026-01-06", "M0 local recurrence"))
      .stage.states,
  ).toEqual(new Set(["recurrence"]));
  expect(
    scan(suspect, retracted, {
      ...confirmed,
      date: "2026-01-07",
    }).stage.states.has("metastatic"),
  ).toBe(true);
});

test.each([
  ["Confirmed breast cancer.", { icd_code: "C34" }],
  ["Confirmed breast cancer (C34).", {}],
  ["Breast cancer ruled out.", { icd_code: "C34" }],
  ["Confirmed C50.", { icd_code: "C34" }],
])(
  "inconsistent diagnosis and ICD evidence in %s contributes no concepts",
  (label, parameters) => {
    const q = patientQuery({
      context: [],
      focus: { ...focus, type: "diagnosis", label, parameters },
    });
    expect(q.concepts).toEqual([]);
    expect(q.diagnoses.size).toBe(0);
    expect(q.evidence).toContainEqual(
      expect.objectContaining({
        detail: "Diagnostic name and ICD code disagree",
      }),
    );
    const compatible = patientQuery({
      context: [],
      focus: {
        ...focus,
        type: "diagnosis",
        label: "Confirmed small cell lung cancer.",
        parameters: { icd_code: "C34" },
      },
    });
    expect(compatible.histology?.observed).toBe("mesh:D055752");
  },
);

test("family relationships and accompaniment keep the diagnosis with its subject", () => {
  const dx = (label: string, parameters = {}) =>
    patientQuery({
      context: [],
      focus: { ...focus, type: "diagnosis", label, parameters },
    });
  expect(
    dx("Grandmother had breast cancer.", { icd_code: "C50" }).diagnoses.size,
  ).toBe(0);
  expect(
    dx(
      "Mother accompanied the patient for the confirmed breast cancer diagnosis.",
      { icd_code: "C50" },
    ).stage.diagnosed,
  ).toBe(true);
  const mixed = dx(
    "Grandfather had prostate cancer; patient referred for staging.",
    { diagnosis: "Breast cancer", icd_code: "C50" },
  );
  expect(mixed.diagnoses.has("mesh:D001943")).toBe(true);
  expect(mixed.diagnoses.has(cancer)).toBe(false);
});

test("a plan and its cancellation can name the same indication by label and code", () => {
  const plan = {
    ...focus,
    type: "treatment_decision",
    id: "plan",
    date: "2026-01-01",
    label: "Olaparib planned.",
    parameters: { drug: "Olaparib", indication: "Breast cancer (C50)" },
  };
  const cancel = {
    ...plan,
    id: "cancel",
    date: "2026-01-02",
    label: "Olaparib cancelled.",
    parameters: { drug: "Olaparib", indication: "C50" },
  };
  const q = patientQuery({
    context: [
      { ...focus, type: "diagnosis", date: plan.date, label: "Confirmed C50." },
      plan,
    ],
    focus: cancel,
  });
  expect(q.stage.plannedTherapy).toBe(false);
  expect(conceptOf(q, drug)).toBeUndefined();
});

test("a timeline names concepts in its labels and text parameters", () => {
  const query = patientQuery({
    context: [
      {
        id: "e1",
        date: "2026-01-01",
        type: "diagnosis",
        label: "Prostatakarzinom",
      },
      {
        id: "e2",
        date: "2026-02-01",
        type: "surgery",
        label: "Radikale Prostatektomie",
      },
    ],
    focus: {
      id: "e3",
      date,
      type: "systemic_therapy",
      label: "Begleitende ADT",
      parameters: { drug: "Leuprorelin 3-Monats-Depot", duration_months: 6 },
    },
  });
  expect(query.diagnoses.has(cancer)).toBe(true);
  expect(conceptOf(query, "mesh:D011468")).toMatchObject({ focus: false });
  expect(conceptOf(query, "mesh:D016729")).toMatchObject({
    role: "drug",
    focus: true,
  });
  expect(query.treatments.has("mesh:D016729")).toBe(true);
  expect(query.stage).toMatchObject({
    localTherapy: true,
    systemicTherapy: true,
  });
});

test("later timeline statements update the named patient diagnosis only", () => {
  const context = [
    {
      ...focus,
      date: "2026-01-01",
      type: "diagnosis",
      label: "Prostatakarzinom",
    },
    {
      ...focus,
      date: "2026-01-02",
      type: "followup",
      label: "Discharge",
      parameters: { diagnosis: "Liver metastases" },
    },
  ];
  const followup = {
    ...focus,
    type: "followup",
    label: "Prostate cancer was ruled out.",
  };
  const query = patientQuery({ context, focus: followup });
  // Liver metastases stay, as a disease state; without a diagnosis no paper is a candidate.
  expect(query.diagnoses.size).toBe(0);
  expect(conceptOf(query, liver)?.role).toBe("stage");
  expect(query.stage.states.has("metastatic")).toBe(true);
  const later = {
    ...followup,
    date: "2027-01-01",
    label: "Prostatakarzinom confirmed.",
  };
  expect(
    patientQuery({
      context: [...context, followup],
      focus: later,
    }).diagnoses.has(cancer),
  ).toBe(true);
});

test("a code can identify a diagnosis and carry its negation", () => {
  const first = {
    ...focus,
    type: "diagnosis",
    label: "C61",
    date: "2026-01-01",
  };
  expect(
    patientQuery({ context: [], focus: first }).diagnoses.has(cancer),
  ).toBe(true);
  const update = {
    ...focus,
    type: "followup",
    parameters: { icd_code: "C61" },
    label: "C61 ruled out.",
  };
  expect(patientQuery({ context: [first], focus: update }).diagnoses.size).toBe(
    0,
  );
  const named = { ...first, label: "Prostatakarzinom", date };
  const note = { ...focus, type: "followup", label: "C61 ruled out." };
  expect(patientQuery({ context: [named], focus: note }).diagnoses.size).toBe(
    0,
  );
  expect(patientQuery({ context: [note], focus: named }).diagnoses.size).toBe(
    0,
  );
});

test("family history cannot establish or remove a patient's diagnosis", () => {
  const family = {
    ...focus,
    type: "family_history",
    label: "Prostate cancer",
    parameters: { icd_code: "C61" },
  };
  expect(patientQuery({ context: [], focus: family }).diagnoses.size).toBe(0);
  expect(
    patientQuery({
      context: [],
      focus: { ...focus, type: "screening", label: "Prostatakarzinom" },
    }).diagnoses.size,
  ).toBe(0);
  const prior = {
    ...focus,
    type: "diagnosis",
    label: "Prostatakarzinom",
    date: "2026-01-01",
  };
  expect(
    patientQuery({
      context: [prior],
      focus: { ...family, label: "Prostate cancer was ruled out." },
    }).diagnoses.has(cancer),
  ).toBe(true);
});

test("extracts mapped diagnoses from real synthetic timeline.json phrases", () => {
  const queryFor = (patient: string) => {
    const { events } = JSON.parse(
      readFileSync(
        new URL(
          `../../../../patientdata/${patient}/timeline.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    return patientQuery({ focus: events.at(-1), context: events.slice(0, -1) });
  };
  expect(queryFor("Patient-5").diagnoses.has(cancer)).toBe(true);
  expect(queryFor("Patient-7").diagnoses.has(crpc)).toBe(true);
  expect(conceptOf(queryFor("Patient-8"), cancer)?.role).toBe("diagnosis");
  expect(queryFor("Patient-10").diagnoses.has(crpc)).toBe(true);
});

test("the synthetic timelines reach the states of their course", () => {
  const stageAt = (patient: string, date: string) => {
    const { events } = JSON.parse(
      readFileSync(
        new URL(
          `../../../../patientdata/${patient}/timeline.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { events: JourneyState["context"] };
    const past = events.filter((event) => event.date <= date);
    const { stage } = patientQuery({
      focus: past[past.length - 1],
      context: past.slice(0, -1),
    });
    return { ...stage, ...stage.flags, states: [...stage.states] };
  };
  // Patient-1: the tumor board decides on active surveillance on 2027-01-23.
  expect(stageAt("Patient-1", "2027-01-09").states).toEqual([]);
  for (const followUp of ["2027-01-27", "2027-04-27", "2029-05-15"])
    expect(stageAt("Patient-1", followUp)).toMatchObject({
      states: ["surveillance"],
      diagnosed: true,
      localTherapy: false,
      psaWorkup: false,
    });
  // Patient-5: prostatectomy in January 2027, a discharge letter that names the cancer without
  // a word like "confirmed", and a recurrence in December 2028.
  expect(stageAt("Patient-5", "2027-02-01")).toMatchObject({
    states: [],
    diagnosed: true,
    prostatectomy: true,
    psaWorkup: false,
  });
  expect(stageAt("Patient-5", "2029-12-31")).toMatchObject({
    states: ["recurrence"],
    diagnosed: true,
    prostatectomy: true,
    psaWorkup: false,
  });
});

test("a family history, department or general treatment decision supplies no patient diagnosis", () => {
  const family = {
    ...focus,
    type: "family_history",
    label: "Vater mit mCRPC, Lebermetastasen, Abirateron",
  };
  const board = {
    ...focus,
    type: "tumor_board",
    label: "Tumorkonferenz",
    parameters: {
      participants: ["Strahlentherapie"],
      decision: "chemotherapy",
      pt_stage: "pT2",
    },
  };
  const q = patientQuery({ context: [family], focus: board });
  expect(q.diagnoses.size).toBe(0);
  expect(q.stage.states.size).toBe(0);
  expect(q.stage.plannedTherapy).toBe(true);
  expect(q.stage.localTherapy).toBe(false);
  expect(conceptOf(q, "mesh:D011878")).toBeUndefined();
  expect(conceptOf(q, liver)).toBeUndefined();
});

test("negative staging and a ruled-out diagnosis override weaker timeline evidence", () => {
  const referral = {
    ...focus,
    date: "2026-12-01",
    type: "referral",
    label: "PSA",
    parameters: { psa_value: 8 },
  };
  expect(
    patientQuery({ context: [], focus: referral }).diagnoses.get(cancer),
  ).toBe(0.45);
  const review = {
    ...focus,
    type: "followup",
    label: "Prostate cancer ruled out.",
    parameters: { finding: "Kein Nachweis von Fernmetastasen" },
  };
  const q = patientQuery({ context: [referral], focus: review });
  expect(q.diagnoses.size).toBe(0);
  expect(q.stage.states.has("metastatic")).toBe(false);
  expect(conceptOf(q, "mesh:D009362")).toBeUndefined();
});

test("an M0 local recurrence retains its stage while affirmative site flags support distant spread", () => {
  const q = (label: string, parameters = {}) =>
    patientQuery({
      context: [],
      focus: { ...focus, type: "staging_workup", label, parameters },
    });
  expect(
    q("Lokalrezidiv in der Prostataloge, keine Fernmetastasen").stage.states,
  ).toEqual(new Set(["recurrence"]));
  expect(
    q("Staging", { bone_mets: false, lymph_node_mets: true }).stage.states,
  ).toEqual(new Set());
  expect(q("Staging", { bone_mets: true }).stage.states).toEqual(
    new Set(["metastatic"]),
  );
});

test("a numeric follow-up PSA is searchable below the referral threshold", () => {
  const q = patientQuery({
    context: [],
    focus: { ...focus, type: "followup", parameters: { psa_value: 0.02 } },
  });
  expect(q.diagnoses.size).toBe(0);
  expect(conceptOf(q, "ncbigene:354")?.focus).toBe(true);
});

test("only explicit treatment and finding links bind their diagnosis in a mixed journey", () => {
  const breast = "mesh:D001943";
  const lung = "mesh:D008175";
  const context = [
    { ...focus, id: "b", type: "diagnosis", label: "Confirmed breast cancer." },
    { ...focus, id: "l", type: "diagnosis", label: "Confirmed lung cancer." },
  ];
  const event = {
    ...focus,
    type: "systemic_therapy",
    label: "Olaparib given. Lung cancer reviewed.",
    parameters: { drug: "Olaparib" },
  };
  const ambiguous = patientQuery({ context, focus: event });
  expect(ambiguous.diagnoses.has(breast)).toBe(true);
  expect(ambiguous.diagnoses.has(lung)).toBe(true);
  expect(ambiguous.relations.size).toBe(0);
  expect(ambiguous.evidence).toContainEqual(
    expect.objectContaining({
      concept: drug,
      detail: "No active explicit treatment indication",
    }),
  );

  const finding = {
    ...focus,
    type: "lab_test",
    label: "BRCA2 tested",
    parameters: { test: "BRCA2", indicates: "C50" },
  };
  const linked = patientQuery({
    context: [...context, finding],
    focus: { ...event, parameters: { ...event.parameters, indication: "C50" } },
  });
  expect(conceptOf(linked, drug)?.diagnoses).toContain(breast);
  expect(conceptOf(linked, drug)?.diagnoses).not.toContain(lung);
  expect(conceptOf(linked, "ncbigene:675")?.diagnoses).toContain(breast);
  expect(linked.relations.has(JSON.stringify([drug, "treats", breast]))).toBe(
    true,
  );
  expect(linked.relations.has(JSON.stringify([drug, "treats", lung]))).toBe(
    false,
  );
});

test("planning or cancelling a treatment does not record it as given", () => {
  const context = [
    { ...focus, type: "diagnosis", label: "Confirmed breast cancer" },
  ];
  for (const [label, type] of [
    ["Olaparib planned.", "systemic_therapy"],
    ["Olaparib cancelled.", "systemic_therapy"],
    ["Confirmed Olaparib was not started.", "treatment_decision"],
  ]) {
    const query = patientQuery({
      context,
      focus: {
        ...focus,
        label,
        type,
        parameters: { drug: "Olaparib", indication: "C50" },
      },
    });
    expect(query.stage.systemicTherapy).toBe(false);
    expect(query.stage.plannedTherapy).toBe(label.includes("planned"));
    expect(query.treatments.has(drug)).toBe(false);
    expect(query.relations.size).toBe(0);
  }
});

test("withdrawing a plan without an indication preserves other drugs and a later start", () => {
  const diagnosis = {
    ...focus,
    id: "dx",
    date: "2026-01-01",
    type: "diagnosis",
    label: "Confirmed breast cancer.",
  };
  const plan = {
    id: "plan",
    date: "2026-01-02",
    type: "treatment_decision",
    label: "Olaparib planned.",
    parameters: { drug: "Olaparib", indication: "C50" },
  };
  const other = {
    ...plan,
    id: "other",
    label: "Docetaxel planned.",
    parameters: { drug: "Docetaxel", indication: "C50" },
  };
  const cancel = {
    id: "cancel",
    date: "2026-01-03",
    type: "followup",
    label: "Olaparib not started.",
  };
  const after = patientQuery({
    focus: cancel,
    context: [diagnosis, plan, other],
  });
  expect(conceptOf(after, drug)).toBeUndefined();
  expect(
    after.concepts.find((c) => c.name.toLowerCase() === "docetaxel")
      ?.plannedFor,
  ).toContain("mesh:D001943");
  expect(after.stage.plannedTherapy).toBe(true);
  for (const [label, stillPlanned] of [
    ["Olaparib cancelled and Docetaxel remains planned.", true],
    ["Olaparib abgesagt und Docetaxel weiterhin geplant.", true],
    ["Olaparib and Docetaxel cancelled.", false],
  ] as const) {
    const update = patientQuery({
      context: [diagnosis, plan, other],
      focus: {
        ...cancel,
        label,
        parameters: { drug: "Olaparib and Docetaxel", indication: "C50" },
      },
    });
    expect(conceptOf(update, drug), label).toBeUndefined();
    const docetaxel = update.concepts.find(
      (c) => c.name.toLowerCase() === "docetaxel",
    );
    expect(
      docetaxel?.plannedFor?.includes("mesh:D001943") ?? false,
      label,
    ).toBe(stillPlanned);
    expect(update.stage.plannedTherapy, label).toBe(stillPlanned);
  }

  const restart = {
    ...plan,
    id: "restart",
    date: "2026-01-04",
    type: "therapy",
    label: "Olaparib started.",
  };
  const active = patientQuery({
    focus: restart,
    context: [diagnosis, plan, cancel],
  });
  expect(active.treatments.has(drug)).toBe(true);
  expect(
    active.relations.has(JSON.stringify([drug, "treats", "mesh:D001943"])),
  ).toBe(true);
  expect(active.stage.plannedTherapy).toBe(false);
});

test("a cancellation for one indication keeps the same drug's plan for another diagnosis", () => {
  const diagnosis = (id: string, label: string) => ({
    ...focus,
    id,
    type: "diagnosis",
    label,
    date: "2026-01-01",
  });
  const plan = (id: string, indication: string) => ({
    id,
    date: "2026-01-02",
    type: "treatment_decision",
    label: "Olaparib planned.",
    parameters: { drug: "Olaparib", indication },
  });
  const query = patientQuery({
    context: [
      diagnosis("lung", "Confirmed C34."),
      diagnosis("breast", "Confirmed C50."),
      plan("a", "C34"),
      plan("b", "C50"),
    ],
    focus: {
      ...plan("cancel", "Breast cancer"),
      date: "2026-01-03",
      label: "Treatment update.",
      parameters: {
        drug: "Olaparib",
        indication: "Breast cancer",
        treatment_status: "cancelled",
      },
    },
  });
  expect(conceptOf(query, drug)?.plannedFor).toContain("mesh:D008175");
  expect(conceptOf(query, drug)?.plannedFor).not.toContain("mesh:D001943");
});

test("a second malignancy and a multi-indication drug do not imply a prostate diagnosis", () => {
  const query = patientQuery({
    context: [{ ...focus, type: "diagnosis", label: "Confirmed C50" }],
    focus: {
      ...focus,
      type: "systemic_therapy",
      label: "Docetaxel given",
      parameters: { psa_value: 13 },
    },
  });
  expect(query.diagnoses.has(cancer)).toBe(false);
  expect(query.stage.flags.psaWorkup).toBe(false);
  expect(query.diagnoses.has("mesh:D001943")).toBe(true);
  expect(
    patientQuery({
      context: [],
      focus: { ...focus, type: "systemic_therapy", label: "Docetaxel given" },
    }).diagnoses.size,
  ).toBe(0);
});

test("another disease neither hides an implied prostate cancer nor switches its rules off", () => {
  const q = patientQuery({
    context: [
      {
        ...focus,
        id: "diabetes",
        date: "2026-01-05",
        type: "diagnosis",
        label: "Diabetes mellitus Typ 2",
        parameters: { diagnosis: "Diabetes mellitus Typ 2", icd_code: "E11" },
      },
    ],
    focus: {
      ...focus,
      type: "biopsy",
      label: "Stanzbiopsie",
      parameters: { gleason_primary: 3, gleason_secondary: 4 },
    },
  });
  expect(q.diagnoses.has("mesh:D003924")).toBe(true);
  expect(q.diagnoses.has(cancer)).toBe(true);
  expect(q.profile).toBe(prostate);
  expect(q.stage.diagnosed).toBe(true);
  expect(q.sex).toBe("male");
});

test("proof of the cancer confirms a diagnosis that the journey names without saying how sure it is", () => {
  const discharge = (diagnosis: string) => ({
    ...focus,
    id: "discharge",
    type: "hospital_discharge",
    label: "Entlassung",
    parameters: { diagnosis },
  });
  const biopsy = {
    ...focus,
    id: "biopsy",
    date: "2026-11-01",
    type: "biopsy",
    label: "Stanzbiopsie",
    parameters: { gleason_primary: 3 },
  };
  const psa = {
    ...focus,
    id: "psa",
    type: "followup",
    label: "PSA-Kontrolle",
    parameters: { psa_value: 0.2 },
  };
  const named = discharge("pT2c R0 Prostatakarzinom");
  const unproven = patientQuery({ context: [named], focus: psa });
  expect(unproven.stage).toMatchObject({
    diagnosed: false,
    flags: { psaWorkup: true },
  });
  const proven = patientQuery({ context: [biopsy, named], focus: psa });
  expect(proven.stage).toMatchObject({
    diagnosed: true,
    flags: { psaWorkup: false },
  });
  expect(proven.evidence.map((item) => item.detail)).toContain(
    "Confirmed by a prostate workup",
  );
  // The castration-resistant form is prostate cancer too, and stays the one diagnosis named.
  const resistant = patientQuery({
    context: [biopsy, discharge("mCRPC unter Cabazitaxel")],
    focus: psa,
  });
  expect(resistant.stage.diagnosed).toBe(true);
  expect(conceptOf(resistant, crpc)?.role).toBe("stage");
});

test("a generic treatment event or an administration in a follow-up binds its indication", () => {
  const context = [{ ...focus, type: "diagnosis", label: "C50" }];
  for (const [type, label, given] of [
    ["therapy", "Olaparib", true],
    ["treatment", "Olaparib", true],
    ["followup", "Received olaparib", true],
    ["therapy", "Olaparib prescribed", false],
  ] as const) {
    const q = patientQuery({
      context,
      focus: {
        ...focus,
        type,
        label,
        parameters: { drug: "Olaparib", indication: "C50" },
      },
    });
    expect(
      q.relations.has(JSON.stringify([drug, "treats", "mesh:D001943"])),
    ).toBe(given);
  }
});

test("a non-prostate journey cannot acquire a prostate disease state from the drug or hormonal terminology", () => {
  const q = patientQuery({
    context: [{ ...focus, type: "diagnosis", label: "C50" }],
    focus: {
      ...focus,
      type: "therapy",
      label: "Hormone-sensitive. Radium-223.",
    },
  });
  expect(q.profile).toBeUndefined();
  expect(q.stage.states.size).toBe(0);
});

test("of an overlong text only the start is read", () => {
  const filler = " lorem".repeat(1_000);
  const q = patientQuery({
    context: [
      {
        ...focus,
        id: "dx",
        type: "diagnosis",
        label: `Prostatakarzinom bestätigt.${filler} Mammakarzinom bestätigt.`,
      },
    ],
    focus: {
      ...focus,
      type: "imaging",
      label: "Skelettszintigraphie",
      parameters: { finding: `Knochenmetastasen.${filler} Lebermetastasen.` },
    },
  });
  expect([...q.diagnoses.keys()].sort()).toEqual([cancer, crpc]);
  expect(conceptOf(q, "mesh:D001859")).toBeDefined();
  expect(conceptOf(q, liver)).toBeUndefined();
});

test("an operation of any disease is a procedure of the query and a local therapy", () => {
  const dx = {
    id: "dx",
    date: "2026-01-10",
    type: "diagnosis",
    label: "Mammakarzinom bestätigt.",
    parameters: { diagnosis: "Mammakarzinom", icd_code: "C50" },
  };
  const surgery = {
    id: "op",
    date: "2026-02-01",
    type: "surgery",
    label: "Mastektomie links.",
  };
  const query = patientQuery({ context: [dx], focus: surgery });
  const ids = query.concepts.map((concept) => concept.ids[0]);
  expect(ids).toContain("mesh:D008408");
  expect(ids).toContain("mesh:D001943Q000601");
  expect(
    query.concepts.find((concept) => concept.ids[0] === "mesh:D008408"),
  ).toMatchObject({ role: "procedure", focus: true });
  expect(query.stage.localTherapy).toBe(true);
  expect(query.profile).toBeUndefined();
});

test("a suspicion in a finding, a pathology report and a later finding of spread set the timeline course", () => {
  const ct = {
    id: "ct",
    date: "2026-03-09",
    type: "imaging",
    label: "CT Thorax",
    parameters: { finding: "Rundherd, Verdacht auf Bronchialkarzinom" },
  };
  const pathology = {
    id: "path",
    date: "2026-03-24",
    type: "pathology",
    label: "Histologie",
    parameters: { diagnosis: "Adenokarzinom der Lunge" },
  };
  const staging = {
    id: "pet",
    date: "2026-03-30",
    type: "imaging",
    label: "PET-CT: keine Fernmetastasen",
  };
  const relapse = {
    id: "mri",
    date: "2028-01-10",
    type: "progression",
    label: "Rezidiv mit zwei Hirnmetastasen",
  };
  const suspected = patientQuery({ context: [], focus: ct });
  expect(suspected.diagnoses.has("mesh:D008175")).toBe(true);
  expect(suspected.stage.diagnosed).toBe(false);
  const confirmed = patientQuery({ context: [ct], focus: pathology });
  expect(confirmed.stage.diagnosed).toBe(true);
  const staged = patientQuery({ context: [ct, pathology], focus: staging });
  expect(staged.stage.states.has("metastatic")).toBe(false);
  // Metastases named on a later day follow the earlier "keine Fernmetastasen".
  const later = patientQuery({
    context: [ct, pathology, staging],
    focus: relapse,
  });
  expect([...later.stage.states].sort()).toEqual(["metastatic", "recurrence"]);
});

test("a prostate workup confirms a diagnosis the journey named as suspected", () => {
  const mri = {
    id: "mri",
    date: "2026-11-27",
    type: "imaging",
    label: "Multiparametrische MRT der Prostata",
    parameters: {
      finding: "PI-RADS 5 – hochgradiger Verdacht auf Prostatakarzinom",
    },
  };
  const biopsy = {
    id: "biopsy",
    date: "2026-12-08",
    type: "biopsy",
    label: "Stanzbiopsie",
    parameters: { gleason_primary: 4, gleason_secondary: 3 },
  };
  const before = patientQuery({ context: [], focus: mri });
  const after = patientQuery({ context: [mri], focus: biopsy });
  const weight = (query: typeof after) =>
    query.concepts.find((concept) => concept.ids[0] === cancer)?.weight;
  expect(before.stage.diagnosed).toBe(false);
  expect(after.stage.diagnosed).toBe(true);
  expect(weight(after)).toBeGreaterThan(weight(before) ?? 0);
});

test("after a named diagnosis a suspicion in a finding is a side finding", () => {
  const dx = {
    id: "dx",
    date: "2026-03-24",
    type: "pathology",
    label: "Histologie",
    parameters: { diagnosis: "Adenokarzinom der Lunge", icd_code: "C34.1" },
  };
  const ct = {
    id: "ct",
    date: "2026-09-20",
    type: "imaging",
    label: "CT Thorax",
    parameters: { finding: "Infiltrat, Verdacht auf Pneumonie" },
  };
  const query = patientQuery({ context: [dx], focus: ct });
  expect(query.diagnoses.has("mesh:D011014")).toBe(false);
});

test("after a named cancer a progression report's other finding is no diagnosis", () => {
  const dx = {
    id: "dx",
    date: "2026-10-20",
    type: "pathology",
    label: "Adenokarzinom des Rektums",
    parameters: { icd_code: "C20" },
  };
  const nodule = {
    id: "ct",
    date: "2029-02-01",
    type: "progression",
    label: "CEA-Anstieg und neuer Lungenrundherd: V. a. pulmonale Metastase",
  };
  const query = patientQuery({ context: [dx], focus: nodule });
  expect([...query.diagnoses.keys()]).not.toContain("mesh:D003074");
  expect(query.diagnoses.has("mesh:D012004")).toBe(true);
});

test("a metastasis beside the primary's code is no contradiction", () => {
  const event = (diagnosis: string, icd_code: string) => ({
    id: "path",
    date: "2027-03-02",
    type: "pathology",
    label: "Histologie nach Gastrektomie",
    parameters: { diagnosis, icd_code },
  });
  for (const [diagnosis, code] of [
    ["Adenokarzinom des Magens mit Lymphknotenmetastasen", "C16.2"],
    ["Lebermetastasen eines Melanoms", "C78.7"],
  ]) {
    const query = patientQuery({ context: [], focus: event(diagnosis, code) });
    expect(
      query.evidence.map((item) => item.detail),
      diagnosis,
    ).not.toContain("Diagnostic name and ICD code disagree");
  }
});

test("a complication or a further disease beside a code is no contradiction", () => {
  const event = {
    id: "discharge",
    date: "2027-05-12",
    type: "hospital_discharge",
    label: "Entlassung nach kardialer Dekompensation",
    parameters: {
      diagnosis: "Akut dekompensierte Herzinsuffizienz bei Vorhofflimmern",
      icd_code: "I50.14",
    },
  };
  const query = patientQuery({ context: [], focus: event });
  expect(query.evidence.map((item) => item.detail)).not.toContain(
    "Diagnostic name and ICD code disagree",
  );
  expect(query.diagnoses.has("mesh:D006333")).toBe(true);
  expect(query.diagnoses.has("mesh:D001281")).toBe(true);
});
