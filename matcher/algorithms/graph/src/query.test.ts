import { readFileSync } from "node:fs";
import type { JourneyState } from "@matcher/core";
import { expect, test } from "vitest";
import { DEFAULT_WEIGHTS, patientQuery } from "./query.ts";

const cancer = "mesh:D011471";
const crpc = "mesh:D064129";
const drug = "mesh:C531550";
const liver = "mesh:D008113";
const date = "2026-12-08";
const focus = { id: date, date, label: "follow-up", type: "facts" };
const { roles } = DEFAULT_WEIGHTS;

function edge(
  name: string,
  from: string,
  to: string,
  fact = "",
  valid_at: string | null = date,
) {
  return {
    uuid: [name, from, to, valid_at].join("/"),
    name,
    source_node_uuid: from,
    target_node_uuid: to,
    fact,
    valid_at,
  };
}

const nodes = [
  { uuid: "p", labels: ["Patient"], name: "Synthetic" },
  { uuid: "dx", labels: ["Diagnosis"], name: "Prostatakarzinom" },
  { uuid: "rx", labels: ["Medication"], name: "Olaparib" },
  { uuid: "gene", labels: ["LabTest"], name: "BRCA2" },
];
const diagnosis = edge(
  "HAS_DIAGNOSIS",
  "p",
  "dx",
  "Confirmed prostate cancer.",
);
const received = edge("PRESCRIBED", "p", "rx");
const treated = edge("TREATED_BY", "dx", "rx");
const graphQuery = (
  edges: NonNullable<JourneyState["graph"]>["edges"],
  extra: NonNullable<JourneyState["graph"]>["nodes"] = [],
  as_of?: string,
) =>
  patientQuery({
    focus,
    context: [],
    graph: { nodes: [...nodes, ...extra], edges, ...(as_of && { as_of }) },
  });
const conceptOf = (query: ReturnType<typeof patientQuery>, id: string) =>
  query.concepts.find((concept) => concept.ids[0] === id);

test("a diagnosis lets in papers on it and on its narrower forms", () => {
  const query = graphQuery([diagnosis]);
  expect([...query.diagnoses.keys()]).toEqual([cancer, crpc]);
  expect(conceptOf(query, cancer)).toMatchObject({ role: "diagnosis" });
});

test("a concept brings its other IDs, broader concepts and MeSH aspects", () => {
  const query = graphQuery([
    diagnosis,
    received,
    edge("HAD_LAB_TEST", "p", "gene"),
  ]);
  const olaparib = conceptOf(query, drug);
  expect(olaparib).toMatchObject({ role: "drug", focus: true });
  expect(conceptOf(query, "mesh:D000067856")?.weight).toBeCloseTo(
    (olaparib?.weight ?? 0) * DEFAULT_WEIGHTS.broader,
  );
  // Prostatic Neoplasms/drug therapy and olaparib/adverse effects.
  expect(conceptOf(query, `${cancer}Q000188`)).toMatchObject({
    role: "aspect",
  });
  expect(conceptOf(query, `${drug}Q000009`)?.weight).toBeCloseTo(
    (olaparib?.weight ?? 0) * DEFAULT_WEIGHTS.aspect,
  );
  expect(conceptOf(query, "ncbigene:675")?.ids).toEqual([
    "ncbigene:675",
    "mesh:D024682",
    "mesh:D024522",
  ]);
  expect(query.treatments.has(drug)).toBe(true);
});

test("the focus day weighs the current therapy, news and partly measurements, not restated history", () => {
  const surgery = {
    uuid: "rp",
    labels: ["Procedure"],
    name: "radical prostatectomy",
  };
  const adt = { uuid: "adt", labels: ["Medication"], name: "Leuprorelin" };
  const psa = { uuid: "psa", labels: ["TumorMarker"], name: "PSA" };
  const query = graphQuery(
    [
      diagnosis,
      edge("UNDERWENT", "p", "rp", "", "2026-10-01"),
      edge("UNDERWENT", "p", "rp", "Status after prostatectomy."),
      edge("PRESCRIBED", "p", "adt", "", "2026-11-15"),
      edge("PRESCRIBED", "p", "adt"),
      edge("HAS_TUMOR_MARKER", "p", "psa", "", "2026-10-01"),
      edge("HAS_TUMOR_MARKER", "p", "psa"),
    ],
    [surgery, adt, psa],
  );
  // The surgery is restated, but the drug started later: it is the current therapy.
  expect(conceptOf(query, "mesh:D011468")).toMatchObject({
    focus: false,
    weight: roles.procedure * 0.65,
  });
  expect(conceptOf(query, "mesh:D016729")).toMatchObject({
    focus: true,
    weight: roles.drug * 0.65 * DEFAULT_WEIGHTS.focus,
  });
  expect(conceptOf(query, "ncbigene:354")).toMatchObject({
    focus: true,
    weight:
      roles.gene *
      0.65 *
      (1 + (DEFAULT_WEIGHTS.focus - 1) * DEFAULT_WEIGHTS.measurement),
  });
});

