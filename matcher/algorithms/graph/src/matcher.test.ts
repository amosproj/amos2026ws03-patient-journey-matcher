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
    const [groups, ids, weights, diagnoses] = values as [
      number[],
      string[],
      number[],
      string[],
    ];
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
        diagnoses: diagnoses.filter(
          (id) => id in (paper.evidence ?? {}) || id in (paper.mesh ?? {}),
        ),
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

test("ruling out the last metastatic site removes the ranking advantage of a metastatic paper", async () => {
  const dx = {
    ...focus,
    date: "2026-01-01",
    type: "diagnosis",
    label: "Confirmed prostate cancer.",
  };
  const scan = {
    ...focus,
    date: "2026-01-02",
    type: "imaging",
    label: "Bone metastases confirmed.",
  };
  const retraction = {
    ...scan,
    date: "2026-01-03",
    label: "Bone metastases ruled out.",
  };
  const papers = [
    { id: "general", title: "Prostate cancer", evidence: { [cancer]: 1 } },
    {
      id: "spread",
      title: "Metastatic prostate cancer",
      evidence: { [cancer]: 1 },
    },
  ];
  expect(order(await rank(papers, { context: [dx], focus: scan }))).toEqual([
    "spread",
    "general",
  ]);
  expect(
    order(await rank(papers, { context: [dx, scan], focus: retraction })),
  ).toEqual(["general", "spread"]);
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

test.skipIf(!databaseUrl)(
  "PostgreSQL ranks a title-only procedure when no candidate annotates it",
  async () => {
    const db = await createTestDatabase(databaseUrl as string);
    try {
      await ensureGraphSchema(db.pool);
      await db.pool.query(`INSERT INTO documents (id,source,native_id,content_type,title,canonical_url,retrieved_at)
      SELECT 'pubmed:' || id,'pubmed',id,'journal_article',title,'https://example.org',now()
      FROM (VALUES ('1','Outcomes of prostate cancer'), ('2','Outcomes after radical prostatectomy')) AS papers(id,title)`);
      await db.pool.query(
        `INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at, mesh)
      SELECT id,changed_at,'{}','[]','infinity',$1::jsonb FROM documents`,
        [JSON.stringify({ [cancer]: MESH_MAJOR })],
      );
      const hits = await createGraphMatcher(db.pool).match(
        state(diagnosis, edge("UNDERWENT", "p", "rp")),
        { limit: 2 },
      );
      expect(order(hits)).toEqual(["pubmed:2", "pubmed:1"]);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
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

test.skipIf(!databaseUrl)(
  "PostgreSQL: a breast cancer journey ranks workup, planned and active treatment at their cutoffs",
  async () => {
    const breast = "mesh:D001943";
    const db = await createTestDatabase(databaseUrl as string);
    try {
      await ensureGraphSchema(db.pool);
      const link = { subject: olaparib, predicate: "treats", object: breast };
      for (const [pmid, title, mesh, relations] of [
        [
          "101",
          "Systemic therapy for breast cancer",
          { [olaparib]: MESH_MAJOR },
          [link],
        ],
        [
          "102",
          "Diagnosis of breast cancer",
          { [`${breast}Q000175`]: MESH_MAJOR },
          [],
        ],
      ] as const) {
        await db.pool.query(
          `WITH doc AS (
             INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at)
             VALUES ('pubmed:' || $1, 'pubmed', $1, 'journal_article', $2, 'https://example.org', now())
             RETURNING id, changed_at
           )
           INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at, mesh)
           SELECT id, changed_at, '{}'::jsonb, $3::jsonb, 'infinity', $4::jsonb FROM doc`,
          [
            pmid,
            title,
            JSON.stringify(relations),
            JSON.stringify({ [breast]: MESH_MAJOR, ...mesh }),
          ],
        );
      }
      const dx = { uuid: "b", labels: ["Diagnosis"], name: "Breast cancer" };
      const patient = [nodes[0], dx, nodes[2]];
      const condition = (fact: string, day: string) =>
        edge("HAS_DIAGNOSIS", "p", "b", fact, day);
      const treatment = (action: string, day: string, invalid_at: string) => ({
        ...edge(
          "TREATED_BY",
          "b",
          "rx",
          `Olaparib ${action} for breast cancer.`,
          day,
        ),
        invalid_at,
      });
      const suspect = condition("Suspected breast cancer.", "2026-01-01");
      const confirm = condition("Confirmed breast cancer.", "2026-01-02");
      const plan = treatment("planned", "2026-01-03", "2026-01-04");
      const start = treatment("given", "2026-01-04", "2026-01-06");
      const exclude = condition("Breast cancer was ruled out.", "2026-01-07");
      const course = [suspect, confirm, plan, start, exclude];
      const matcher = createGraphMatcher(db.pool);
      function at(
        as_of: string,
        edges: Graph["edges"] = course,
        graphNodes = patient,
      ) {
        const focusDate = edges
          .map((item) => item.valid_at ?? "")
          .filter((day) => day <= as_of)
          .sort()
          .at(-1);
        return matcher.match(
          {
            graph: { nodes: graphNodes, edges, as_of },
            focus: { ...focus, date: focusDate ?? as_of },
            context: [],
          },
          { limit: 10 },
        );
      }
      const early = await at("2026-01-01", [suspect]);
      expect(order(early)).toEqual(["pubmed:102", "pubmed:101"]);
      expect(await at("2026-01-01")).toEqual(early);
      const confirmed = await at("2026-01-02");
      expect(confirmed[0]).toMatchObject({
        documentId: "pubmed:101",
        explanation: expect.stringContaining(
          "Studies a treatment for Breast Neoplasms.",
        ),
      });
      const planned = await at("2026-01-03");
      expect(planned[0].explanation).toContain("Studies a planned treatment");
      expect(planned[0].explanation).not.toContain(
        "documented treatment indication",
      );
      const active = await at("2026-01-05");
      expect(active[0]).toMatchObject({
        documentId: "pubmed:101",
        explanation: expect.stringContaining("documented treatment indication"),
      });
      const duplicate = { ...dx, uuid: "alias", name: "Mammakarzinom" };
      expect(
        await at(
          "2026-01-05",
          [
            ...course,
            { ...confirm, uuid: "second-diagnosis", target_node_uuid: "alias" },
            { ...start, uuid: "second-indication", source_node_uuid: "alias" },
          ],
          [...patient, duplicate],
        ),
      ).toEqual(active);
      const ended = await at("2026-01-06");
      expect(ended).toHaveLength(2);
      for (const hit of ended) {
        expect(hit.matchedTerms).not.toContain("olaparib");
        expect(hit.explanation).not.toMatch(
          /planned treatment|documented treatment indication/,
        );
      }
      expect(await at("2026-01-07")).toEqual([]);
    } finally {
      await db.drop();
    }
  },
);

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

test("PSA differential diagnosis rises during investigation of suspected cancer", async () => {
  const psa = edge("HAS_TUMOR_MARKER", "p", "psa");
  const suspected = edge(
    "HAS_DIAGNOSIS",
    "p",
    "dx",
    "Suspected prostate cancer.",
  );
  const papers = [
    { id: "general", evidence: { [cancer]: 1, "ncbigene:354": 1 } },
    {
      id: "workup",
      evidence: { [cancer]: 1, "ncbigene:354": 1 },
      mesh: { "mesh:D003937": MESH_MINOR, "mesh:D017430": MESH_MINOR },
    },
  ];
  const workup = await rank(papers, state(suspected, psa));
  expect(order(workup)).toEqual(["workup", "general"]);
  expect(workup[0].explanation).toContain("diagnostic workup");
  expect(order(await rank(papers, state(diagnosis, psa)))).toEqual([
    "general",
    "workup",
  ]);
});

test("a drug for the current diagnosis beats the same drug for a comorbidity, even when both papers mention both diseases", async () => {
  const breast = "mesh:D001943";
  const lung = "mesh:D008175";
  const diseases = { [breast]: 1, [lung]: 1, [olaparib]: 1 };
  const input: JourneyState = {
    context: [
      { ...focus, type: "diagnosis", label: "Confirmed breast cancer (C50)." },
      { ...focus, type: "diagnosis", label: "Confirmed lung cancer (C34)." },
    ],
    focus: {
      ...focus,
      type: "systemic_therapy",
      label: "Olaparib started",
      parameters: { drug: "Olaparib", indication: "Breast cancer" },
    },
  };
  const papers = [
    {
      id: "a",
      evidence: diseases,
      relations: [
        { subject: olaparib, predicate: "treats" as const, object: lung },
      ],
    },
    { id: "b", evidence: diseases },
    {
      id: "z",
      evidence: diseases,
      relations: [
        { subject: olaparib, predicate: "treats" as const, object: breast },
      ],
    },
  ];
  const hits = await rank(papers, input);
  expect(order(hits)).toEqual(["z", "b", "a"]);
  expect(hits[0].explanation).toContain("documented treatment indication");
  expect(hits[2].matchedTerms).not.toContain("olaparib");

  const nextPlan = {
    context: [...input.context, input.focus],
    focus: {
      ...focus,
      date: "2026-12-09",
      type: "treatment_decision",
      label: "Olaparib planned",
      parameters: { drug: "Olaparib", indication: "Lung cancer" },
    },
  };
  const planned = await rank(papers, nextPlan);
  expect(planned[0].documentId).toBe("z");
  expect(planned.find((hit) => hit.documentId === "a")?.explanation).toContain(
    "planned treatment",
  );
});

test("a paper-only lung subtype is not a documented patient indication", async () => {
  const smallCell = "mesh:D055752";
  const cisplatin = "mesh:D002945";
  const papers: Paper[] = [
    {
      id: "small-cell-study",
      evidence: { [smallCell]: 1, [cisplatin]: 1 },
      relations: [
        { subject: cisplatin, predicate: "treats", object: smallCell },
      ],
    },
  ];
  const diagnosis = {
    ...focus,
    id: "dx",
    type: "diagnosis",
    label: "Confirmed C34.",
  };
  const therapy = {
    ...focus,
    type: "therapy",
    label: "Cisplatin started.",
    parameters: { drug: "Cisplatin", indication: "C34" },
  };
  const subtype = {
    ...diagnosis,
    id: "subtype",
    label: "Confirmed small cell lung carcinoma.",
  };
  const laterPlan = {
    ...therapy,
    id: "plan",
    date: "2026-12-09",
    type: "treatment_decision",
    label: "Cisplatin planned.",
    parameters: { drug: "Cisplatin", indication: "Small cell lung carcinoma" },
  };
  for (const input of [
    { context: [diagnosis], focus: therapy },
    { context: [diagnosis, therapy, subtype], focus: laterPlan },
  ]) {
    const [hit] = await rank(papers, input);
    expect(hit.documentId).toBe("small-cell-study");
    expect(hit.explanation).toContain(
      "documented treatment indication (Cisplatin → Lung Neoplasms)",
    );
    expect(hit.explanation).toContain(
      "The paper studies a narrower diagnosis (Small Cell Lung Carcinoma)",
    );
  }
});

test.each([
  ["nichtkleinzellig", "mesh:D002289", "mesh:D055752"],
  ["kleinzellig", "mesh:D055752", "mesh:D002289"],
])(
  "histology %s in a lung journey demotes the opposing histology",
  async (label, observed, conflicting) => {
    const lung = "mesh:D008175";
    const cisplatin = "mesh:D002945";
    const linked = (
      id: string,
      target: string,
      others: string[] = [],
    ): Paper => ({
      id,
      evidence: {
        [lung]: 1,
        [cisplatin]: 1,
        [target]: 1,
        ...Object.fromEntries(others.map((id) => [id, 1])),
      },
      relations: [{ subject: cisplatin, predicate: "treats", object: target }],
    });
    const papers = [
      linked("a-conflict", conflicting),
      linked("b-confirmed", observed),
      linked("c-broader", lung),
      linked("d-bronchial", "mesh:D001984"),
      linked("e-mixed", observed, [conflicting]),
    ];
    const statement = `Cisplatin started for lung cancer. Histologie: ${label}.`;
    const dx = {
      ...focus,
      id: "dx",
      type: "diagnosis",
      label: "Confirmed C34.",
    };
    const treatment = {
      ...focus,
      type: "therapy",
      label: statement,
      parameters: { drug: "Cisplatin", indication: "C34" },
    };
    const graph: Graph = {
      nodes: [
        nodes[0],
        { uuid: "dx", labels: ["Diagnosis"], name: "C34" },
        { uuid: "rx", labels: ["Medication"], name: "Cisplatin" },
      ],
      edges: [
        edge("HAS_DIAGNOSIS", "p", "dx", dx.label),
        edge("TREATED_BY", "dx", "rx", statement),
      ],
    };
    for (const input of [
      { context: [dx], focus: treatment },
      { context: [], focus, graph },
    ]) {
      const hits = await rank(papers, input);
      expect(hits).toHaveLength(papers.length);
      const last = hits.at(-1);
      expect(last?.documentId).toBe("a-conflict");
      expect(last?.explanation).toContain("different histology");
      expect(last?.matchedTerms).not.toContain("Cisplatin");
      for (const other of hits.slice(0, -1)) {
        expect(other.score).toBeGreaterThan(last?.score ?? 0);
        expect(other.matchedTerms).toContain("Cisplatin");
      }
    }
  },
);

test("a paper's prostate-specific care phase cannot penalize a breast cancer treatment", async () => {
  const evidence = { "mesh:D001943": 1 };
  const hits = await rank(
    [
      { id: "a", evidence, title: "Salvage treatment in breast cancer" },
      { id: "b", evidence, title: "Treatment in breast cancer" },
    ],
    {
      focus: {
        ...focus,
        type: "diagnosis",
        label: "Confirmed breast cancer (C50)",
      },
      context: [],
    },
  );
  expect(hits).toHaveLength(2);
  expect(hits[0].score).toEqual(hits[1].score);
});

test("a cancelled timeline plan gives no drug advantage after cancellation", async () => {
  const diagnosis = {
    ...focus,
    id: "dx",
    date: "2026-01-01",
    type: "diagnosis",
    label: "Confirmed breast cancer.",
  };
  const plan = {
    ...focus,
    id: "plan",
    date: "2026-01-02",
    type: "treatment_decision",
    label: "Olaparib planned.",
    parameters: { drug: "Olaparib", indication: "C50" },
  };
  const cancelled = {
    ...plan,
    id: "stop",
    date: "2026-01-03",
    type: "followup",
    label: "Olaparib cancelled; not started.",
  };
  const disease = { "mesh:D001943": 1 };
  const papers = [
    { id: "a-control", evidence: disease },
    { id: "z-olaparib", evidence: { ...disease, [olaparib]: 1 } },
  ];
  const before = await rank(papers, { focus: diagnosis, context: [] });
  expect(order(before)).toEqual(["a-control", "z-olaparib"]);
  expect(
    order(await rank(papers, { focus: plan, context: [diagnosis] })),
  ).toEqual(["z-olaparib", "a-control"]);
  const after = await rank(papers, {
    focus: cancelled,
    context: [diagnosis, plan],
  });
  expect(order(after)).toEqual(order(before));
  expect(
    after.find((p) => p.documentId === "z-olaparib")?.matchedTerms,
  ).not.toContain("olaparib");
});

test("confirmation alone can retrieve treatments for this disease", async () => {
  const breast = "mesh:D001943";
  const drugFor = (object: string) => [
    { subject: olaparib, predicate: "treats" as const, object },
  ];
  const hits = await rank(
    [
      {
        id: "a",
        evidence: { [breast]: 1 },
        relations: drugFor("mesh:D008175"),
      },
      { id: "z", evidence: { [breast]: 1 }, relations: drugFor(breast) },
    ],
    {
      focus: { ...focus, type: "diagnosis", label: "Confirmed breast cancer" },
      context: [],
    },
  );
  expect(order(hits)).toEqual(["z", "a"]);
  expect(hits[0].explanation).toContain("Studies a treatment");
});
