import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { configuration, indexTable } from "@matcher/ai-summary";
import { createApproaches } from "@matcher/approaches";
import { createDocumentStore } from "@matcher/db";
import { createTestDatabase, testDatabaseUrl } from "@matcher/db/testing";
import { createDownloader } from "@matcher/download";
import { expect, test } from "vitest";
import { matchJourneyInputSchema } from "./contract.ts";
import { createMatchService } from "./match.ts";

test.skipIf(!process.env.SEMANTIC_SMOKE || !testDatabaseUrl())(
  "the managed indexer persists both real encoders and resumes incremental work",
  async () => {
    const database = await createTestDatabase(testDatabaseUrl() as string);
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    async function index() {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "uv",
          ["run", "--locked", "scripts/semantic.py", "--run", "index"],
          {
            cwd: root,
            env: {
              ...process.env,
              DATABASE_URL: database.connectionString,
              SEMANTIC_MODEL: "qwen",
              SEMANTIC_MODELS: "qwen,bge",
            },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 180_000,
          },
        );
        let output = "";
        child.stdout.on("data", (data) => {
          output += data;
        });
        child.stderr.on("data", (data) => {
          output += data;
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(output)),
        );
      });
    }
    try {
      for (const [id, title, summary] of [
        [
          "a",
          "Prostate cancer follow-up",
          "PSA monitoring after prostatectomy.",
        ],
        [
          "b",
          "A long abstract",
          "Methods and limitations of a synthetic study. ".repeat(1500),
        ],
        ["empty", "", null],
        ["title", "Title-only resource", null],
      ]) {
        await database.pool.query(
          "INSERT INTO documents " +
            "(id, source, native_id, content_type, title, summary, canonical_url, retrieved_at) " +
            "VALUES ($1, 'pubmed', $2, 'journal_article', $3, $4, 'https://example.org', now())",
          [`pubmed:${id}`, id, title, summary],
        );
      }
      await index();
      for (const model of ["qwen", "bge"] as const) {
        const rows = await database.pool.query(
          "SELECT document_id, embedding::text FROM " +
            indexTable(model) +
            " ORDER BY document_id",
        );
        expect(rows.rows).toHaveLength(4);
        for (const row of rows.rows) {
          if (row.document_id === "pubmed:empty") {
            expect(row.embedding).toBeNull();
          } else {
            const vector = JSON.parse(row.embedding) as number[];
            expect(vector).toHaveLength(1024);
            expect(Math.hypot(...vector)).toBeCloseTo(1, 3);
          }
        }
      }
      await index();
      const before = await database.pool.query(
        "SELECT embedding::text FROM " +
          indexTable("qwen") +
          " WHERE document_id = 'pubmed:a'",
      );
      await database.pool.query(
        "UPDATE documents SET title = 'Bone health under hormone therapy', changed_at = now() WHERE id = 'pubmed:a'",
      );
      await index();
      const after = await database.pool.query(
        "SELECT embedding::text FROM " +
          indexTable("qwen") +
          " WHERE document_id = 'pubmed:a'",
      );
      expect(after.rows[0].embedding).not.toBe(before.rows[0].embedding);
      for (const model of ["qwen", "bge"] as const) {
        const old = process.env.SEMANTIC_MODEL;
        process.env.SEMANTIC_MODEL = model;
        try {
          const service = createMatchService(
            createApproaches({
              db: database.pool,
              downloader: createDownloader(),
            }),
            createDocumentStore(database.pool),
          );
          const result = await service.matchJourney(
            matchJourneyInputSchema.parse({
              algorithm: "ai_summary",
              journey: {
                patient_id: "synthetic",
                events: [
                  {
                    id: "e1",
                    type: "followup",
                    label: "Nachsorge nach Prostatektomie",
                    date: "2026-01-01",
                  },
                ],
              },
            }),
          );
          expect(result.degraded).toBe(false);
          expect(result.results.length).toBeGreaterThan(0);
          expect(
            result.results.every((r) => r.source_id !== "pubmed:empty"),
          ).toBe(true);
          console.log(
            configuration(model).repository +
              ": persisted vectors, repeat indexing, metadata update and matching passed",
          );
        } finally {
          if (old === undefined) delete process.env.SEMANTIC_MODEL;
          else process.env.SEMANTIC_MODEL = old;
        }
      }
    } finally {
      await database.drop();
    }
  },
  240_000,
);
