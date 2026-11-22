import { readFileSync } from "node:fs";
import type { JourneyState } from "@matcher/core";
import { createTestDatabase, testDatabaseUrl } from "@matcher/db/testing";
import { expect, test, vi } from "vitest";
import { paperFromAnnotations } from "./indexer.ts";
import { createGraphMatcher } from "./matcher.ts";
import { patientQuery } from "./query.ts";
import { ensureGraphSchema, type Paper } from "./schema.ts";
import type { Predicate } from "./types.ts";

const cancer = "mesh:D011471";
const drug = "mesh:C531550";
const otherDrug = "mesh:C540278";
const otherDisease = "mesh:D008113";
const gene = "ncbigene:675";
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
const treated = edge("TREATED_BY", "dx", "rx");
function state(
  ...edges: NonNullable<JourneyState["graph"]>["edges"]
): JourneyState {
  return { focus, context: [], graph: { nodes, edges } };
}

const entities: Paper["entities"] = {
  [cancer]: { name: "Prostatic Neoplasms", type: "disease" },
  [drug]: { name: "olaparib", type: "chemical" },
  [otherDrug]: { name: "enzalutamide", type: "chemical" },
  [otherDisease]: { name: "Liver Neoplasms", type: "disease" },
  [gene]: { name: "BRCA2", type: "gene" },
};
function relation(subject: string, predicate: Predicate, object: string) {
  return {
    subject,
    predicate,
    object,
    status: "asserted" as const,
    origin: { source: "pubtator" as const, ref: "1:R1", type: predicate },
  };
}
function paper(
  document_id: string,
  relations: Paper["relations"] = [],
  title: string[] = [],
) {
  return {
    document_id,
    relations,
    entities: Object.fromEntries(
      Object.entries(entities).map(([id, entity]) => [
        id,
        { ...entity, inTitle: title.includes(id) },
      ]),
    ),
  };
}
function matcher(papers: (Paper & { document_id: string })[]) {
  return createGraphMatcher({
    query: vi.fn().mockResolvedValue({ rows: papers }),
  });
}

const pubMedPapers = ["30345884", "32343890", "35923949"].map((pmid) => ({
  document_id: pmid,
  ...paperFromAnnotations(
    JSON.parse(
      readFileSync(
        new URL(`../fixtures/pubtator/${pmid}.json`, import.meta.url),
        "utf8",
      ),
    ),
  ),
}));

test("Patient-5 matches the two prostate cancer papers once the diagnosis is known", async () => {
  const graph = JSON.parse(
    readFileSync(
      new URL("../../../../patientdata/Patient-5/graph.json", import.meta.url),
      "utf8",
    ),
  );
  const matchOn = (as_of: string) =>
    matcher(pubMedPapers).match(
      {
        graph: { ...graph, as_of },
        focus: { ...focus, date: as_of },
        context: [],
      },
      { limit: 3 },
    );
  expect(await matchOn("2026-11-06")).toEqual([]);
  expect((await matchOn("2026-12-08")).map((hit) => hit.documentId)).toEqual([
    "32343890",
    "35923949",
  ]);
});

test("German synonyms and ICD codes reach the annotated papers, a shared drug alone does not", async () => {
  const input = state(diagnosis, received, treated);
  const match = () => matcher(pubMedPapers).match(input, { limit: 10 });
  expect((await match()).map((hit) => hit.documentId)).toEqual([
    "32343890",
    "35923949",
  ]);
  if (!input.graph) throw new Error("missing test graph");
  input.graph.nodes = nodes.map((node) =>
    node.uuid === "dx"
      ? { ...node, name: "Unmapped spelling", attributes: { icd_code: "C61" } }
      : node,
  );
  expect((await match())[0]).toMatchObject({
    documentId: "32343890",
    score: 1,
    explanation: expect.stringContaining("same relationship"),
  });
});

