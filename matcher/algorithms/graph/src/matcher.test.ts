import { readFileSync } from "node:fs";
import type { JourneyState, MatchOptions } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { createTestDatabase, testDatabaseUrl } from "@matcher/db/testing";
import { expect, test, vi } from "vitest";
import { paperFromAnnotations } from "./indexer.ts";
import { createGraphMatcher } from "./matcher.ts";
import { ensureGraphSchema, MESH_MAJOR, MESH_MINOR } from "./schema.ts";
import type { Triple } from "./types.ts";

const cancer = "mesh:D011471";
const crpc = "mesh:D064129";
const olaparib = "mesh:C531550";
const prostatectomy = "mesh:D011468";
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

type Graph = NonNullable<JourneyState["graph"]>;
const nodes: Graph["nodes"] = [
  { uuid: "p", labels: ["Patient"], name: "Synthetic" },
  { uuid: "dx", labels: ["Diagnosis"], name: "Prostatakarzinom" },
  { uuid: "rx", labels: ["Medication"], name: "Olaparib" },
  { uuid: "rp", labels: ["Procedure"], name: "radical prostatectomy" },
  { uuid: "psa", labels: ["TumorMarker"], name: "PSA" },
];
const diagnosis = edge(
  "HAS_DIAGNOSIS",
  "p",
  "dx",
  "Confirmed prostate cancer.",
  "2026-10-01",
);
function state(...edges: Graph["edges"]): JourneyState {
  return { focus, context: [], graph: { nodes, edges } };
}
// Prostate cancer since October, olaparib started on the focus day.
const onOlaparib = state(diagnosis, edge("PRESCRIBED", "p", "rx"));

/** A paper as the SQL would return it: its evidence by concept ID, and what the rerank reads. */
type Paper = {
  id: string;
  evidence?: Record<string, number>;
  title?: string;
  published?: string;
  types?: string[];
  mesh?: Record<string, number>;
  relations?: Triple[];
};

/**
 * A database that answers like the SQL of the matcher: per concept group the strongest evidence
 * of the paper, the score as the sum of weight × evidence × IDF (`idf` per concept ID, else 1).
 */
function database(papers: Paper[], idf: Record<string, number> = {}) {
  const query = vi.fn(async (_sql: string, values?: unknown[]) => {
    const [groups, ids, weights] = values as [number[], string[], number[]];
    const groupIdf: Record<number, number> = {};
    const groupWeight: Record<number, number> = {};
    ids.forEach((id, index) => {
      groupIdf[groups[index]] ??= idf[id] ?? 1;
      groupWeight[groups[index]] = weights[index];
    });
    const rows = papers.map((paper) => {
      const matched: Record<number, number> = {};
      ids.forEach((id, index) => {
        const strength = paper.evidence?.[id];
        if (strength !== undefined)
          matched[groups[index]] = Math.max(
            matched[groups[index]] ?? 0,
            strength,
          );
      });
      const score = Object.entries(matched).reduce(
        (sum, [group, strength]) =>
          sum + groupWeight[Number(group)] * strength * groupIdf[Number(group)],
        0,
      );
      return {
        document_id: paper.id,
        score,
        matched,
        idf: groupIdf,
        title: paper.title ?? "A study",
        published: paper.published ?? "2020-01-01",
        publication_types: paper.types ?? ["Journal Article"],
        entities: {},
        relations: paper.relations ?? [],
        mesh: paper.mesh ?? {},
      };
    });
    return { rows };
  });
  // Only `rows` of a pg result is read.
  return { query } as unknown as Queryable & { query: typeof query };
}

const rank = (
  papers: Paper[],
  input: JourneyState = onOlaparib,
  options: Partial<MatchOptions> = {},
  idf: Record<string, number> = { [cancer]: 0.01 },
) =>
  createGraphMatcher(database(papers, idf)).match(input, {
    limit: 10,
    ...options,
  });
const order = (hits: { documentId: string }[]) =>
  hits.map((hit) => hit.documentId);

test("the patient's current drug beats the diagnosis alone; a paper on another topic loses", async () => {
  const hits = await rank([
    { id: "diagnosis", evidence: { [cancer]: 1 } },
    { id: "drug-abstract", evidence: { [cancer]: 0.4, [olaparib]: 1 } },
    { id: "drug", evidence: { [cancer]: 1, [olaparib]: 1 } },
  ]);
  expect(order(hits)).toEqual(["drug", "drug-abstract", "diagnosis"]);
  expect(hits[0]).toMatchObject({
    score: 1,
    matchedTerms: ["Prostatic Neoplasms", "olaparib"],
    explanation: expect.stringContaining("Matches olaparib"),
  });
  expect(hits[2].score).toBeLessThan(hits[1].score);
});

