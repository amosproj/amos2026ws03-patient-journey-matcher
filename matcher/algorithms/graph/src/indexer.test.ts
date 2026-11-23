import { readFileSync } from "node:fs";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createGraphIndexer } from "./indexer.ts";
import { ensureGraphSchema } from "./schema.ts";

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

/** What the downloader gives for an export with this JSON. */
function answer(json: unknown) {
  return { status: 200, body: new TextEncoder().encode(JSON.stringify(json)) };
}

// Schema creation, one batch, its upserts, then no more changed documents.
function batch(rows: unknown[] = documents) {
  return {
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows })
      .mockResolvedValue({ rows: [] }),
  };
}

test("indexes the matching PMID, keeps entity-only papers and never requests another source", async () => {
  const db = batch();
  const get = vi.fn().mockResolvedValue(
    answer({
      PubTator3: [
        { ...exportDocument, id: "2", pmid: 2, relations: [] },
        exportDocument,
      ],
    }),
  );
  const log = vi.fn();
  await createGraphIndexer(db, get).index(log);
  expect(get).toHaveBeenCalledTimes(1);
  expect(new URL(get.mock.calls[0][0]).searchParams.get("pmids")).toBe(
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
  await createGraphIndexer(db, async () => answer({ PubTator3: [] })).index(
    () => {},
  );
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
    answer({
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

// PubTator3 answers 400 when it knows none of the PMIDs of a request.
test.each([400, 404])(
  "schedules a retry when PubTator3 knows none of the papers (HTTP %i)",
  async (status) => {
    const db = batch();
    await createGraphIndexer(db, async () => ({ status })).index(() => {});
    const rows = JSON.parse(db.query.mock.calls[2][1][0]);
    expect(rows.map((row: { retry: boolean }) => row.retry)).toEqual([
      true,
      true,
      false,
    ]);
  },
);

test("asks PubTator3 for at most 50 papers at a time and stores each answer", async () => {
  const papers = Array.from({ length: 120 }, (_, index) => ({
    id: `pubmed:${index + 1}`,
    source: "pubmed",
    native_id: String(index + 1),
    changed_at: changed,
  }));
  const db = batch(papers);
  const get = vi.fn(async (_url: string) => answer({ PubTator3: [] }));
  await createGraphIndexer(db, get).index(() => {});
  expect(
    get.mock.calls.map(
      ([url]) => new URL(url).searchParams.get("pmids")?.split(",").length,
    ),
  ).toEqual([50, 50, 20]);
  // The schema, the changed documents, three upserts, no more changed documents.
  expect(db.query).toHaveBeenCalledTimes(6);
});

test.each([
  async () => ({ status: 403 }),
  async () => answer({ error: "unexpected export" }),
  async () => {
    throw new Error("HTTP 503");
  },
])(
  "a refused, invalid or failed export leaves the previous index intact and the batch retryable",
  async (get) => {
    const db = batch();
    await expect(createGraphIndexer(db, get).index(() => {})).rejects.toThrow();
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

  test("keeps good annotations on failure and retries due PMIDs without metadata changes", async () => {
    const db = database.pool;
    await db.query(`
      INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at)
      SELECT 'pubmed:' || n, 'pubmed', n::text, 'journal_article', 'Title', 'https://example.org', now()
      FROM generate_series(1, 4) AS n`);
    await ensureGraphSchema(db);
    // 2: PubTator3 did not have it and the retry is due. 3: indexed before the document changed.
    await db.query(`
      INSERT INTO graph.documents
      SELECT id, date_trunc('milliseconds', changed_at) - CASE WHEN native_id = '3' THEN interval '1 day' ELSE interval '0' END,
             CASE WHEN native_id = '2' THEN '{}'::jsonb ELSE '{"old": {}}'::jsonb END,
             CASE WHEN native_id = '2' THEN '[]'::jsonb ELSE '["old"]'::jsonb END,
             CASE WHEN native_id = '2' THEN now() ELSE 'infinity'::timestamptz END
      FROM documents WHERE native_id IN ('2', '3', '4')`);
    const annotated = (id: string) => ({ ...exportDocument, id, pmid: id });
    let records = [
      annotated("1"),
      { id: "3", passages: [{}], relations: "invalid" },
    ];
    const get = vi.fn(async (_url: string) => answer({ PubTator3: records }));
    const index = () => createGraphIndexer(db, get).index(() => {});
    const pmids = () =>
      get.mock.calls.map(([url]) => new URL(url).searchParams.get("pmids"));
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
    expect(get).toHaveBeenCalledTimes(1);
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
    expect(get).toHaveBeenCalledTimes(2);

    // Stale-write protection: a document updated during the export is not overwritten by the stale batch.
    let bumped = false;
    const concurrentGet = vi.fn(async (_url: string) => {
      if (!bumped) {
        bumped = true;
        await db.query(
          "UPDATE documents SET changed_at = changed_at + interval '1 minute' WHERE id = 'pubmed:4'",
        );
        return answer({ PubTator3: [] });
      }
      return answer({ PubTator3: [annotated("4")] });
    });
    await db.query(
      "UPDATE documents SET changed_at = changed_at + interval '1 second' WHERE id = 'pubmed:4'",
    );
    await createGraphIndexer(db, concurrentGet).index(() => {});
    expect(concurrentGet).toHaveBeenCalledTimes(2);
    const updated = await db.query(
      "SELECT entities, NOT isfinite(retry_at) AS done FROM graph.documents WHERE document_id = 'pubmed:4'",
    );
    expect(updated.rows[0].done).toBe(true);
    expect(updated.rows[0].entities).toHaveProperty("mesh:D011471");
  });

  // `DELETE FROM transcripts` is the documented way to have the audio read again.
  test("keeps indexing when deleted transcripts move the version of a document back", async () => {
    const db = database.pool;
    await db.query(`
      INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at, changed_at)
      VALUES ('podcast:1', 'podcast', '1', 'podcast_episode', 'Title', 'https://example.org', now(), now() - interval '2 days');
      INSERT INTO transcripts (document_id, url, status, text, model, read_at)
      VALUES ('podcast:1', 'https://example.org/a.mp3', 'ok', 'Text.', 'tiny', now() - interval '1 day')`);
    const index = () =>
      createGraphIndexer(db, async () => answer({ PubTator3: [] })).index(
        () => {},
      );
    await index();
    await db.query("DELETE FROM transcripts");
    await index();
    const { rows } = await db.query(
      `SELECT g.document_changed_at = date_trunc('milliseconds', d.changed_at) AS current
       FROM graph.documents g JOIN documents d ON d.id = g.document_id WHERE d.id = 'podcast:1'`,
    );
    expect(rows).toEqual([{ current: true }]);
  });
});
