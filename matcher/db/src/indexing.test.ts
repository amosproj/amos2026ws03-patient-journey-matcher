import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DocumentRow } from "./documents.ts";
import { indexChangedDocuments } from "./indexing.ts";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "./testing.ts";

const databaseUrl = testDatabaseUrl();

describe.skipIf(!databaseUrl)("with PostgreSQL", () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase(databaseUrl as string);
    await database.pool.query(`
      CREATE TABLE test_index (
        document_id text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
        document_changed_at timestamptz NOT NULL
      )`);
    return () => database.drop();
  });

  beforeEach(async () => {
    await database.pool.query("TRUNCATE documents CASCADE");
  });

  async function insert(...ids: string[]) {
    for (const id of ids) {
      await database.pool.query(
        `INSERT INTO documents (id, source, native_id, content_type, title, canonical_url,
                                retrieved_at)
         VALUES ($1, 'pubmed', $2, 'journal_article', 'Title', 'https://example.org', now())`,
        [id, id.split(":")[1]],
      );
    }
  }

  /** An index that stores a row for each document, and remembers the batches. */
  function recording() {
    const batches: string[][] = [];
    async function index(documents: DocumentRow[]) {
      batches.push(documents.map(({ id }) => id));
      await database.pool.query(
        `INSERT INTO test_index (document_id, document_changed_at)
         SELECT * FROM unnest($1::text[], $2::timestamptz[])`,
        [
          documents.map(({ id }) => id),
          documents.map(({ changed_at }) => changed_at),
        ],
      );
    }
    return { batches, index };
  }

  test("passes each new document once, in batches", async () => {
    await insert("pubmed:1", "pubmed:2", "pubmed:3");
    const { batches, index } = recording();

    expect(
      await indexChangedDocuments(database.pool, "test_index", index, 2),
    ).toBe(3);
    expect(
      await indexChangedDocuments(database.pool, "test_index", index, 2),
    ).toBe(0);
    expect(batches.map((batch) => batch.length)).toEqual([2, 1]);
  });

  test("stops with an error when the index stores no row", async () => {
    await insert("pubmed:1");

    await expect(
      indexChangedDocuments(database.pool, "test_index", async () => {}),
    ).rejects.toThrow("test_index has no row for 1 document(s) passed to it");
  });
});