test("ranks directed treatment links above entity-only and wrong-disease overlaps", async () => {
  const papers = [
    paper("absent"),
    paper("wrong-disease", [relation(drug, "treats", otherDisease)]),
    paper("reversed", [relation(cancer, "treats", drug)]),
    paper("adverse", [relation(drug, "causes", cancer)]),
    paper("different-drug", [relation(otherDrug, "treats", cancer)]),
    paper("same", [relation(drug, "treats", cancer)]),
  ];
  const hits = await matcher(papers).match(
    state(diagnosis, received, treated),
    { limit: 10 },
  );
  expect(hits.map((hit) => hit.documentId)).toEqual([
    "same",
    "different-drug",
    "absent",
    "adverse",
    "reversed",
    "wrong-disease",
  ]);
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
  expect(hits[1].score).toBeGreaterThan(hits[2].score);
  expect(new Set(hits.slice(2).map((hit) => hit.score)).size).toBe(1);
  expect(hits[5].matchedTerms).toEqual(["Prostatic Neoplasms"]);
  const withoutIndication = await matcher(papers).match(
    state(diagnosis, received),
    { limit: 1 },
  );
  expect(withoutIndication[0].explanation).toContain(
    "journey also records this treatment",
  );
  const veto = { ...treated, fact: "Prostate cancer was ruled out." };
  const withNegation = await matcher(papers).match(
    state(diagnosis, received, veto),
    { limit: 10 },
  );
  expect(
    withNegation.find((hit) => hit.documentId === "same")?.matchedTerms,
  ).toEqual(["Prostatic Neoplasms"]);
  const noTherapy = await matcher(papers).match(state(diagnosis), {
    limit: 10,
  });
  expect(noTherapy[0].score).toBe(noTherapy[1].score);
});

test("a new therapy studied in the title outranks a background mention of the patient's therapy", async () => {
  const papers = [
    paper("background", [relation(drug, "treats", cancer)], [cancer]),
    paper(
      "central",
      [relation(otherDrug, "treats", cancer)],
      [cancer, otherDrug],
    ),
  ];
  const [hit] = await matcher(papers).match(
    state(diagnosis, received, treated),
    { limit: 1 },
  );
  expect(hit).toMatchObject({
    documentId: "central",
    score: 1,
    explanation: expect.stringContaining("Both concepts occur in the title"),
  });
});

test("a finding adds context only when a paper links it to the matching diagnosis", async () => {
  const papers = [
    paper("linked", [relation(gene, "associated_with", cancer)]),
    paper("elsewhere", [relation(gene, "associated_with", otherDisease)]),
  ];
  const hits = await matcher(papers).match(
    state(diagnosis, edge("HAD_LAB_TEST", "p", "gene")),
    { limit: 2 },
  );
  expect(hits[0].documentId).toBe("linked");
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
});

test("uses the latest active status at the requested cutoff and excludes future and undated facts", async () => {
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
    patientQuery({
      focus,
      context: [],
      graph: {
        nodes,
        as_of,
        edges: [
          negated,
          diagnosis,
          prior,
          { ...received, invalid_at: "2026-12-15" },
          { ...treated, valid_at: null },
        ],
      },
    });
  expect(forDay("2026-11-01").diagnoses.size).toBe(0);
  expect(forDay("2026-12-08").diagnoses.get(cancer)).toBeGreaterThan(
    forDay("2026-11-06").diagnoses.get(cancer) ?? 0,
  );
  expect(forDay("2026-12-08").treatments.has(drug)).toBe(true);
  expect(forDay("2026-12-15").treatments.size).toBe(0);
  expect(forDay("2027-01-01").diagnoses.size).toBe(0);
  expect(forDay("2026-12-08").relations.size).toBe(0);
  expect(
    await matcher([paper("a")]).match(state(received), { limit: 1 }),
  ).toEqual([]);
});