test("a therapy stopped and started again counts from its restart", () => {
  const rx = (valid_at: string, invalid_at?: string) => ({
    ...edge("PRESCRIBED", "p", "rx", "", valid_at),
    uuid: `rx/${valid_at}`,
    ...(invalid_at && { invalid_at }),
  });
  const adt = { uuid: "adt", labels: ["Medication"], name: "Leuprorelin" };
  const query = graphQuery(
    [
      diagnosis,
      rx("2026-01-01", "2026-06-01"),
      rx("2026-11-20"),
      edge("PRESCRIBED", "p", "adt", "", "2026-05-01"),
    ],
    [adt],
  );
  expect(conceptOf(query, drug)?.focus).toBe(true);
  expect(conceptOf(query, "mesh:D016729")?.focus).toBe(false);
});

test("an unresolved node counts with the curated concepts its name contains", () => {
  const radiotherapy = {
    uuid: "rt",
    labels: ["Procedure"],
    name: "Strahlentherapie der Prostataloge",
  };
  const query = graphQuery(
    [diagnosis, edge("UNDERWENT", "p", "rt")],
    [radiotherapy],
  );
  expect(conceptOf(query, "mesh:D011878")).toMatchObject({
    role: "procedure",
    focus: true,
  });
  expect(query.stage.localTherapy).toBe(true);
});

