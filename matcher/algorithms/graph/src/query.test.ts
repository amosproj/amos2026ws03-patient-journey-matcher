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

test("C34 alone retrieves narrower lung papers without recording a patient subtype", () => {
  const lung = "mesh:D008175";
  const nsclc = "mesh:D002289";
  const graph = graphQuery(
    [edge("HAS_DIAGNOSIS", "p", "lung", "Confirmed C34.")],
    [{ uuid: "lung", name: "C34", labels: ["Diagnosis"] }],
  );
  const timeline = patientQuery({
    context: [],
    focus: { ...focus, type: "diagnosis", label: "Confirmed C34." },
  });
  for (const query of [graph, timeline]) {
    expect(query.evidence.filter((item) => item.diagnosis)).toMatchObject([
      { diagnosis: lung },
    ]);
    const diagnoses = query.concepts.filter((c) => c.role === "diagnosis");
    expect(diagnoses.map((c) => c.name)).toEqual(["Lung Neoplasms"]);
    expect(diagnoses[0].ids).toContain(nsclc);
  }
});

test("histology follows the dated pathology and its site in both formats", () => {
  const lung = { uuid: "lung", name: "C34", labels: ["Diagnosis"] };
  const breast = { uuid: "breast", name: "C50", labels: ["Diagnosis"] };
  const report = { uuid: "path", name: "Biopsy", labels: ["PathologyResult"] };
  const dx = edge("HAS_DIAGNOSIS", "p", "lung", "Confirmed C34.", "2026-01-01");
  const biopsy = edge(
    "HAS_PATHOLOGY",
    "p",
    "path",
    "Histologie: nichtkleinzellig.",
    "2026-01-02",
  );
  const repeat = { ...dx, uuid: "restated", valid_at: "2026-01-03" };
  const excluded = {
    ...biopsy,
    uuid: "revised",
    fact: "Histologie: nichtkleinzellig ausgeschlossen.",
    valid_at: "2026-01-04",
  };
  const history = [dx, biopsy, repeat, excluded];
  const subtypes = (facts: typeof history, cutoff: string) => {
    const events = facts.map((item) => ({
      id: item.uuid,
      type: item.name === "HAS_DIAGNOSIS" ? "diagnosis" : "pathology",
      label: item.fact,
      date: item.valid_at as string,
    }));
    const timeline = patientQuery({
      context: events,
      focus: { ...focus, date: cutoff },
    });
    const graph = graphQuery(facts, [lung, breast, report], cutoff);
    return [timeline.histology?.observed, graph.histology?.observed];
  };
  const nsclc = "mesh:D002289";
  expect(subtypes(history, "2026-01-01")).toEqual([undefined, undefined]);
  expect(subtypes(history, "2026-01-02")).toEqual([nsclc, nsclc]);
  expect(subtypes(history, "2026-01-03")).toEqual([nsclc, nsclc]);
  expect(subtypes(history, "2026-01-04")).toEqual([undefined, undefined]);
  const expiring = [dx, { ...biopsy, invalid_at: "2026-01-03" }];
  expect(
    graphQuery(expiring, [lung, report], "2026-01-02").histology?.observed,
  ).toBe(nsclc);
  expect(
    graphQuery(expiring, [lung, report], "2026-01-03").histology,
  ).toBeUndefined();

  const secondCancer = edge(
    "HAS_DIAGNOSIS",
    "p",
    "breast",
    "Confirmed C50.",
    "2026-01-01",
  );
  for (const fact of [
    "Histologie: nichtkleinzellig.",
    "C50. Histologie: nichtkleinzellig.",
  ]) {
    expect(
      subtypes([dx, secondCancer, { ...biopsy, fact }], "2026-01-02"),
    ).toEqual([undefined, undefined]);
  }
  expect(
    subtypes(
      [
        dx,
        secondCancer,
        { ...biopsy, fact: "C34. Histologie: nichtkleinzellig." },
      ],
      "2026-01-02",
    ),
  ).toEqual([nsclc, nsclc]);
});

