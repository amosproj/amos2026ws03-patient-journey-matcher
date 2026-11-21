import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { normalizePatientGraph, parseDay } from "./patient.ts";
import { normalizePubTatorDocument } from "./pubtator.ts";

const patient5 = normalizePatientGraph(
  JSON.parse(
    readFileSync(
      new URL("../../../../patientdata/Patient-5/graph.json", import.meta.url),
      "utf8",
    ),
  ),
);

const entity = (id: string) => patient5.entities.find((one) => one.id === id);

test("the two prostate cancer nodes and the adenocarcinoma become one entity", () => {
  expect(entity("mesh:D011471")).toMatchObject({
    type: "disease",
    name: "Prostatic Neoplasms",
    resolvedBy: "curated",
    names: expect.arrayContaining([
      "C61 Prostatakarzinom",
      "prostate cancer",
      "Adenokarzinom der Prostata",
    ]),
  });
  expect(entity("mesh:D011471")?.sources).toHaveLength(3);
});

test("the concept fixes wrong labels: the catheter is a device, PSA a gene", () => {
  expect(entity("mesh:D062885")).toMatchObject({
    type: "device",
    labels: ["Medication"],
  });
  expect(entity("ncbigene:354")).toMatchObject({
    type: "gene",
    names: expect.arrayContaining([
      "PSA",
      "elevated PSA level",
      "PSA increase",
    ]),
  });
});

test("unresolved nodes have no ID and keep their names", () => {
  const unresolved = patient5.entities
    .filter(({ id }) => id === null)
    .map(({ name }) => name);
  expect(unresolved).toContain("PSMA-PET/CT imaging procedure");
  expect(unresolved).toContain("Biochemisches Rezidiv – Salvage-Therapie");
  expect(
    patient5.entities.every(
      ({ id, resolvedBy }) => (id === null) === (resolvedBy === null),
    ),
  ).toBe(true);
});

test("providers, appointments and vital signs are left out, and reported", () => {
  expect(
    patient5.entities.some(({ labels }) => labels.includes("Provider")),
  ).toBe(false);
  const reasons = new Set(patient5.skipped.map(({ reason }) => reason));
  expect(reasons).toContain("Provider nodes are left out");
  expect(reasons).toContain("VitalSigns nodes are left out");
});

test("patient facts: a diagnosis is suspected first, asserted after it was confirmed", () => {
  const diagnoses = patient5.facts
    .filter(
      ({ kind, entity }) =>
        kind === "has_condition" && entity === "mesh:D011471",
    )
    .sort((a, b) => (a.validAt ?? "").localeCompare(b.validAt ?? ""));
  expect(diagnoses[0]).toMatchObject({
    validAt: "2026-11-12",
    status: "suspected",
    cue: "verdacht auf",
  });
  // date_confirmed is 2026-12-08: later statements default to the node's `status: active`.
  expect(
    diagnoses
      .filter(({ validAt }) => (validAt ?? "") < "2026-12-08")
      .map(({ status }) => status),
  ).not.toContain("asserted");
  expect(diagnoses.at(-1)?.status).toBe("asserted");
});

test("INDICATES keeps the suspicion of its sentence", () => {
  const suspected = patient5.relations.filter(
    ({ predicate, object, status }) =>
      predicate === "indicates" &&
      object === "mesh:D011471" &&
      status === "suspected",
  );
  expect(suspected.map(({ cue }) => cue).sort()).toEqual([
    "suspected",
    "suspected",
    "suspicion of",
  ]);
});

test("treatment plans are planned, and no treats triple is made up", () => {
  expect(
    patient5.facts
      .filter(({ origin }) => origin.type === "HAS_TREATMENT_PLAN")
      .map(({ status }) => status),
  ).toEqual(["planned", "planned", "planned"]);
  // Patient-5 has no TREATED_BY edge; leuprorelin and prostate cancer stay two patient facts.
  expect(
    patient5.relations.some(({ predicate }) => predicate === "treats"),
  ).toBe(false);
  expect(
    patient5.facts.some(
      ({ kind, entity }) => kind === "receives" && entity === "mesh:D016729",
    ),
  ).toBe(true);
});

