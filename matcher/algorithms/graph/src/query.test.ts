import type { JourneyState } from "@matcher/core";
import { expect, test } from "vitest";
import { DEFAULT_WEIGHTS, patientQuery } from "./query.ts";

const cancer = "mesh:D011471";
const crpc = "mesh:D064129";
const drug = "mesh:C531550";
const date = "2026-12-08";
const focus = { id: date, date, label: "follow-up", type: "facts" };

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
    return [timeline.histologies[0]?.observed, graph.histologies[0]?.observed];
  };
  const nsclc = "mesh:D002289";
  expect(subtypes(history, "2026-01-01")).toEqual([undefined, undefined]);
  expect(subtypes(history, "2026-01-02")).toEqual([nsclc, nsclc]);
  expect(subtypes(history, "2026-01-03")).toEqual([nsclc, nsclc]);
  expect(subtypes(history, "2026-01-04")).toEqual([undefined, undefined]);
  const expiring = [dx, { ...biopsy, invalid_at: "2026-01-03" }];
  expect(
    graphQuery(expiring, [lung, report], "2026-01-02").histologies[0]?.observed,
  ).toBe(nsclc);
  expect(
    graphQuery(expiring, [lung, report], "2026-01-03").histologies,
  ).toEqual([]);

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
    expect(restored.histologies[0]?.observed).toBe(small);
  },
);

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