test("a paper on a state the patient is not in falls behind, one on his state rises", async () => {
  // After a prostatectomy, castration resistance is not his situation.
  const operated = state(diagnosis, edge("UNDERWENT", "p", "rp"));
  const papers = [
    {
      id: "crpc",
      title: "Prostatectomy in castration-resistant prostate cancer",
      evidence: { [cancer]: 1, [prostatectomy]: 1 },
    },
    { id: "plain", evidence: { [cancer]: 1, [prostatectomy]: 1 } },
  ];
  const hits = await rank(papers, operated);
  expect(order(hits)).toEqual(["plain", "crpc"]);
  expect(hits[1].explanation).toContain("another disease state");
  const resistant = {
    uuid: "r",
    labels: ["Diagnosis"],
    name: "kastrationsresistentes Prostatakarzinom",
  };
  const castrationResistant: JourneyState = {
    focus,
    context: [],
    graph: {
      nodes: [...nodes, resistant],
      edges: [
        diagnosis,
        edge("UNDERWENT", "p", "rp"),
        edge("HAS_DIAGNOSIS", "p", "r", "", "2026-11-01"),
      ],
    },
  };
  const fitting = await rank(papers, castrationResistant);
  expect(order(fitting)).toEqual(["crpc", "plain"]);
  expect(fitting[0].explanation).toContain("the patient's disease state");
});

test("treatment papers wait for a treatment decision", async () => {
  // Only a PSA value so far: the patient is still being diagnosed.
  const workup = state(diagnosis, edge("HAS_TUMOR_MARKER", "p", "psa"));
  const papers = [
    {
      id: "surgery",
      evidence: { [cancer]: 1, "ncbigene:354": 1 },
      mesh: { [prostatectomy]: MESH_MAJOR },
    },
    { id: "psa", evidence: { [cancer]: 1, "ncbigene:354": 0.5 } },
  ];
  expect(order(await rank(papers, workup))).toEqual(["psa", "surgery"]);
  const decided = state(
    diagnosis,
    edge("HAS_TUMOR_MARKER", "p", "psa"),
    edge("HAS_TREATMENT_PLAN", "p", "rp", "Radical prostatectomy is planned."),
  );
  expect(order(await rank(papers, decided))).toEqual(["surgery", "psa"]);
});

test("lab research, the other sex, another cancer and a treatment he did not get rank lower", async () => {
  const same = { [cancer]: 1, [olaparib]: 1 };
  const hits = await rank([
    {
      id: "lab",
      evidence: same,
      mesh: { "mesh:D045744": MESH_MINOR, "mesh:D051379": MESH_MINOR },
    },
    { id: "women", evidence: same, mesh: { "mesh:D005260": MESH_MINOR } },
    {
      id: "ovarian",
      evidence: same,
      mesh: { "mesh:D010051": MESH_MAJOR, [cancer]: MESH_MINOR },
    },
    {
      id: "brachytherapy",
      evidence: same,
      mesh: { "mesh:D001918": MESH_MAJOR },
    },
    {
      id: "patients",
      evidence: same,
      mesh: { "mesh:D008297": MESH_MINOR, "mesh:D000368": MESH_MINOR },
    },
  ]);
  expect(hits[0].documentId).toBe("patients");
  const reasons = Object.fromEntries(
    hits.map((hit) => [hit.documentId, hit.explanation]),
  );
  expect(reasons.lab).toContain("Lab or animal research");
  expect(reasons.women).toContain("other sex");
  expect(reasons.ovarian).toContain("another disease");
  expect(reasons.brachytherapy).toContain("did not get");
});

test("a guideline outranks a case report on the same concepts", async () => {
  const same = { [cancer]: 1, [olaparib]: 1 };
  const hits = await rank([
    { id: "case", evidence: same, types: ["Case Reports"] },
    { id: "article", evidence: same },
    { id: "guideline", evidence: same, types: ["Practice Guideline"] },
  ]);
  expect(order(hits)).toEqual(["guideline", "article", "case"]);
  const flat = await rank(
    [
      { id: "case", evidence: same, types: ["Case Reports"] },
      { id: "guideline", evidence: same, types: ["Practice Guideline"] },
    ],
    onOlaparib,
    { tuning: { format: 0 } },
  );
  expect(flat[0].score).toBe(flat[1].score);
});

test("PubTator3 linking the patient's drug to his diagnosis adds weight", async () => {
  const same = { [cancer]: 1, [olaparib]: 1 };
  const hits = await rank([
    { id: "mention", evidence: same },
    {
      id: "linked",
      evidence: same,
      relations: [{ subject: olaparib, predicate: "treats", object: cancer }],
    },
  ]);
  expect(order(hits)).toEqual(["linked", "mention"]);
  expect(hits[0].explanation).toContain("links the patient's drug");
});