test("a timeline matches diagnosis entities only and keeps a deterministic order on ties", async () => {
  const papers = [paper("b", [relation(drug, "treats", cancer)]), paper("a")];
  const hits = await matcher(papers).match(
    {
      focus,
      context: [
        {
          ...focus,
          id: "prior",
          date: "2026-10-01",
          type: "diagnosis",
          label: "PCa",
        },
      ],
    },
    { limit: 2 },
  );
  expect(hits.map(({ documentId, score }) => [documentId, score])).toEqual([
    ["a", 1],
    ["b", 1],
  ]);
  expect(hits[1].explanation).toBe(
    "Matched the diagnosis Prostatic Neoplasms.",
  );
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
    expect(query.details.has("mesh:D005221")).toBe(true);
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

test("later timeline statements update the named patient diagnosis only", async () => {
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
  expect([...query.diagnoses.keys()]).toEqual([otherDisease]);
  expect(
    await matcher(pubMedPapers).match(
      { context: context.slice(0, 1), focus: followup },
      { limit: 1 },
    ),
  ).toEqual([]);
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

test("keeps the strongest hits with deterministic tie-breaking and traces the normalized query", async () => {
  const all = Array.from({ length: 301 }, (_, i) =>
    paper(String(i).padStart(3, "0")),
  );
  all[300] = paper("300", [relation(drug, "treats", cancer)]);
  const steps: [string, unknown][] = [];
  const hits = await matcher(all).match(state(diagnosis, treated), {
    limit: 2,
    trace: (step, data) => steps.push([step, data]),
  });
  expect(hits.map((hit) => hit.documentId)).toEqual(["300", "000"]);
  expect(hits[0].score).toBe(1);
  expect(hits[1].score).toBeLessThan(1);
  expect(steps).toEqual([
    [
      "query",
      expect.objectContaining({
        cutoff: date,
        conceptOnly: false,
        diagnoses: { [cancer]: 1.2 },
      }),
    ],
  ]);
});

test("a title-level finding link does not outrank an abstract treatment match", async () => {
  const papers = [
    paper(
      "psa-title",
      [relation(gene, "associated_with", cancer)],
      [cancer, gene],
    ),
    paper("treatment-abstract", [relation(drug, "treats", cancer)], [cancer]),
  ];
  const hits = await matcher(papers).match(
    state(diagnosis, received, edge("HAD_LAB_TEST", "p", "gene")),
    { limit: 2 },
  );
  expect(hits.map((hit) => hit.documentId)).toEqual([
    "treatment-abstract",
    "psa-title",
  ]);
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
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
  const query = patientQuery({
    focus: { ...focus, date: "2027-06-01" },
    context: [],
    graph: { nodes, edges: [followup, confirmed] },
  });
  expect(query.diagnoses.get(cancer)).toBeCloseTo(1.2);

  const suspected = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Suspected prostate cancer.",
    "2026-11-06",
  );
  const suspectedFollowup = patientQuery({
    focus: { ...focus, date: "2027-06-01" },
    context: [],
    graph: { nodes, edges: [suspected, followup] },
  });
  expect(suspectedFollowup.diagnoses.get(cancer)).toBeCloseTo(0.45 * 1.2);

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
  expect(p13.diagnoses.get(cancer)).toBeCloseTo(1.2);
  // Unresolved `name:...` triples are never added to `query.relations`.
  for (const key of p13.relations.keys()) {
    const [subject, , object] = JSON.parse(key) as [string, string, string];
    expect(subject.startsWith("name:")).toBe(false);
    expect(object.startsWith("name:")).toBe(false);
  }

  // Timeline follow-up mentioning the diagnosis without a cue keeps confirmed status too.
  const timelineQuery = patientQuery({
    context: [
      {
        ...focus,
        id: "e1",
        date: "2026-12-08",
        type: "diagnosis",
        label: "Prostate cancer confirmed.",
      },
    ],
    focus: {
      ...focus,
      id: "e2",
      date: "2027-06-01",
      type: "followup",
      label: "Routine check",
      parameters: { diagnosis: "Prostate cancer" },
    },
  });
  expect(timelineQuery.diagnoses.get(cancer)).toBeCloseTo(1.2);
});

test("extracts mapped diagnoses from real synthetic timeline.json phrases", () => {
  const readTimeline = (patient: string) =>
    JSON.parse(
      readFileSync(
        new URL(
          `../../../../patientdata/${patient}/timeline.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  const queryFor = (patient: string) => {
    const timeline = readTimeline(patient);
    const events = timeline.events;
    return patientQuery({
      focus: events.at(-1),
      context: events.slice(0, -1),
    });
  };
  expect(queryFor("Patient-5").diagnoses.has(cancer)).toBe(true);
  expect(queryFor("Patient-7").diagnoses.has("mesh:D064129")).toBe(true);
  expect(queryFor("Patient-10").diagnoses.has("mesh:D064129")).toBe(true);
});

test("weights focus-day evidence higher and caps multi-diagnosis and multi-relation bonuses", async () => {
  const dx2 = { uuid: "dx2", labels: ["Diagnosis"], name: "Liver metastases" };
  const dx3 = { uuid: "dx3", labels: ["Diagnosis"], name: "Bone metastases" };
  const dx4 = {
    uuid: "dx4",
    labels: ["Diagnosis"],
    name: "Lymph node metastases",
  };
  const multiNodes = [...nodes, dx2, dx3, dx4];
  const onFocus = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Confirmed prostate cancer.",
    date,
  );
  const earlier = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx2",
    "Confirmed liver metastases.",
    "2026-10-01",
  );
  const focusCheck = patientQuery({
    focus,
    context: [],
    graph: { nodes: multiNodes, edges: [onFocus, earlier] },
  });
  expect(focusCheck.diagnoses.get(cancer)).toBeGreaterThan(
    focusCheck.diagnoses.get(otherDisease) ?? 0,
  );

  // Multi-relation bonus increases from 1 -> 2 -> 3 relations and caps at 3 (connected - 1 capped at 2).
  const d3 = "mesh:D001859";
  const d4 = "mesh:D008207";
  const richEntities: Paper["entities"] = {
    ...entities,
    [d3]: { name: "Bone Neoplasms", type: "disease" },
    [d4]: { name: "Lymphatic Metastasis", type: "disease" },
    "mesh:C089740": { name: "abiraterone", type: "chemical" },
    "mesh:D000077143": { name: "Docetaxel", type: "chemical" },
    "mesh:C552428": { name: "cabazitaxel", type: "chemical" },
  };
  const makeRich = (
    document_id: string,
    relations: Paper["relations"],
    keepEntities: string[] = [
      cancer,
      drug,
      otherDrug,
      "mesh:C089740",
      "mesh:D000077143",
      "mesh:C552428",
    ],
  ) => ({
    document_id,
    relations,
    entities: Object.fromEntries(
      keepEntities.map((id) => [id, richEntities[id]]),
    ),
  });
  const relPapers = [
    makeRich("r1", [relation(drug, "treats", cancer)]),
    makeRich("r2", [
      relation(drug, "treats", cancer),
      relation(otherDrug, "treats", cancer),
    ]),
    makeRich("r3", [
      relation(drug, "treats", cancer),
      relation(otherDrug, "treats", cancer),
      relation("mesh:C089740", "treats", cancer),
    ]),
    makeRich("r4", [
      relation(drug, "treats", cancer),
      relation(otherDrug, "treats", cancer),
      relation("mesh:C089740", "treats", cancer),
      relation("mesh:D000077143", "treats", cancer),
    ]),
  ];
  const relHits = await matcher(relPapers).match(state(diagnosis), {
    limit: 4,
  });
  const byId = new Map(relHits.map((hit) => [hit.documentId, hit.score]));
  expect(byId.get("r2")).toBeGreaterThan(byId.get("r1") ?? 0);
  expect(byId.get("r3")).toBeGreaterThan(byId.get("r2") ?? 0);
  expect(byId.get("r4")).toBeCloseTo(byId.get("r3") ?? 0);

  // Multi-diagnosis bonus increases from 1 -> 2 -> 3 diagnoses and caps at 3 (diagnoses - 1 capped at 2).
  const allDxState: JourneyState = {
    focus,
    context: [],
    graph: {
      nodes: multiNodes,
      edges: [
        onFocus,
        earlier,
        edge(
          "HAS_DIAGNOSIS",
          "p",
          "dx3",
          "Confirmed bone metastases.",
          "2026-10-01",
        ),
        edge(
          "HAS_DIAGNOSIS",
          "p",
          "dx4",
          "Confirmed lymph node metastases.",
          "2026-10-01",
        ),
      ],
    },
  };
  const dxPapers = [
    makeRich("d1", [], [cancer]),
    makeRich("d2", [], [cancer, otherDisease]),
    makeRich("d3", [], [cancer, otherDisease, d3]),
    makeRich("d4", [], [cancer, otherDisease, d3, d4]),
  ];
  const dxHits = await matcher(dxPapers).match(allDxState, { limit: 4 });
  const dxScore = new Map(dxHits.map((hit) => [hit.documentId, hit.score]));
  expect(dxScore.get("d2")).toBeGreaterThan(dxScore.get("d1") ?? 0);
  expect(dxScore.get("d3")).toBeGreaterThan(dxScore.get("d2") ?? 0);
  expect(dxScore.get("d4")).toBeCloseTo(dxScore.get("d3") ?? 0);
});

const databaseUrl = testDatabaseUrl();
test.skipIf(!databaseUrl)(
  "PostgreSQL single query returns only relevant relation rows plus top limit diagnosis-only fallbacks",
  async () => {
    const db = await createTestDatabase(databaseUrl as string);
    try {
      await ensureGraphSchema(db.pool);
      await db.pool.query(`WITH ids AS (
      SELECT lpad(n::text, 3, '0') AS pmid FROM generate_series(0, 130) AS n
    )
    INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at, expires_at)
    SELECT 'pubmed:' || pmid, 'pubmed', pmid,
           CASE WHEN pmid = '001' THEN 'preprint' ELSE 'journal_article' END,
           'Title', 'https://example.org', now(), CASE WHEN pmid = '000' THEN now() END FROM ids`);
      const unrelated = relation(gene, "associated_with", otherDisease);
      const treatment = relation(drug, "treats", cancer);
      await db.pool.query(
        `INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at)
       SELECT id, changed_at, $1::jsonb, CASE WHEN native_id = '130' THEN $2::jsonb ELSE $3::jsonb END,
              'infinity'::timestamptz FROM documents`,
        [
          JSON.stringify(entities),
          JSON.stringify([unrelated, treatment]),
          JSON.stringify([unrelated]),
        ],
      );
      const read = vi.fn((sql: string, values?: unknown[]) =>
        db.pool.query(sql, values),
      );
      const rank = createGraphMatcher({ query: read });
      const options = { limit: 1, contentTypes: ["journal_article"] };
      const best = await rank.match(state(diagnosis, treated), options);
      expect(best[0].documentId).toBe("pubmed:130");
      expect(read).toHaveBeenCalledTimes(1);
      const { rows } = await read.mock.results[0].value;
      // 1 relation-bearing row (pubmed:130) + at most limit (1) diagnosis-only row (pubmed:002).
      expect(rows).toEqual([
        {
          document_id: "pubmed:130",
          entities: { [cancer]: entities[cancer], [drug]: entities[drug] },
          relations: [{ subject: drug, predicate: "treats", object: cancer }],
        },
        {
          document_id: "pubmed:002",
          entities: { [cancer]: entities[cancer] },
          relations: [],
        },
      ]);
      const timeline = {
        focus: { ...focus, type: "diagnosis", label: "PCa" },
        context: [],
      };
      expect((await rank.match(timeline, options))[0].documentId).toBe(
        "pubmed:002",
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect((await read.mock.results[1].value).rows).toHaveLength(1);
    } finally {
      await db.drop();
    }
  },
);