test("TREATED_BY is flipped to drug treats disease", () => {
  const graph = normalizePatientGraph({
    nodes: [
      { uuid: "p", name: "Patient-X", labels: ["Entity", "Patient"] },
      { uuid: "d", name: "Prostatakarzinom", labels: ["Entity", "Diagnosis"] },
      { uuid: "m", name: "Olaparib", labels: ["Entity", "Medication"] },
    ],
    edges: [
      {
        uuid: "e",
        name: "TREATED_BY",
        source_node_uuid: "d",
        target_node_uuid: "m",
        fact: "The prostate cancer is treated with olaparib.",
        valid_at: "2027-03-01T00:00:00Z",
      },
    ],
  });
  expect(graph.relations).toEqual([
    {
      subject: "mesh:C531550",
      predicate: "treats",
      object: "mesh:D011471",
      status: "unknown",
      cue: undefined,
      text: "The prostate cancer is treated with olaparib.",
      validAt: "2027-03-01",
      invalidAt: undefined,
      origin: { source: "patient", ref: "e", type: "TREATED_BY" },
    },
  ]);
});

test("an edge to a missing node is skipped, not a reason to reject the graph", () => {
  const graph = normalizePatientGraph({
    nodes: [{ uuid: "p", name: "Patient-X", labels: ["Entity", "Patient"] }],
    edges: [
      {
        uuid: "e",
        name: "HAS_DIAGNOSIS",
        source_node_uuid: "p",
        target_node_uuid: "gone",
      },
    ],
  });
  expect(graph.skipped).toEqual([
    {
      ref: "e",
      type: "HAS_DIAGNOSIS",
      reason: "points to a node that is not in the graph",
    },
  ]);
});

test.each([
  ["2026-12-08", "2026-12-08"],
  ["2027-01-22T00:30:00+02:00", "2027-01-22"],
  ["December 8, 2026", "2026-12-08"],
  ["8. Dezember 2026", "2026-12-08"],
  ["sometime", undefined],
  [null, undefined],
])("parseDay(%j) = %j", (value, expected) => {
  expect(parseDay(value)).toBe(expected);
});