test("pathology ruling out the diagnosis supersedes an earlier confirmation", () => {
  const breast = { uuid: "b", labels: ["Diagnosis"], name: "Breast cancer" };
  const confirmed = "Confirmed breast cancer.";
  const excluded = "Pathology ruled out breast cancer.";
  const graph = graphQuery(
    [
      edge("HAS_DIAGNOSIS", "p", "b", confirmed, "2026-01-02"),
      edge("HAS_DIAGNOSIS", "p", "b", excluded, "2026-01-07"),
    ],
    [breast],
    "2026-01-07",
  );
  const timeline = patientQuery({
    context: [
      { id: "dx", type: "diagnosis", date: "2026-01-02", label: confirmed },
    ],
    focus: {
      id: "exclude",
      type: "pathology",
      date: "2026-01-07",
      label: excluded,
    },
  });
  for (const [format, query] of Object.entries({ graph, timeline })) {
    expect.soft(query.diagnoses.size, format).toBe(0);
  }
});

test.each([
  ["CONFIRMED_BY", "breast", "path", "Biopsy"],
  ["CONFIRMED_BY", "path", "breast", "Breast cancer"],
  ["INDICATES", "path", "breast", "Biopsy"],
  ["HAS_PATHOLOGY", "p", "path", "Biopsy"],
  ["HAS_PATHOLOGY", "p", "path", "Breast cancer"],
])(
  "a dated %s from %s to %s (%s) can revise a diagnosis",
  (kind, from, to, pathology) => {
    const breast = "mesh:D001943";
    const extra = [
      { uuid: "breast", labels: ["Diagnosis"], name: "Breast cancer" },
      {
        uuid: "path",
        labels: [kind === "INDICATES" ? "LabTest" : "PathologyResult"],
        name: pathology,
      },
    ];
    const prior = edge(
      "HAS_DIAGNOSIS",
      "p",
      "breast",
      "Confirmed breast cancer.",
      "2026-01-01",
    );
    const veto = edge(
      kind,
      from,
      to,
      "The biopsy ruled out breast cancer.",
      "2026-01-02",
    );
    const hasBreast = (
      edges: NonNullable<JourneyState["graph"]>["edges"],
      day: string,
    ) => graphQuery(edges, extra, day).diagnoses.has(breast);
    expect(hasBreast([prior, veto], "2026-01-01")).toBe(true);
    expect(
      hasBreast([veto, { ...prior, valid_at: veto.valid_at }], "2026-01-02"),
    ).toBe(false);
    expect(hasBreast([prior, veto], "2026-01-03")).toBe(false);
    expect(
      hasBreast([prior, { ...veto, invalid_at: "2026-01-03" }], "2026-01-03"),
    ).toBe(true);
    const repeat = {
      ...veto,
      uuid: "repeat",
      fact: "The biopsy confirmed breast cancer.",
      valid_at: "2026-01-04",
    };
    expect(hasBreast([prior, veto, repeat], "2026-01-04")).toBe(true);
    expect(
      hasBreast(
        [prior, { ...veto, fact: "The biopsy was negative." }],
        "2026-01-02",
      ),
    ).toBe(true);
  },
);

