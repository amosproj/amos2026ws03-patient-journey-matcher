import { readFile } from "node:fs/promises";
import { testDatabaseUrl } from "@matcher/db/testing";
import { expect, test } from "vitest";
import { createHarness } from "./harness.ts";

const databaseUrl = testDatabaseUrl();

test.skipIf(!databaseUrl)(
  "match_journey ranks the same drug by indication from both patient files",
  async () => {
    const h = await createHarness(databaseUrl as string);
    try {
      await h.index();
      // Equal titles, concepts and publication metadata. Only the object of "treats" differs.
      await h.db.pool.query(`
      WITH inserted AS (
        INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at)
        SELECT 'zenodo:' || id, 'zenodo', id, 'journal_article', 'Olaparib', 'https://example.org/' || id, now()
        FROM unnest(ARRAY['breast', 'lung']) id RETURNING id, native_id, changed_at
      )
      INSERT INTO graph.documents (document_id, document_changed_at, entities, relations, retry_at, mesh)
      SELECT id, changed_at, '{"mesh:C531550":{"type":"chemical","name":"olaparib"}}'::jsonb,
             jsonb_build_array(jsonb_build_object('subject','mesh:C531550','predicate','treats',
               'object',CASE native_id WHEN 'breast' THEN 'mesh:D001943' ELSE 'mesh:D008175' END)),
             'infinity', '{"mesh:D001943":4,"mesh:D008175":4}'::jsonb FROM inserted`);
      for (const [argument, filename] of [
        ["graph", "graph"],
        ["journey", "timeline"],
      ]) {
        const file = new URL(
          `../../../../patientdata/Breast/${filename}.json`,
          import.meta.url,
        );
        const input = JSON.parse(await readFile(file, "utf8"));
        const result = await h.match({ [argument]: input, algorithm: "graph" });
        expect(result.degraded).toBe(false);
        expect(result.results.map((hit) => hit.source_id)).toEqual([
          "zenodo:breast",
          "zenodo:lung",
        ]);
        expect(result.results[0].explanation).toContain(
          "documented treatment indication",
        );
      }
    } finally {
      await h.close();
    }
  },
);