// The point of #80: both sides end up on the same IDs and predicates.
test("Patient-5's diagnosis and the paper's disease have the same ID", () => {
  const paper = normalizePubTatorDocument(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/pubtator/32343890.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const ids = new Set(paper.entities.map(({ id }) => id));
  expect(ids.has(entity("mesh:D011471")?.id ?? null)).toBe(true);
});

test("a patient treats triple equals the paper's, a drug for another disease does not", () => {
  const patient = normalizePatientGraph({
    nodes: [
      {
        uuid: "d",
        name: "C61 Prostatakarzinom",
        labels: ["Entity", "Diagnosis"],
        attributes: { icd_code: "C61" },
      },
      { uuid: "m", name: "Olaparib", labels: ["Entity", "Medication"] },
    ],
    edges: [
      {
        uuid: "e",
        name: "TREATED_BY",
        source_node_uuid: "d",
        target_node_uuid: "m",
      },
    ],
  });
  const key = ({
    subject,
    predicate,
    object,
  }: {
    subject: string;
    predicate: string;
    object: string;
  }) => `${subject} ${predicate} ${object}`;
  const [triple] = patient.relations.map(key);
  const read = (pmid: string) =>
    normalizePubTatorDocument(
      JSON.parse(
        readFileSync(
          new URL(`../fixtures/pubtator/${pmid}.json`, import.meta.url),
          "utf8",
        ),
      ),
    ).relations.map(key);

  expect(read("32343890")).toContain(triple);
  expect(read("30345884")).not.toContain(triple);
});

// Regressions of the review of #80.
const node = (
  uuid: string,
  name: string,
  label: string,
  attributes?: Record<string, unknown>,
) => ({ uuid, name, labels: ["Entity", label], attributes });
const edge = (
  uuid: string,
  name: string,
  source: string,
  target: string,
  fact?: string,
  validAt = "2027-01-10T00:00:00Z",
) => ({
  uuid,
  name,
  source_node_uuid: source,
  target_node_uuid: target,
  fact,
  valid_at: validAt,
});

test("Patient-5: its pathology result confirms the diagnosis it merged into", () => {
  expect(patient5.skipped).toContainEqual({
    ref: "7f82e9fa-0dc2-40c8-bd05-bb6d414c41aa",
    type: "CONFIRMED_BY",
    reason: "both ends are the same entity; confirms it from 2026-12-08",
  });
});

test("CONFIRMED_BY onto the same entity asserts its later unknown conditions only", () => {
  const graph = normalizePatientGraph({
    nodes: [
      node("p", "Patient-X", "Patient"),
      node("d", "Prostatakarzinom", "Diagnosis"),
      node("r", "Adenokarzinom der Prostata", "PathologyResult"),
    ],
    edges: [
      edge(
        "before",
        "HAS_DIAGNOSIS",
        "p",
        "d",
        "Prostatakarzinom.",
        "2027-01-01",
      ),
      edge("confirm", "CONFIRMED_BY", "r", "d", undefined, "2027-01-05"),
      edge(
        "after",
        "HAS_DIAGNOSIS",
        "p",
        "d",
        "Prostatakarzinom.",
        "2027-01-10",
      ),
      edge(
        "cued",
        "HAS_DIAGNOSIS",
        "p",
        "d",
        "Verdacht auf Prostatakarzinom.",
        "2027-01-11",
      ),
    ],
  });
  const status = Object.fromEntries(
    graph.facts.map((fact) => [fact.origin.ref, [fact.status, fact.cue]]),
  );
  expect(status).toEqual({
    before: ["unknown", undefined],
    after: ["asserted", "CONFIRMED_BY"],
    cued: ["suspected", "verdacht auf"],
  });
});

test("TREATED_BY reads its status about the disease", () => {
  const graph = normalizePatientGraph({
    nodes: [
      node("d", "Prostatakarzinom", "Diagnosis"),
      node("m", "Olaparib", "Medication"),
    ],
    edges: [
      edge(
        "e",
        "TREATED_BY",
        "d",
        "m",
        "The prostate cancer is not treated with olaparib.",
      ),
    ],
  });
  expect(graph.relations[0]).toMatchObject({
    predicate: "treats",
    status: "negated",
    cue: "not treated with",
  });
});

test("an allergy related to the patient is a condition; other patient edges without a row are reported", () => {
  const graph = normalizePatientGraph({
    nodes: [
      node("p", "Patient-X", "Patient"),
      node("a", "Penicillin", "Allergy"),
      node("x", "Something", "Entity"),
    ],
    edges: [
      edge("allergy", "RELATES_TO", "p", "a"),
      edge("other", "RELATES_TO", "p", "x"),
    ],
  });
  expect(graph.facts.map(({ kind, origin }) => [kind, origin.ref])).toEqual([
    ["has_condition", "allergy"],
  ]);
  expect(graph.skipped).toEqual([
    {
      ref: "other",
      type: "RELATES_TO",
      reason: "no row for this patient edge",
    },
  ]);
});

test("unresolved nodes merge by name; a name with nothing left merges with nothing", () => {
  const graph = normalizePatientGraph({
    nodes: [
      node("a", "Knochenschmerz links", "Symptom"),
      node("b", "knochenschmerz  LINKS", "Symptom"),
      node("c", "(C61)", "Symptom"),
      node("d", "–", "LabTest"),
    ],
    edges: [edge("e", "RELATES_TO", "c", "d")],
  });
  expect(graph.entities.map(({ key, sources }) => [key, sources])).toEqual([
    ["name:knochenschmerz links", ["a", "b"]],
    ["node:c", ["c"]],
    ["node:d", ["d"]],
  ]);
  expect(graph.relations).toMatchObject([
    { subject: "node:c", predicate: "related", object: "node:d" },
  ]);
});

test("a node or edge that cannot be read is reported, the rest is kept", () => {
  const graph = normalizePatientGraph({
    nodes: [
      node("p", "Patient-X", "Patient"),
      node("d", "Prostatakarzinom", "Diagnosis"),
      { uuid: "bad", name: null, labels: ["Symptom"] },
    ],
    edges: [
      edge("e", "HAS_DIAGNOSIS", "p", "d"),
      { uuid: "broken", name: "HAS_SYMPTOM" },
    ],
  });
  expect(graph.facts).toHaveLength(1);
  expect(graph.skipped.map(({ ref, type }) => [ref, type])).toEqual([
    ["bad", "node"],
    ["broken", "edge"],
  ]);
  expect(graph.skipped[0].reason).toMatch(/^not readable: name /);
  expect(() => normalizePatientGraph({ nodes: [] })).toThrow();
});

test.each([
  ["2026-13-45", undefined],
  ["2026-02-31", undefined],
  ["February 30, 2026", undefined],
  ["29. Februar 2028", "2028-02-29"],
])(
  "parseDay(%j) = %j: a day that does not exist is none",
  (value, expected) => {
    expect(parseDay(value)).toBe(expected);
  },
);

test("an unresolved name with a leading code is the same entity without it, and found by it", () => {
  const graph = normalizePatientGraph({
    nodes: [
      node("p", "Patient-X", "Patient"),
      node("a", "Z99 Seltene Krankheit", "Diagnosis"),
      node("b", "Seltene Krankheit", "Diagnosis"),
    ],
    edges: [
      edge("e", "HAS_DIAGNOSIS", "p", "a", "Verdacht auf seltene Krankheit."),
    ],
  });
  expect(graph.entities.map(({ key, sources }) => [key, sources])).toEqual([
    ["name:seltene krankheit", ["a", "b"]],
  ]);
  expect(graph.facts[0]).toMatchObject({ status: "suspected" });
});
