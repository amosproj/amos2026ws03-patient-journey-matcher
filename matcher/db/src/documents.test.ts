import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { Pool } from "pg";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createDocumentStore,
  type DocumentRow,
  metadataText,
  publishedDate,
  type Queryable,
} from "./documents.ts";
import { testDatabaseUrl } from "./testing.ts";

const databaseUrl = testDatabaseUrl();

const INIT_DIR = new URL("../../../db/init/", import.meta.url);
const RETRIEVED = new Date("2026-11-01T12:00:00Z");
// Expiry is compared with the database clock, so tests use dates far from today.
const LONG_AGO = new Date("2000-01-01T00:00:00Z");
const FAR_AHEAD = new Date("2999-01-01T00:00:00Z");
const JSON_COLUMNS = new Set([
  "authors",
  "subjects",
  "external_ids",
  "full_text",
  "found_by",
  "extra",
]);

const noDatabase: Queryable = {
  query: () => {
    throw new Error("no query expected");
  },
};

test.each([
  ["year", "2026"],
  ["month", "2026-09"],
  ["day", "2026-09-13"],
] as const)("publishedDate shows %s precision as %s", (precision, date) => {
  expect(
    publishedDate({
      published_at: "2026-09-13",
      published_precision: precision,
    }),
  ).toBe(date);
});

test("publishedDate is undefined without a date", () => {
  expect(
    publishedDate({ published_at: null, published_precision: null }),
  ).toBeUndefined();
});

test("joins title, abstract and subject labels as the text of a row", () => {
  expect(
    metadataText({
      title: "Olaparib for mCRPC",
      summary: "Background: BRCA2",
      subjects: [
        {
          scheme: "mesh",
          label: "Prostatic Neoplasms",
          id: "D011471",
          major: true,
        },
      ],
    }),
  ).toBe("Olaparib for mCRPC\nBackground: BRCA2\nProstatic Neoplasms");
});

test("asks the database nothing for no IDs", async () => {
  const documents = createDocumentStore(noDatabase).getDocuments([]);

  await expect(documents).resolves.toEqual([]);
});

test.each([
  "keyword_index; DROP TABLE documents",
  "KeywordIndex",
  "public.keyword.index",
  "",
])("refuses %j as an index table name", async (name) => {
  const documents = createDocumentStore(noDatabase).documentsToIndex(name);

  await expect(documents).rejects.toThrow("Not a plain lower-case table name");
});

test.each([0, -1, 1.5, Number.NaN])("refuses %s as a limit", async (limit) => {
  const store = createDocumentStore(noDatabase);

  await expect(store.documentsToIndex("keyword_index", limit)).rejects.toThrow(
    RangeError,
  );
});

