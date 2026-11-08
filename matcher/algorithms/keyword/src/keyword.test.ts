import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createKeywordMatcher } from "./matcher.ts";
import { indexMetadata } from "./metadata.ts";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL must be set on CI");
}

const INIT_DIR = new URL("../../../../db/init/", import.meta.url);
const LONG_AGO = new Date("2000-01-01T00:00:00Z");
const FAR_AHEAD = new Date("2999-01-01T00:00:00Z");

// A database of its own, not a schema per test: the keyword index lives in the fixed schema
// `keyword` and needs the pg_textsearch extension of its database.
describe.skipIf(!databaseUrl)("with PostgreSQL", () => {
  let pool: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl });
    const name = `test_keyword_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString() });
    const files = (await readdir(INIT_DIR)).filter((file) =>
      file.endsWith(".sql"),
    );
    for (const file of files.sort()) {
      await pool.query(await readFile(new URL(file, INIT_DIR), "utf8"));
    }
    return async () => {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    };
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE documents CASCADE");
  });

  /** A journey event with this label. */
  function event(label: string) {
    return { id: label, type: "followup", label, date: "2026-01-01" };
  }

  /** Stores a document as the crawler would, with the columns the index reads. */
  async function insert(
    id: string,
    title: string,
    fields: { content_type?: string; summary?: string; expires_at?: Date } = {},
  ) {
    const [source, nativeId] = id.split(":");
    await pool.query(
      `INSERT INTO documents (id, source, native_id, content_type, title, summary, subjects,
                              canonical_url, retrieved_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
      [
        id,
        source,
        nativeId,
        fields.content_type ?? "journal_article",
        title,
        fields.summary ?? null,
        JSON.stringify([
          { scheme: "mesh", label: "Humans", id: null, major: false },
        ]),
        `https://example.org/${id}`,
        fields.expires_at ?? null,
      ],
    );
  }

  test("indexes new and changed documents once", async () => {
    await insert("pubmed:1", "Olaparib in prostate cancer");
    await insert("pubmed:2", "Heart failure in diabetes");

    expect(await indexMetadata(pool)).toBe(2);
    expect(await indexMetadata(pool)).toBe(0);

    await pool.query(
      "UPDATE documents SET summary = 'New abstract', changed_at = now() WHERE id = 'pubmed:1'",
    );
    expect(await indexMetadata(pool)).toBe(1);
  });

  test("ranks the documents that share the most focus terms first", async () => {
    await insert(
      "pubmed:1",
      "Olaparib in metastatic castration-resistant prostate cancer",
    );
    await insert(
      "pubmed:2",
      "Olaparib maintenance in BRCA-mutated breast cancer",
    );
    await insert("pubmed:3", "Heart failure in type 2 diabetes");
    await insert("pubmed:4", "Active surveillance for prostate cancer");
    await indexMetadata(pool);

    const hits = await createKeywordMatcher(pool).match(
      { focus: event("Olaparib"), context: [event("Prostatakarzinom")] },
      { limit: 10 },
    );

    expect(hits.map((hit) => hit.documentId)).toEqual([
      "pubmed:1",
      "pubmed:2",
      "pubmed:4",
    ]);
    expect(hits[0]).toMatchObject({
      score: 1,
      matchedTerms: ["olaparib", "prostate cancer"],
    });
    expect(hits[2]?.matchedTerms).toEqual(["prostate cancer"]);
  });

  test("filters by content type and leaves out expired and deleted documents", async () => {
    await insert("pubmed:1", "Prostate cancer");
    await insert("pubmed:2", "Prostate cancer screening");
    await insert("youtube:a", "Prostate cancer explained", {
      content_type: "video",
      expires_at: FAR_AHEAD,
    });
    await insert("youtube:b", "Prostate cancer treatment", {
      content_type: "video",
      expires_at: FAR_AHEAD,
    });
    await indexMetadata(pool);
    await pool.query("DELETE FROM documents WHERE id = 'pubmed:2'");
    await pool.query(
      "UPDATE documents SET expires_at = $1 WHERE id = 'youtube:b'",
      [LONG_AGO],
    );
    const matcher = createKeywordMatcher(pool);
    const state = { focus: event("Prostata"), context: [] };

    const all = await matcher.match(state, { limit: 10 });
    const videos = await matcher.match(state, {
      limit: 10,
      contentTypes: ["video"],
    });

    expect(all.map((hit) => hit.documentId).sort()).toEqual([
      "pubmed:1",
      "youtube:a",
    ]);
    expect(videos.map((hit) => hit.documentId)).toEqual(["youtube:a"]);
  });

  test("finds nothing for an event without search terms", async () => {
    await insert("pubmed:1", "Prostate cancer");
    await indexMetadata(pool);

    const hits = await createKeywordMatcher(pool).match(
      { focus: event("nach und zur"), context: [] },
      { limit: 10 },
    );

    expect(hits).toEqual([]);
  });
});
