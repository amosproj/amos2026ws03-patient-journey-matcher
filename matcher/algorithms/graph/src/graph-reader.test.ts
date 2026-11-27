import { readFileSync } from "node:fs";
import type { JourneyState } from "@matcher/core";
import { expect, test } from "vitest";
import { DEFAULT_WEIGHTS, patientQuery } from "./query.ts";

const cancer = "mesh:D011471";
const drug = "mesh:C531550";
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
  expect(q.stage.flags.psaWorkup).toBe(true);
  expect(graphQuery([indicates, diagnosis], [test]).stage.flags.psaWorkup).toBe(
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
  expect(
    graphQuery([diagnosis, pending], [surgery]).stage.flags.prostatectomy,
  ).toBe(false);
  expect(
    graphQuery([diagnosis, done], [surgery]).stage.flags.prostatectomy,
  ).toBe(true);
  expect(
    graphQuery([diagnosis, planned], [surgery]).stage.flags.prostatectomy,
  ).toBe(false);
  expect(
    graphQuery([diagnosis, done], [surgery], "2026-11-30").stage.flags
      .prostatectomy,
  ).toBe(false);
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