test("ties go to the older paper, then by ID", async () => {
  const same = { [cancer]: 1, [olaparib]: 1 };
  const hits = await rank(
    [
      { id: "b", evidence: same, published: "2021-01-01" },
      { id: "c", evidence: same, published: "2010-01-01" },
      { id: "a", evidence: same, published: "2021-01-01" },
    ],
    onOlaparib,
    { limit: 2 },
  );
  expect(order(hits)).toEqual(["c", "a"]);
  expect(hits.map((hit) => hit.score)).toEqual([1, 1]);
});

test("tuning sets ranking constants within their range; the trace lists settings, query and pool", async () => {
  const steps: string[] = [];
  const db = database([{ id: "a", evidence: { [cancer]: 1 } }]);
  const matcher = createGraphMatcher(db);
  await matcher.match(onOlaparib, {
    limit: 1,
    tuning: { candidates: 50 },
    trace: (step) => steps.push(step),
  });
  expect(steps).toEqual(["settings", "query", "pool"]);
  expect(db.query.mock.calls[0][1]?.at(-1)).toBe(50);
  await expect(
    matcher.match(onOlaparib, { limit: 1, tuning: { candidates: 0.5 } }),
  ).rejects.toThrow(RangeError);
});

test("without a diagnosis the matcher returns nothing and asks the database nothing", async () => {
  const db = database([{ id: "a", evidence: { [cancer]: 1 } }]);
  expect(
    await createGraphMatcher(db).match(state(edge("PRESCRIBED", "p", "rx")), {
      limit: 1,
    }),
  ).toEqual([]);
  expect(db.query).not.toHaveBeenCalled();
});