test("a timeline names concepts in its labels and text parameters", () => {
  const query = patientQuery({
    context: [
      { id: "e1", date: "2026-01-01", type: "diagnosis", label: "PCa" },
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

test("the disease state also comes from the sentences of the statements, unless switched off", () => {
  const graph = JSON.parse(
    readFileSync(
      new URL("../../../../patientdata/Patient-8/graph.json", import.meta.url),
      "utf8",
    ),
  );
  const at = (sentences: boolean) =>
    patientQuery(
      {
        focus: { ...focus, date: "2030-05-21" },
        context: [],
        graph: { ...graph, as_of: "2030-05-21" },
      },
      { ...DEFAULT_WEIGHTS, sentences },
    ).stage.states;
  expect(at(true).has("castration_resistant")).toBe(true);
  expect(at(false).has("castration_resistant")).toBe(false);
});

test("uses the latest active status at the requested cutoff and excludes future and undated facts", () => {
  const prior = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Suspected prostate cancer.",
    "2026-11-06",
  );
  const negated = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Prostate cancer was ruled out.",
    "2027-01-01",
  );
  const forDay = (as_of: string) =>
    graphQuery(
      [
        negated,
        diagnosis,
        prior,
        { ...received, invalid_at: "2026-12-15" },
        { ...treated, valid_at: null },
      ],
      [],
      as_of,
    );
  expect(forDay("2026-11-01").diagnoses.size).toBe(0);
  expect(forDay("2026-12-08").diagnoses.get(cancer)).toBeGreaterThan(
    forDay("2026-11-06").diagnoses.get(cancer) ?? 0,
  );
  expect(forDay("2026-12-08").treatments.has(drug)).toBe(true);
  expect(forDay("2026-12-15").treatments.size).toBe(0);
  expect(forDay("2027-01-01").diagnoses.size).toBe(0);
  expect(forDay("2026-12-08").relations.size).toBe(0);
});

test.each(["HAS_SYMPTOM", "RELATES_TO"])(
  "an active %s symptom cannot inherit an expired diagnosis",
  (name) => {
    const patient = nodes[0];
    const dx = { uuid: "d", name: "Fatigue", labels: ["Diagnosis"] };
    const symptom = { uuid: "s", name: "Fatigue", labels: ["Symptom"] };
    const prior = {
      ...edge("HAS_DIAGNOSIS", "p", "d", "", "2026-10-01"),
      invalid_at: date,
    };
    const current = edge(name, "p", "s");
    const graph: NonNullable<JourneyState["graph"]> = {
      nodes: [patient, dx, symptom],
      edges: [prior, current],
    };
    const query = patientQuery({ focus, context: [], graph });
    expect(query.diagnoses.size).toBe(0);
    expect(conceptOf(query, "mesh:D005221")?.role).toBe("symptom");
    // A later negation of the symptom also cannot cancel an independent, active diagnosis.
    graph.edges = [
      { ...prior, invalid_at: "2027-01-01" },
      { ...current, fact: "No fatigue." },
    ];
    expect(
      patientQuery({ focus, context: [], graph }).diagnoses.has("mesh:D005221"),
    ).toBe(true);
  },
);

test("later timeline statements update the named patient diagnosis only", () => {
  const context = [
    { ...focus, date: "2026-01-01", type: "diagnosis", label: "PCa" },
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
  const named = { ...first, label: "PCa", date };
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
      focus: { ...focus, type: "screening", label: "PCa" },
    }).diagnoses.size,
  ).toBe(0);
  const prior = {
    ...focus,
    type: "diagnosis",
    label: "PCa",
    date: "2026-01-01",
  };
  expect(
    patientQuery({
      context: [prior],
      focus: { ...family, label: "Prostate cancer was ruled out." },
    }).diagnoses.has(cancer),
  ).toBe(true);
});

test("routine follow-ups without status cues preserve earlier confirmed or suspected status", () => {
  const confirmed = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Confirmed prostate cancer.",
    "2026-12-08",
  );
  const followup = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Patient has C61 Prostatakarzinom.",
    "2027-06-01",
  );
  const later = { ...focus, date: "2027-06-01" };
  const confirmedQuery = patientQuery({
    focus: later,
    context: [],
    graph: { nodes, edges: [followup, confirmed] },
  });
  const suspected = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Suspected prostate cancer.",
    "2026-11-06",
  );
  const suspectedQuery = patientQuery({
    focus: later,
    context: [],
    graph: { nodes, edges: [suspected, followup] },
  });
  expect(suspectedQuery.diagnoses.get(cancer)).toBeCloseTo(
    (confirmedQuery.diagnoses.get(cancer) ?? 0) * 0.45,
  );

  // Real synthetic graph regression: Patient-13 is confirmed in 2026/2027, then has plain follow-ups.
  const patient13 = JSON.parse(
    readFileSync(
      new URL("../../../../patientdata/Patient-13/graph.json", import.meta.url),
      "utf8",
    ),
  );
  const p13 = patientQuery({
    focus: { ...focus, date: "2029-05-21" },
    context: [],
    graph: { ...patient13, as_of: "2029-05-21" },
  });
  expect(p13.diagnoses.get(cancer)).toBeGreaterThan(0);
  // Unresolved `name:...` triples are never added to `query.relations`.
  for (const key of p13.relations.keys()) {
    const [subject, , object] = JSON.parse(key) as [string, string, string];
    expect(subject.startsWith("name:")).toBe(false);
    expect(object.startsWith("name:")).toBe(false);
  }
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
  expect(queryFor("Patient-10").diagnoses.has(crpc)).toBe(true);
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

test("a test can indicate a suspected diagnosis before confirmation", () => {
  const test = { uuid: "lab", name: "PSA", labels: ["LabTest"] };
  const indicates = edge(
    "INDICATES",
    "lab",
    "dx",
    "Elevated PSA indicates suspected prostate cancer.",
  );
  expect(graphQuery([edge("INDICATES", "rx", "dx")]).diagnoses.size).toBe(0);
  const q = graphQuery([indicates], [test]);
  expect(q.diagnoses.get(cancer)).toBeCloseTo(0.45 * DEFAULT_WEIGHTS.focus);
  expect(q.stage.diagnosed).toBe(false);
  expect(conceptOf(q, "ncbigene:354")?.focus).toBe(true);
  expect(
    graphQuery(
      [
        indicates,
        edge("HAS_DIAGNOSIS", "p", "dx", "Prostate cancer was ruled out."),
      ],
      [test],
    ).diagnoses.size,
  ).toBe(0);
  expect(
    graphQuery([{ ...indicates, invalid_at: date }], [test]).diagnoses.size,
  ).toBe(0);
});

test("planned and expired evidence cannot establish an active stage", () => {
  const radium = { uuid: "ra", name: "Radium-223", labels: ["Medication"] };
  const planned = edge(
    "HAS_TREATMENT_PLAN",
    "p",
    "ra",
    "Radium-223 if he progresses to mCRPC.",
  );
  const expired = {
    ...edge(
      "HAS_DIAGNOSIS",
      "p",
      "dx",
      "Confirmed metastatic prostate cancer.",
      "2026-01-01",
    ),
    invalid_at: date,
  };
  expect(graphQuery([planned, expired], [radium]).stage.states).toEqual(
    new Set(),
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