test.each([
  "Small cell lung cancer ruled out.",
  "No small cell lung cancer.",
  "Histology: small cell ruled out.",
])(
  "a subtype exclusion stays out of diagnosis and treatment groups: %s",
  (label) => {
    const lung = "mesh:D008175",
      small = "mesh:D055752";
    const dx = {
      ...focus,
      id: "dx",
      type: "diagnosis",
      date: "2026-01-01",
      label: "Confirmed lung cancer.",
    };
    const plan = {
      ...dx,
      id: "rx",
      type: "treatment_decision",
      label: "Olaparib planned.",
      parameters: { drug: "Olaparib", indication: "C34" },
    };
    const excluded = {
      ...dx,
      id: "path",
      type: "pathology",
      date: "2026-01-02",
      label,
    };
    const timeline = patientQuery({ context: [dx, plan], focus: excluded });
    const extra = [
      { uuid: "lung", labels: ["Diagnosis"], name: "Lung cancer" },
      { uuid: "path", labels: ["PathologyResult"], name: "Biopsy" },
    ];
    const edges = [
      edge("HAS_DIAGNOSIS", "p", "lung", dx.label, dx.date),
      edge("TREATED_BY", "lung", "rx", plan.label, plan.date),
      label.startsWith("Histology")
        ? edge("HAS_PATHOLOGY", "p", "path", label, excluded.date)
        : edge("HAS_DIAGNOSIS", "p", "lung", label, excluded.date),
    ];
    for (const q of [timeline, graphQuery(edges, extra, excluded.date)]) {
      expect(q.diagnoses.has(lung)).toBe(true);
      expect(q.diagnoses.has(small)).toBe(false);
      expect(conceptOf(q, lung)?.ids).not.toContain(small);
      const treatment = conceptOf(q, drug);
      expect(treatment?.plannedFor).toContain(lung);
      expect(treatment?.diagnoses).not.toContain(small);
      expect(treatment?.plannedFor).not.toContain(small);
    }
    const restored = patientQuery({
      context: [dx, plan, excluded],
      focus: {
        ...dx,
        date: "2026-01-03",
        label: "Confirmed small cell lung cancer.",
      },
    });
    expect(restored.diagnoses.has(small)).toBe(true);
    expect(restored.histology?.observed).toBe(small);
  },
);

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

test.each(["Cabazitaxel", "Radium-223"])(
  "only a received %s can imply a stage",
  (name) => {
    const extra = [{ uuid: "drug", labels: ["Medication"], name }];
    const allergy = edge("HAS_ALLERGY", "p", "drug", `Allergy to ${name}`);
    const q = graphQuery([diagnosis, allergy], extra);
    expect(
      q.concepts.find((item) => item.name.toLowerCase() === name.toLowerCase())
        ?.role,
    ).toBe("finding");
    expect(q.stage.states.size).toBe(0);
    for (const given of [
      edge("PRESCRIBED", "p", "drug", `${name} received.`),
      edge("TREATED_BY", "dx", "drug", `${name} received.`),
    ])
      expect(
        graphQuery([diagnosis, given], extra).stage.states.has(
          "castration_resistant",
        ),
      ).toBe(true);
    const dx = {
      ...focus,
      type: "diagnosis",
      label: "Confirmed prostate cancer.",
    };
    expect(
      patientQuery({
        context: [dx],
        focus: { ...focus, label: `Allergy to ${name}` },
      }).stage.states.size,
    ).toBe(0);
  },
);