const databaseUrl = testDatabaseUrl();
test.skipIf(!databaseUrl)(
  "PostgreSQL: candidates by diagnosis or a narrower form, strongest evidence, inverse frequency",
  async () => {
    const db = await createTestDatabase(databaseUrl as string);
    try {
      await ensureGraphSchema(db.pool);
      const papers: [
        string,
        Record<string, unknown>,
        Record<string, number>,
        string?,
      ][] = [
        // The diagnosis in the title and the patient's surgery as a major topic.
        [
          "1",
          { [cancer]: { type: "disease", inTitle: true } },
          { [prostatectomy]: MESH_MAJOR },
        ],
        // The surgery only as a minor heading.
        [
          "0",
          { [cancer]: { type: "disease", inTitle: true } },
          { [prostatectomy]: MESH_MINOR },
        ],
        // The diagnosis alone.
        ["3", { [cancer]: { type: "disease" } }, {}],
        // A narrower form only, as a MeSH heading.
        ["4", {}, { [crpc]: MESH_MAJOR }],
        // Another disease: no candidate.
        [
          "5",
          { "mesh:D001943": { type: "disease" } },
          { [prostatectomy]: MESH_MAJOR },
        ],
        // Expired, and a preprint.
        [
          "6",
          { [cancer]: { type: "disease" } },
          { [prostatectomy]: MESH_MAJOR },
          "expired",
        ],
        [
          "7",
          { [cancer]: { type: "disease" } },
          { [prostatectomy]: MESH_MAJOR },
          "preprint",
        ],
      ];
      for (const [pmid, entities, mesh, kind] of papers) {
        await db.pool.query(
          `INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at, expires_at)
           VALUES ($1, 'pubmed', $2, $3, 'Title', 'https://example.org', now(), $4)`,
          [
            `pubmed:${pmid}`,
            pmid,
            kind === "preprint" ? "preprint" : "journal_article",
            kind === "expired" ? new Date(Date.now() - 1000) : null,
          ],
        );
        await db.pool.query(
          `INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at, mesh)
           SELECT id, changed_at, $2::jsonb, '[]'::jsonb, 'infinity', $3::jsonb FROM documents WHERE id = $1`,
          [`pubmed:${pmid}`, JSON.stringify(entities), JSON.stringify(mesh)],
        );
      }
      const steps: [string, unknown][] = [];
      const hits = await createGraphMatcher(db.pool).match(
        state(diagnosis, edge("UNDERWENT", "p", "rp")),
        {
          limit: 10,
          contentTypes: ["journal_article"],
          trace: (step, data) => steps.push([step, data]),
        },
      );
      // pubmed:4 has prostate cancer as its main topic, though castration-resistant, which
      // contradicts this patient; pubmed:3 has the diagnosis only in the abstract.
      expect(order(hits)).toEqual([
        "pubmed:1",
        "pubmed:0",
        "pubmed:4",
        "pubmed:3",
      ]);
      expect(hits[0].score).toBe(1);
      expect(hits[1].score).toBeLessThan(1);
      // The diagnosis is on every candidate, so it tells nothing apart; the surgery does.
      const pool = steps.find(([step]) => step === "pool")?.[1] as {
        reranked: number;
        idf: Record<string, number>;
      };
      expect(pool.reranked).toBe(4);
      expect(pool.idf[cancer]).toBeLessThan(0.2);
      expect(pool.idf[prostatectomy]).toBeGreaterThan(pool.idf[cancer]);

      // Adding another diagnosis ID and a second channel for the surgery must not
      // count either concept twice. A one-row shortlist retains the best concept score.
      await db.pool.query(
        `UPDATE graph.documents SET entities = entities || $1::jsonb, mesh = mesh || $2::jsonb
         WHERE document_id = 'pubmed:1'`,
        [
          JSON.stringify({ [prostatectomy]: { inTitle: true } }),
          JSON.stringify({ [cancer]: MESH_MAJOR, [crpc]: MESH_MINOR }),
        ],
      );
      const sameQuery = state(diagnosis, edge("UNDERWENT", "p", "rp"));
      const matcher = createGraphMatcher(db.pool);
      const sameHits = await matcher.match(sameQuery, {
        limit: 10,
        contentTypes: ["journal_article"],
      });
      expect(sameHits.map((hit) => hit.score)).toEqual(
        hits.map((hit) => hit.score),
      );
      const first = await matcher.match(sameQuery, {
        limit: 1,
        contentTypes: ["journal_article"],
        tuning: { candidates: 1 },
      });
      expect(order(first)).toEqual(["pubmed:1"]);

      // Patient-5 has a suspected diagnosis at referral, before the later confirmation.
      const graph = JSON.parse(
        readFileSync(
          new URL(
            "../../../../patientdata/Patient-5/graph.json",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      for (const pmid of ["30345884", "32343890", "35923949"]) {
        const paper = paperFromAnnotations(
          JSON.parse(
            readFileSync(
              new URL(`../fixtures/pubtator/${pmid}.json`, import.meta.url),
              "utf8",
            ),
          ),
        );
        await db.pool.query(
          `INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at)
           VALUES ($1, 'pubmed', $2, 'journal_article', 'Title', 'https://example.org', now())`,
          [`pubmed:${pmid}`, pmid],
        );
        await db.pool.query(
          `INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at, mesh)
           SELECT id, changed_at, $2::jsonb, $3::jsonb, 'infinity', '{}'::jsonb FROM documents WHERE id = $1`,
          [
            `pubmed:${pmid}`,
            JSON.stringify(paper.entities),
            JSON.stringify(paper.relations),
          ],
        );
      }
      const matchOn = (as_of: string) =>
        createGraphMatcher(db.pool).match(
          {
            graph: { ...graph, as_of },
            focus: { ...focus, date: as_of },
            context: [],
          },
          { limit: 20 },
        );
      expect(await matchOn("2026-11-05")).toEqual([]);
      expect(order(await matchOn("2026-11-06"))).toContain("pubmed:32343890");
      const known = order(await matchOn("2026-12-08"));
      expect(known).toEqual(
        expect.arrayContaining(["pubmed:32343890", "pubmed:35923949"]),
      );
      expect(known).not.toContain("pubmed:30345884");
    } finally {
      await db.drop();
    }
  },
);

test("a title can supply a missing procedure and a major topic for it counts only once", async () => {
  const q = state(diagnosis, edge("UNDERWENT", "p", "rp"));
  const same = { [cancer]: 1 };
  const hits = await rank(
    [
      { id: "a", evidence: same },
      {
        id: "b",
        title: "Outcomes after radical prostatectomy",
        evidence: same,
      },
      {
        id: "c",
        title: "Outcomes after radical prostatectomy",
        evidence: { ...same, [prostatectomy]: 1 },
      },
    ],
    q,
  );
  expect(order(hits)).toEqual(["b", "c", "a"]);
  expect(hits[0].score).toEqual(hits[1].score);
  expect(hits[1].score).toBeGreaterThan(hits[2].score);
});

test("a treats relation to the acetate ID counts for abiraterone", async () => {
  const q = {
    context: [{ ...focus, type: "diagnosis", label: "Prostate cancer" }],
    focus: { ...focus, type: "systemic_therapy", label: "Abiraterone" },
  };
  const same = { [cancer]: 1, "mesh:C089740": 1 };
  const hits = await rank(
    [
      { id: "a", evidence: same },
      {
        id: "z",
        evidence: same,
        relations: [
          { subject: "mesh:D000069501", predicate: "treats", object: cancer },
        ],
      },
    ],
    q,
  );
  expect(order(hits)).toEqual(["z", "a"]);
  expect(hits[0].score).toBeGreaterThan(hits[1].score);
});