describe.skipIf(!databaseUrl)("with PostgreSQL", () => {
  let admin: Pool;
  let pool: Pool;
  let schema: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    // Once, outside the test schemas: dropping a test schema would drop the extension too.
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector");
    return () => admin.end();
  });

  beforeEach(async () => {
    schema = `test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const files = (await readdir(INIT_DIR)).filter((file) =>
      file.endsWith(".sql"),
    );
    for (const file of files.sort()) {
      await pool.query(await readFile(new URL(file, INIT_DIR), "utf8"));
    }
    return async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    };
  });

  /** Inserts a document as the crawler would; only the required columns have defaults. */
  async function insert(id: string, fields: Record<string, unknown> = {}) {
    const [source, ...nativeId] = id.split(":");
    const row: Record<string, unknown> = {
      id,
      source,
      native_id: nativeId.join(":"),
      content_type: "journal_article",
      title: `Title of ${id}`,
      canonical_url: `https://example.org/${id}`,
      retrieved_at: RETRIEVED,
      ...fields,
    };
    const columns = Object.keys(row);
    await pool.query(
      `INSERT INTO documents (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
      columns.map((column) =>
        JSON_COLUMNS.has(column) ? JSON.stringify(row[column]) : row[column],
      ),
    );
  }

  test("reads every column of a document", async () => {
    const fields = {
      version: "42745507@1",
      publication_types: ["Review"],
      authors: [
        { name: "A. Author", orcid: "0000-0002-1825-0097", affiliation: null },
      ],
      venue: "J Urol",
      summary: "Background: text",
      language: "en",
      subjects: [
        {
          scheme: "mesh",
          label: "Prostatic Neoplasms",
          id: "D011471",
          major: true,
        },
      ],
      published_at: "2026-09-01",
      published_precision: "month",
      source_updated_at: new Date("2026-10-01T00:00:00Z"),
      duration_seconds: 1622,
      doi: "10.1000/x",
      external_ids: { pmcid: "PMC1" },
      licence: "CC-BY",
      full_text: [
        {
          kind: "jats",
          url: "https://example.org/1.xml",
          media_type: "application/xml",
          size: null,
          checksum: "md5:0",
          language: null,
        },
      ],
      found_by: [
        { topic: "prostate_cancer", query: "prostate cancer" },
        { cited_by: "pubmed:2" },
      ],
      expires_at: FAR_AHEAD,
      extra: { status: "MEDLINE", is_retracted: false },
    };
    await insert("pubmed:42745507", fields);

    const document =
      await createDocumentStore(pool).getDocument("pubmed:42745507");

    expect(document).toEqual({
      id: "pubmed:42745507",
      source: "pubmed",
      native_id: "42745507",
      content_type: "journal_article",
      title: "Title of pubmed:42745507",
      canonical_url: "https://example.org/pubmed:42745507",
      retrieved_at: RETRIEVED,
      ...fields,
      created_at: expect.any(Date),
      changed_at: expect.any(Date),
    } satisfies Record<keyof DocumentRow, unknown>);
  });

  test("returns documents in the order asked, without unknown or expired ones", async () => {
    await insert("pubmed:1");
    await insert("pubmed:2");
    await insert("youtube:old", {
      content_type: "video",
      expires_at: LONG_AGO,
    });
    await insert("youtube:new", {
      content_type: "video",
      expires_at: FAR_AHEAD,
    });
    const store = createDocumentStore(pool);

    const documents = await store.getDocuments([
      "youtube:new",
      "pubmed:404",
      "pubmed:2",
      "youtube:old",
      "pubmed:1",
      "pubmed:2",
    ]);

    expect(documents.map((document) => document.id)).toEqual([
      "youtube:new",
      "pubmed:2",
      "pubmed:1",
    ]);
    expect(await store.getDocument("youtube:old")).toBeUndefined();
    expect(await store.getDocument("pubmed:404")).toBeUndefined();
  });

  test("lists what an index has not seen or that changed since, oldest change first", async () => {
    await pool.query(`
      CREATE TABLE keyword_index (
        document_id text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
        version text,
        document_changed_at timestamptz NOT NULL
      )`);
    const indexed = new Date("2026-02-01T00:00:00Z");
    await insert("pubmed:1", { changed_at: indexed });
    await insert("pubmed:2", { changed_at: new Date("2026-04-01T00:00:00Z") });
    await insert("pubmed:3", { changed_at: new Date("2026-03-01T00:00:00Z") });
    await insert("youtube:old", {
      content_type: "video",
      expires_at: LONG_AGO,
    });
    await pool.query(
      `INSERT INTO keyword_index (document_id, document_changed_at)
       VALUES ('pubmed:1', $1), ('pubmed:2', $1)`,
      [indexed],
    );
    const store = createDocumentStore(pool);

    const all = await store.documentsToIndex("keyword_index");
    const first = await store.documentsToIndex(`${schema}.keyword_index`, 1);

    expect(all.map((document) => document.id)).toEqual([
      "pubmed:3",
      "pubmed:2",
    ]);
    expect(first.map((document) => document.id)).toEqual(["pubmed:3"]);
    expect(await store.countToIndex("keyword_index")).toBe(2);
  });

  test("lists a document no more once an index stored the changed_at it read", async () => {
    await pool.query(`
      CREATE TABLE keyword_index (
        document_id text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
        document_changed_at timestamptz NOT NULL
      )`);
    await insert("pubmed:1"); // changed_at = now(), in microseconds
    const store = createDocumentStore(pool);
    const [document] = await store.documentsToIndex("keyword_index");
    await pool.query(
      "INSERT INTO keyword_index (document_id, document_changed_at) VALUES ($1, $2)",
      [document?.id, document?.changed_at],
    );

    await expect(store.documentsToIndex("keyword_index")).resolves.toEqual([]);
  });

  test("reads through a client of the pool, e.g. in a transaction", async () => {
    await insert("pubmed:1");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const document =
        await createDocumentStore(client).getDocument("pubmed:1");
      await client.query("COMMIT");

      expect(document?.id).toBe("pubmed:1");
    } finally {
      client.release();
    }
  });
});