test("actions stay with their respective treatments on the same day", () => {
  const dx = {
    ...focus,
    type: "diagnosis",
    label: "Confirmed prostate cancer.",
    date: "2026-01-01",
  };
  const second = { uuid: "enza", labels: ["Medication"], name: "Enzalutamide" };
  const enza = "mesh:C540278";
  for (const label of [
    "The patient has not received olaparib. Enzalutamide started.",
    "Olaparib cancelled and enzalutamide started.",
    "No olaparib was given. Enzalutamide started.",
  ]) {
    const tx = {
      ...focus,
      type: "therapy",
      label,
      parameters: { drug: "Olaparib and enzalutamide", indication: "C61" },
    };
    const timeline = patientQuery({ context: [dx], focus: tx });
    const graph = graphQuery(
      [
        diagnosis,
        edge("TREATED_BY", "dx", "rx", label),
        edge("TREATED_BY", "dx", "enza", label),
      ],
      [second],
    );
    for (const q of [timeline, graph]) {
      expect(q.treatments.has(drug)).toBe(false);
      expect(q.treatments.has(enza)).toBe(true);
      expect(q.stage.systemicTherapy).toBe(true);
      expect(q.relations.has(JSON.stringify([enza, "treats", cancer]))).toBe(
        true,
      );
      expect(q.relations.has(JSON.stringify([drug, "treats", cancer]))).toBe(
        false,
      );
    }
  }
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
    return { ...stage, states: [...stage.states] };
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
  expect(q.stage.psaWorkup).toBe(true);
  expect(graphQuery([indicates, diagnosis], [test]).stage.psaWorkup).toBe(
    false,
  );
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

test("only a performed prostatectomy qualifies papers about recurrence after surgery", () => {
  const surgery = {
    uuid: "rp",
    name: "radical prostatectomy",
    labels: ["Procedure"],
  };
  const done = edge(
    "UNDERWENT",
    "p",
    "rp",
    "Patient underwent radical prostatectomy.",
  );
  const planned = edge(
    "HAS_TREATMENT_PLAN",
    "p",
    "rp",
    "Radical prostatectomy is planned.",
  );
  const pending = edge(
    "UNDERWENT",
    "p",
    "rp",
    "Patient is scheduled for radical prostatectomy.",
  );
  expect(graphQuery([diagnosis, pending], [surgery]).stage.prostatectomy).toBe(
    false,
  );
  expect(graphQuery([diagnosis, done], [surgery]).stage.prostatectomy).toBe(
    true,
  );
  expect(graphQuery([diagnosis, planned], [surgery]).stage.prostatectomy).toBe(
    false,
  );
  expect(
    graphQuery([diagnosis, done], [surgery], "2026-11-30").stage.prostatectomy,
  ).toBe(false);
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
  expect(query.stage.psaWorkup).toBe(false);
  expect(query.diagnoses.has("mesh:D001943")).toBe(true);
  expect(
    patientQuery({
      context: [],
      focus: { ...focus, type: "systemic_therapy", label: "Docetaxel given" },
    }).diagnoses.size,
  ).toBe(0);
});

test("a general cancer word names no second diagnosis, and alone no filter", () => {
  const confirmed = {
    ...focus,
    id: "dx",
    date: "2026-01-05",
    type: "diagnosis",
    label: "Prostatakarzinom bestätigt.",
  };
  for (const label of [
    "Tumor im rechten Lappen, R0-Resektion",
    "Adenokarzinom, Gleason 4+3",
    "Karzinom histologisch gesichert",
  ]) {
    const q = patientQuery({
      context: [confirmed],
      focus: { ...focus, type: "pathology", label },
    });
    expect([...q.diagnoses.keys()].sort()).toEqual([cancer, crpc]);
    expect(
      q.concepts.filter((c) => c.role === "diagnosis").map((c) => c.ids[0]),
    ).toEqual([cancer]);
  }
  // Alone it would let in papers on any cancer, so it sets no filter and says why.
  const alone = patientQuery({
    context: [],
    focus: { ...focus, type: "diagnosis", label: "Tumor bestätigt." },
  });
  expect([...alone.diagnoses.keys()]).toEqual([]);
  expect(alone.evidence.map((item) => item.detail)).toContain(
    "Only a general heading such as carcinoma, no specific diagnosis",
  );
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
  expect(q.prostateContext).toBe(true);
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
  expect(unproven.stage).toMatchObject({ diagnosed: false, psaWorkup: true });
  const proven = patientQuery({ context: [biopsy, named], focus: psa });
  expect(proven.stage).toMatchObject({ diagnosed: true, psaWorkup: false });
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

test("family evidence on a graph diagnosis edge or in a note cannot update the patient", () => {
  const family = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "His father had confirmed prostate cancer.",
  );
  expect(graphQuery([family]).diagnoses.size).toBe(0);
  expect(
    patientQuery({
      context: [],
      focus: {
        ...focus,
        type: "diagnosis",
        label: "Mutter mit bestätigtem Mammakarzinom",
        parameters: { icd_code: "C50" },
      },
    }).diagnoses.size,
  ).toBe(0);
});

test("a dated graph treatment relation scopes the drug even without a prescription edge", () => {
  const breast = { uuid: "b", name: "Breast cancer", labels: ["Diagnosis"] };
  const second = edge("HAS_DIAGNOSIS", "p", "b", "Confirmed breast cancer.");
  const link = edge(
    "TREATED_BY",
    "b",
    "rx",
    "Breast cancer treated with olaparib.",
  );
  const earlier = graphQuery(
    [diagnosis, second, { ...link, valid_at: "2027-01-01" }],
    [breast],
  );
  expect(earlier.relations.size).toBe(0);
  const given = graphQuery([diagnosis, second, link], [breast]);
  expect(conceptOf(given, drug)?.diagnoses).toContain("mesh:D001943");
  expect(conceptOf(given, drug)?.diagnoses).not.toContain(cancer);
  expect(given.treatments.has(drug)).toBe(true);
  const planned = graphQuery(
    [
      diagnosis,
      second,
      { ...link, fact: "Olaparib planned for breast cancer." },
    ],
    [breast],
  );
  expect(planned.relations.size).toBe(0);
  expect(planned.treatments.has(drug)).toBe(false);
});

test("a mixed family and patient note assigns workup only to the patient's suspected disease", () => {
  const text = "Mother had breast cancer; patient has suspected lung cancer.";
  const lung = "mesh:D008175";
  const breast = "mesh:D001943";
  const suspected = { ...focus, type: "diagnosis", label: text };
  const timeline = patientQuery({ context: [], focus: suspected });
  const graph = graphQuery(
    [
      edge("HAS_DIAGNOSIS", "p", "l", text),
      edge("HAS_DIAGNOSIS", "p", "b", text),
    ],
    [
      { uuid: "l", name: "Lung cancer", labels: ["Diagnosis"] },
      { uuid: "b", name: "Breast cancer", labels: ["Diagnosis"] },
    ],
  );
  for (const query of [timeline, graph]) {
    expect(query.diagnoses.has(breast)).toBe(false);
    expect(conceptOf(query, `${lung}Q000175`)?.role).toBe("aspect");
  }
  const later = patientQuery({
    context: [suspected],
    focus: {
      ...focus,
      type: "diagnosis",
      date: "2027-01-01",
      label: "Confirmed lung cancer.",
    },
  });
  expect(conceptOf(later, `${lung}Q000175`)).toBeUndefined();
});

test("an ICD code added at confirmation cannot identify an earlier unspecified graph lesion", () => {
  const lesion = {
    uuid: "lesion",
    name: "Undetermined lesion",
    labels: ["Diagnosis"],
    attributes: { icd_code: "C50", date_confirmed: date },
  };
  const early = edge(
    "HAS_DIAGNOSIS",
    "p",
    "lesion",
    "Unspecified lesion.",
    "2026-11-01",
  );
  expect(graphQuery([early], [lesion], "2026-11-15").diagnoses.size).toBe(0);
  expect(
    graphQuery([early], [lesion], date).diagnoses.has("mesh:D001943"),
  ).toBe(true);
});

test("conflicting diagnostic codes and names cannot establish either diagnosis", () => {
  const event = {
    ...focus,
    type: "diagnosis",
    label: "Tumor confirmed.",
    parameters: { icd_code: "C34", diagnosis: "Breast cancer" },
  };
  const timeline = patientQuery({ focus: event, context: [] });
  expect(timeline.diagnoses.size).toBe(0);
  expect(timeline.evidence).toContainEqual(
    expect.objectContaining({
      ref: event.id,
      detail: "Diagnostic name and ICD code disagree",
    }),
  );
  const node = {
    uuid: "conflict",
    name: "Breast cancer",
    labels: ["Diagnosis"],
    attributes: { icd_code: "C34" },
  };
  const graph = graphQuery([edge("HAS_DIAGNOSIS", "p", "conflict")], [node]);
  expect(graph.diagnoses.size).toBe(0);
});

test.each(["Bone Neoplasms", "Liver Neoplasms"])(
  "a named %s diagnosis does not require evidence of a different primary disease",
  (label) => {
    const site = { uuid: "site", name: label, labels: ["Diagnosis"] };
    const timeline = patientQuery({
      context: [],
      focus: { ...focus, type: "diagnosis", label },
    });
    const graph = graphQuery([edge("HAS_DIAGNOSIS", "p", "site")], [site]);
    for (const query of [timeline, graph]) {
      expect(query.diagnoses.size).toBeGreaterThan(0);
      expect(query.stage.states.has("metastatic")).toBe(false);
    }
    expect(
      patientQuery({
        context: [],
        focus: { ...focus, type: "diagnosis", label: "Liver metastases" },
      }).diagnoses.size,
    ).toBe(0);
  },
);

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
  expect(q.prostateContext).toBe(false);
  expect(q.stage.states.size).toBe(0);
});

test("planned and ongoing indications remain distinct in a patient with two diseases", () => {
  const breast = "mesh:D001943";
  const lung = "mesh:D008175";
  const context = [
    { ...focus, id: "b", type: "diagnosis", label: "Confirmed breast cancer." },
    { ...focus, id: "l", type: "diagnosis", label: "Confirmed lung cancer." },
    {
      ...focus,
      id: "actual",
      type: "therapy",
      label: "Olaparib given",
      parameters: { drug: "Olaparib", indication: "C50" },
    },
  ];
  const timeline = patientQuery({
    context,
    focus: {
      ...focus,
      type: "treatment_decision",
      label: "Olaparib planned",
      parameters: { drug: "Olaparib", indication: "C34" },
    },
  });
  const b = { uuid: "b", name: "Breast cancer", labels: ["Diagnosis"] };
  const l = { uuid: "l", name: "Lung cancer", labels: ["Diagnosis"] };
  const graph = graphQuery(
    [
      edge("HAS_DIAGNOSIS", "p", "b"),
      edge("HAS_DIAGNOSIS", "p", "l"),
      edge("TREATED_BY", "b", "rx", "Olaparib given"),
      edge("TREATED_BY", "l", "rx", "Olaparib planned"),
    ],
    [b, l],
  );
  for (const query of [timeline, graph]) {
    const intervention = conceptOf(query, drug);
    expect(intervention?.diagnoses).toEqual(
      expect.arrayContaining([breast, lung]),
    );
    expect(intervention?.plannedFor).toContain(lung);
    expect(intervention?.plannedFor).not.toContain(breast);
    expect(query.relations.has(JSON.stringify([drug, "treats", breast]))).toBe(
      true,
    );
    expect(query.relations.has(JSON.stringify([drug, "treats", lung]))).toBe(
      false,
    );
  }
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
  expect(query.prostateContext).toBe(false);
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

test("diagnoses that name one disease at different specificity share the aspects", () => {
  const dx = {
    id: "dx",
    date: "2026-03-24",
    type: "pathology",
    label: "Histologie",
    parameters: { diagnosis: "Adenokarzinom der Lunge", icd_code: "C34.1" },
  };
  const surgery = {
    id: "op",
    date: "2026-04-20",
    type: "surgery",
    label: "Lymphadenektomie",
  };
  const ids = patientQuery({ context: [dx], focus: surgery }).concepts.map(
    (concept) => concept.ids[0],
  );
  expect(ids).toContain("mesh:D008175Q000601");
  expect(ids).toContain("mesh:D000077192Q000601");
});

test("a general word before the diagnosis neither sets the filter nor blocks a later suspicion", () => {
  const referral = {
    id: "ref",
    date: "2026-10-05",
    type: "referral",
    label: "Überweisung",
    parameters: { reason: "Blutabgang, Verdacht auf Karzinom" },
  };
  const endoscopy = {
    id: "endo",
    date: "2026-10-14",
    type: "imaging",
    label: "Koloskopie",
    parameters: {
      finding: "Exulzerierender Tumor, Verdacht auf Rektumkarzinom",
    },
  };
  expect(patientQuery({ context: [], focus: referral }).diagnoses.size).toBe(0);
  const query = patientQuery({ context: [referral], focus: endoscopy });
  expect(query.diagnoses.has("mesh:D012004")).toBe(true);
  expect(query.diagnoses.has("mesh:D002277")).toBe(false);
});

test("a kind of carcinoma with an organ code finds the cancer, alone it sets no filter", () => {
  const pathology = {
    id: "path",
    date: "2026-03-16",
    type: "pathology",
    label: "Histologie: Urothelkarzinom pT1 high grade, Carcinoma in situ",
    parameters: { icd_code: "C67.2" },
  };
  const coded = patientQuery({ context: [], focus: pathology });
  expect(coded.diagnoses.has("mesh:D001749")).toBe(true);
  expect(coded.stage.diagnosed).toBe(true);
  const alone = patientQuery({
    context: [],
    focus: { ...pathology, parameters: {} },
  });
  expect(alone.diagnoses.size).toBe(0);
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
