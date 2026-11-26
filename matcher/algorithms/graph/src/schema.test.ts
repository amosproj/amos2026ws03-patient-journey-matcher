import { createTestDatabase, testDatabaseUrl } from "@matcher/db/testing";
import { expect, test } from "vitest";
import {
  ENTITY,
  ENTITY_TITLE,
  ensureGraphSchema,
  MESH_MAJOR,
} from "./schema.ts";

const databaseUrl = testDatabaseUrl();

test.skipIf(!databaseUrl)(
  "the evidence of a paper follows its row, a new schema version builds it again, a new normalization fetches it again",
  async () => {
    const database = await createTestDatabase(databaseUrl as string);
    const db = database.pool;
    try {
      await ensureGraphSchema(db);
      await db.query(
        `INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at)
         VALUES ('pubmed:1', 'pubmed', '1', 'journal_article', 'Title', 'https://example.org', now())`,
      );
      await db.query(
        `INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at, mesh)
         SELECT id, changed_at, $1, $2, 'infinity', $3 FROM documents`,
        [
          {
            "mesh:D1": { type: "disease", inTitle: true },
            "mesh:C2": { type: "chemical" },
          },
          JSON.stringify([
            { subject: "mesh:C2", predicate: "treats", object: "mesh:D1" },
            { subject: "mesh:C2", predicate: "associate", object: "mesh:D1" },
          ]),
          { "mesh:D1": MESH_MAJOR },
        ],
      );
      const derived = async () => ({
        evidence: (
          await db.query(
            "SELECT concept, flags FROM graph.evidence ORDER BY concept",
          )
        ).rows,
        treats: (await db.query("SELECT subject, object FROM graph.treats"))
          .rows,
      });
      const indexed = async () =>
        (await db.query("SELECT document_id FROM graph.indexed_documents")).rows
          .length;
      const all = {
        evidence: [
          { concept: "mesh:C2", flags: ENTITY },
          { concept: "mesh:D1", flags: ENTITY | ENTITY_TITLE | MESH_MAJOR },
        ],
        treats: [{ subject: "mesh:C2", object: "mesh:D1" }],
      };
      expect(await derived()).toEqual(all);
      await db.query(
        "UPDATE graph.documents SET entities = '{}', relations = '[]'",
      );
      expect(await derived()).toEqual({
        evidence: [{ concept: "mesh:D1", flags: MESH_MAJOR }],
        treats: [],
      });

      // An index of an older version: the next run builds evidence from the stored rows.
      await db.query("ALTER TABLE graph.documents DISABLE TRIGGER derive");
      await db.query(
        "UPDATE graph.documents SET entities = $1, relations = $2",
        [
          {
            "mesh:D1": { type: "disease", inTitle: true },
            "mesh:C2": { type: "chemical" },
          },
          JSON.stringify([
            { subject: "mesh:C2", predicate: "treats", object: "mesh:D1" },
          ]),
        ],
      );
      await db.query("ALTER TABLE graph.documents ENABLE TRIGGER derive");
      await db.query("COMMENT ON SCHEMA graph IS '1'");
      await ensureGraphSchema(db);
      expect(await derived()).toEqual(all);

      // Annotations of an older normalization are fetched again, unless a retry is pending.
      expect(await indexed()).toBe(1);
      await db.query("UPDATE graph.documents SET normalized = 0");
      expect(await indexed()).toBe(0);
      await db.query(
        "UPDATE graph.documents SET retry_at = now() + interval '1 day'",
      );
      expect(await indexed()).toBe(1);

      await db.query("DELETE FROM documents");
      expect(await derived()).toEqual({ evidence: [], treats: [] });
    } finally {
      await database.drop();
    }
  },
);
