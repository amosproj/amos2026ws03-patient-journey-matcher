import { readFileSync } from "node:fs";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createGraphIndexer } from "./indexer.ts";

const exportDocument = JSON.parse(
  readFileSync(
    new URL("../fixtures/pubtator/32343890.json", import.meta.url),
    "utf8",
  ),
);
const changed = new Date("2026-11-20T12:00:00Z");
const documents = ["pubmed:32343890", "pubmed:2", "zenodo:32343890"].map(
  (id) => ({
    id,
    source: id.split(":")[0],
    native_id: id.split(":")[1],
    changed_at: changed,
  }),
);

// Schema creation, one batch, its upsert, then no more changed documents.
function batch() {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: documents })
      .mockResolvedValue({ rows: [] }),
  };
}

test("indexes the matching PMID, keeps entity-only papers and never requests another source", async () => {
  const db = batch();
  const request = vi.fn().mockResolvedValue(
    Response.json({
      PubTator3: [
        { ...exportDocument, id: "2", pmid: 2, relations: [] },
        exportDocument,
      ],
    }),
  );
  const log = vi.fn();
  await createGraphIndexer(db, request).index(log);
  expect(request).toHaveBeenCalledTimes(1);
  expect(new URL(request.mock.calls[0][0]).searchParams.get("pmids")).toBe(
    "32343890,2",
  );
  const rows = JSON.parse(db.query.mock.calls[2][1][0]);
  expect(rows[0]).toMatchObject({
    id: documents[0].id,
    changed: changed.toISOString(),
    entities: { "mesh:D011471": { type: "disease", inTitle: true } },
    relations: expect.arrayContaining([
      expect.objectContaining({
        subject: "mesh:C531550",
        predicate: "treats",
        object: "mesh:D011471",
      }),
    ]),
  });
  expect(rows[1]).toMatchObject({
    entities: { "mesh:D011471": { inTitle: true } },
    relations: [],
    retry: false,
  });
  expect(rows[2]).toMatchObject({ entities: {}, relations: [] });
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("2 with entities, 1 with relations"),
  );
});

test("only missing PubMed records are scheduled for retry", async () => {
  const db = batch();
  await createGraphIndexer(db, async () =>
    Response.json({ PubTator3: [] }),
  ).index(() => {});
  const rows = JSON.parse(db.query.mock.calls[2][1][0]);
  expect(rows).toHaveLength(documents.length);
  for (const row of rows)
    expect(row).toMatchObject({ entities: {}, relations: [] });
  expect(rows.map((row: { retry: boolean }) => row.retry)).toEqual([
    true,
    true,
    false,
  ]);
});

test("a bad paper and an unrecognized PMID do not discard the rest of the export", async () => {
  const db = batch();
  const log = vi.fn();
  await createGraphIndexer(db, async () =>
    Response.json({
      PubTator3: [
        { id: "2", passages: [{ annotations: [{ infons: {} }] }] },
        { id: "999", passages: [] },
        null,
        exportDocument,
      ],
    }),
  ).index(log);
  const rows = JSON.parse(db.query.mock.calls[2][1][0]);
  expect(rows[0]).toMatchObject({
    retry: false,
    entities: { "mesh:D011471": { inTitle: true } },
  });
  expect(rows[1]).toMatchObject({ retry: true });
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("Invalid PubTator3 annotations for PMID 2"),
  );
});

test.each([
  () => new Response(null, { status: 503 }),
  () => Response.json({ error: "unexpected export" }),
])(
  "a failed or invalid export leaves the previous index intact and the batch retryable",
  async (response) => {
    const db = batch();
    await expect(
      createGraphIndexer(db, async () => response()).index(() => {}),
    ).rejects.toThrow();
    expect(db.query).toHaveBeenCalledTimes(2);
  },
);

const databaseUrl = testDatabaseUrl();
describe.skipIf(!databaseUrl)("graph annotation retries in PostgreSQL", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string);
    return () => database.drop();
  });

  test("upgrades old rows, keeps good annotations on failure and retries due PMIDs without metadata changes", async () => {
    const db = database.pool;
    await db.query(`
      INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at)
      SELECT 'pubmed:' || n, 'pubmed', n::text, 'journal_article', 'Title', 'https://example.org', now()
      FROM generate_series(1, 4) AS n;
      CREATE SCHEMA graph;
      CREATE TABLE graph.documents (
        document_id text PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
        document_changed_at timestamptz NOT NULL, entities jsonb NOT NULL, relations jsonb NOT NULL
      );
      INSERT INTO graph.documents
      SELECT id, date_trunc('milliseconds', changed_at) - CASE WHEN native_id = '3' THEN interval '1 day' ELSE interval '0' END,
             CASE WHEN native_id = '2' THEN '{}'::jsonb ELSE '{"old": {}}'::jsonb END,
             CASE WHEN native_id = '2' THEN '[]'::jsonb ELSE '["old"]'::jsonb END
      FROM documents WHERE native_id IN ('2', '3', '4');`);
    const annotated = (id: string) => ({ ...exportDocument, id, pmid: id });
    let records = [
      annotated("1"),
      { id: "3", passages: [{}], relations: "invalid" },
    ];
    const request = vi.fn(async (_url: string) =>
      Response.json({ PubTator3: records }),
    );
    const index = () => createGraphIndexer(db, request).index(() => {});
    const pmids = () =>
      request.mock.calls.map(([url]) => new URL(url).searchParams.get("pmids"));
    await index();
    expect(pmids()).toEqual(["1,2,3"]);
    const waiting = await db.query(
      "SELECT document_id, entities, relations FROM graph.documents WHERE isfinite(retry_at) AND retry_at > now() ORDER BY document_id",
    );
    expect(waiting.rows).toEqual([
      { document_id: "pubmed:2", entities: {}, relations: [] },
      { document_id: "pubmed:3", entities: { old: {} }, relations: ["old"] },
    ]);
    await index();
    expect(request).toHaveBeenCalledTimes(1);
    await db.query(
      "UPDATE graph.documents SET retry_at = now() WHERE isfinite(retry_at)",
    );
    records = [annotated("2"), annotated("3")];
    await index();
    expect(pmids()).toEqual(["1,2,3", "2,3"]);
    const repaired = await db.query(
      "SELECT document_id FROM graph.documents WHERE entities ? 'mesh:D011471' AND NOT isfinite(retry_at) ORDER BY document_id",
    );
    expect(repaired.rows.map((row) => row.document_id)).toEqual([
      "pubmed:1",
      "pubmed:2",
      "pubmed:3",
    ]);
    await index();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
