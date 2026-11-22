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

test("keeps the strongest hit from a later page and breaks ties across pages", async () => {
  const all = Array.from({ length: 301 }, (_, i) =>
    paper(String(i).padStart(3, "0")),
  );
  all[300] = paper("300", [relation(drug, "treats", cancer)]);
  const paged = vi.fn(
    async (_sql: string, [, , after, size]: unknown[] = []) => {
      const start =
        after == null
          ? 0
          : all.findIndex((row) => row.document_id === after) + 1;
      return { rows: all.slice(start, start + Number(size)) };
    },
  );
  const match = createGraphMatcher({
    query: vi.fn().mockImplementation(paged),
  });
  const hits = await match.match(state(diagnosis, treated), { limit: 2 });
  expect(paged.mock.calls.length).toBeGreaterThan(1);
  expect(hits.map((hit) => hit.documentId)).toEqual(["300", "000"]);
  expect(hits[0].score).toBe(1);
  expect(hits[1].score).toBeLessThan(1);
});

const databaseUrl = testDatabaseUrl();
test.skipIf(!databaseUrl)(
  "PostgreSQL pages return only the entities and triples needed to rank eligible papers",
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
      const pages = await Promise.all(
        read.mock.results.map(({ value }) => value),
      );
      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0].rows[0]).toEqual({
        document_id: "pubmed:002",
        entities: { [cancer]: entities[cancer] },
        relations: [],
      });
      expect(pages.at(-1)?.rows.at(-1)).toEqual({
        document_id: "pubmed:130",
        entities: { [cancer]: entities[cancer], [drug]: entities[drug] },
        relations: [{ subject: drug, predicate: "treats", object: cancer }],
      });
      const timeline = {
        focus: { ...focus, type: "diagnosis", label: "PCa" },
        context: [],
      };
      expect((await rank.match(timeline, options))[0].documentId).toBe(
        "pubmed:002",
      );
    } finally {
      await db.drop();
    }
  },
);
