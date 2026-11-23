import {
  configuration,
  createEncoder,
  createSemanticApproach,
  indexTable,
  type Model,
  queryText,
} from "@matcher/ai-summary";
import { createDocumentStore, type Queryable } from "@matcher/db";
import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { matchJourneyInputSchema, matchResultSchema } from "./contract.ts";
import { createMcpHttpServer } from "./http.ts";
import { createMatchService } from "./match.ts";

const journey = {
  patient_id: "synthetic",
  as_of: "2026-02-01",
  events: [
    {
      id: "e1",
      type: "operation",
      label: "Prostatektomie",
      date: "2026-01-01",
    },
    {
      id: "e2",
      type: "followup",
      label: "Keine Metastasen",
      date: "2026-02-01",
      parameters: { psa: 0.01, bone_mets: false },
    },
    {
      id: "future",
      type: "therapy",
      label: "Future treatment",
      date: "2026-03-01",
    },
  ],
};
const vector = (axis: number) =>
  Array.from({ length: 1024 }, (_, i) => Number(i === axis));

test("keeps negative findings and numeric values in the focus before history", () => {
  const text = queryText({
    focus: journey.events[1],
    context: [journey.events[0]],
  });
  expect(text).toContain("Keine Metastasen");
  expect(text).toContain("bone_mets: false");
  expect(text).toContain("psa: 0.01");
  expect(text.indexOf("Keine Metastasen")).toBeLessThan(
    text.indexOf("Prostatektomie"),
  );
  expect(text).not.toContain("synthetic");
});

test("refuses malformed or unnormalized inference responses", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ vectors: [[NaN]] })),
  );
  try {
    await expect(
      createEncoder().encode("qwen", "query", ["test"]),
    ).rejects.toThrow("Invalid embedding");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ vectors: [Array(1024).fill(0)] })),
    );
    await expect(
      createEncoder().encode("bge", "query", ["test"]),
    ).rejects.toThrow("Invalid embedding");
  } finally {
    vi.unstubAllGlobals();
  }
});

test("sends only the start of a long text, and no half of a character pair", async () => {
  const sent: string[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, request: { body: string }) => {
      const { texts } = JSON.parse(request.body) as { texts: string[] };
      sent.push(texts);
      return Response.json({ vectors: texts.map(() => vector(0)) });
    }),
  );
  try {
    await createEncoder().encode("qwen", "document", [
      "word ".repeat(120_000), // 600,000 characters: the worker refuses over 500,000
      `${"a".repeat(19_999)}\u{1F48A} and more`, // the cut lands inside the emoji
      "short",
    ]);
    expect(sent[0].map((text) => text.length)).toEqual([20_000, 20_000, 5]);
    expect(sent[0].every((text) => text.isWellFormed())).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("one index for every device", () => {
  const table = indexTable("qwen");
  vi.stubEnv("SEMANTIC_DEVICE", "mps");
  try {
    expect(configuration("qwen").device).toBe("mps");
    expect(indexTable("qwen")).toBe(table);
  } finally {
    vi.unstubAllEnvs();
  }
});

describe.skipIf(!testDatabaseUrl())(
  "semantic retrieval with PostgreSQL",
  () => {
    let database: TestDatabase;
    const encode = vi.fn(async (model: Model, mode: string, texts: string[]) =>
      texts.map((text) =>
        vector(
          mode === "query" ||
            (model === "qwen" ? text.includes("Alpha") : text.includes("Beta"))
            ? 0
            : 1,
        ),
      ),
    );
    beforeAll(async () => {
      database = await createTestDatabase(testDatabaseUrl() as string);
      await database.pool.query(`
      INSERT INTO documents (id, source, native_id, content_type, title, summary, canonical_url, retrieved_at)
      VALUES ('pubmed:a', 'pubmed', 'a', 'journal_article', 'Alpha', 'Original abstract.', 'https://example.org/a', now()),
             ('pubmed:b', 'pubmed', 'b', 'journal_article', 'Beta', NULL, 'https://example.org/b', now()),
             ('youtube:v', 'youtube', 'v', 'video', 'Alpha Beta', 'Video description', 'https://example.org/v', now())
    `);
      return () => database.drop();
    });

    test("indexes independently, returns original abstracts, filters before limit, and excludes future events", async () => {
      for (const model of ["qwen", "bge"] as const) {
        const approach = createSemanticApproach({
          db: database.pool,
          model,
          encoder: { encode },
        });
        const service = createMatchService(
          [approach],
          createDocumentStore(database.pool),
        );
        const request = matchJourneyInputSchema.parse({
          journey,
          algorithm: "ai_summary",
          content_types: ["journal_article"],
          limit: 1,
        });
        await expect(service.matchJourney(request)).rejects.toMatchObject({
          code: "NOT_AVAILABLE",
        });
        await approach.indexer.index(() => {});
        encode.mockClear();
        const result = matchResultSchema.parse(
          await service.matchJourney(request),
        );
        expect(result.degraded).toBe(false);
        expect(result.results[0]).toMatchObject({
          source_id: model === "qwen" ? "pubmed:a" : "pubmed:b",
          score: 1,
        });
        expect(result.results[0].summary).toBe(
          model === "qwen" ? "Original abstract." : undefined,
        );
        expect(encode.mock.calls[0][2][0]).not.toContain("Future treatment");
        await approach.indexer.index(() => {});
        expect(encode).toHaveBeenCalledTimes(1);
      }
    });

    test("both configured encoders accept the same request through MCP HTTP", async () => {
      for (const model of ["qwen", "bge"] as const) {
        const approach = createSemanticApproach({
          db: database.pool,
          model,
          encoder: { encode },
        });
        const server = createMcpHttpServer(
          createMatchService([approach], createDocumentStore(database.pool)),
        );
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const address = server.address() as { port: number };
        const client = new Client({ name: "semantic-test", version: "1" });
        try {
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${address.port}/mcp`),
            ),
          );
          const result = await client.callTool({
            name: "match_journey",
            arguments: {
              journey,
              algorithm: "ai_summary",
              content_types: ["journal_article"],
              limit: 1,
            },
          });
          expect(
            matchResultSchema.parse(result.structuredContent).results[0]
              .source_id,
          ).toBe(model === "qwen" ? "pubmed:a" : "pubmed:b");
        } finally {
          await client.close();
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      }
    });

    test("updates changed rows and cascades document deletion", async () => {
      const approach = createSemanticApproach({
        db: database.pool,
        model: "qwen",
        encoder: { encode },
      });
      await database.pool.query(
        "UPDATE documents SET title = 'Beta', changed_at = now() WHERE id = 'pubmed:a'",
      );
      await approach.indexer.index(() => {});
      const rows = await database.pool.query(
        `SELECT embedding::text FROM ${indexTable("qwen")} WHERE document_id = 'pubmed:a'`,
      );
      expect(JSON.parse(rows.rows[0].embedding)[1]).toBe(1);
      await database.pool.query("DELETE FROM documents WHERE id = 'pubmed:a'");
      const remaining = await database.pool.query(
        `SELECT 1 FROM ${indexTable("qwen")} WHERE document_id = 'pubmed:a'`,
      );
      expect(remaining.rows).toEqual([]);
    });

    test("expired documents are excluded even before physical deletion", async () => {
      await database.pool.query(
        "UPDATE documents SET expires_at = now() - interval '1 day' WHERE id = 'youtube:v'",
      );
      const approach = createSemanticApproach({
        db: database.pool,
        model: "qwen",
        encoder: { encode },
      });
      expect(
        await approach.matcher.match(
          { focus: journey.events[1], context: [] },
          { limit: 10 },
        ),
      ).toEqual([]);
    });

    test("a ready index returns a degraded MCP result during inference outage", async () => {
      const approach = createSemanticApproach({
        db: database.pool,
        model: "qwen",
        encoder: {
          encode: async () => {
            throw new Error("private input must not escape");
          },
        },
      });
      const service = createMatchService(
        [approach],
        createDocumentStore(database.pool),
      );
      const result = await service.matchJourney(
        matchJourneyInputSchema.parse({ journey, algorithm: "ai_summary" }),
      );
      expect(result.degraded).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private input");
    });

    test("resumes committed batches after an encoder failure", async () => {
      for (let index = 0; index < 5; index++) {
        await database.pool.query(
          "INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at) VALUES ($1, 'pubmed', $2, 'journal_article', 'Alpha', 'https://example.org', now())",
          [`pubmed:resume${index}`, `resume${index}`],
        );
      }
      await database.pool.query(
        "DELETE FROM ai_summary.ready WHERE index_table = $1",
        [indexTable("qwen")],
      );
      let calls = 0;
      const failing = createSemanticApproach({
        db: database.pool,
        model: "qwen",
        encoder: {
          encode: async (_model, _mode, texts) => {
            calls++;
            if (calls === 2) throw new Error("temporary inference failure");
            return texts.map(() => vector(0));
          },
        },
      });
      await expect(failing.indexer.index(() => {})).rejects.toThrow(
        "temporary inference failure",
      );
      const partial = await database.pool.query(
        `SELECT document_id FROM ${indexTable("qwen")} WHERE document_id LIKE 'pubmed:resume%'`,
      );
      expect(partial.rows).toHaveLength(4);
      await expect(
        failing.matcher.match(
          { focus: journey.events[1], context: [] },
          { limit: 10 },
        ),
      ).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
      encode.mockClear();
      await createSemanticApproach({
        db: database.pool,
        model: "qwen",
        encoder: { encode },
      }).indexer.index(() => {});
      expect(encode).toHaveBeenCalledTimes(1);
      expect(encode.mock.calls[0][2]).toHaveLength(1);
      const complete = await database.pool.query(
        `SELECT document_id FROM ${indexTable("qwen")} WHERE document_id LIKE 'pubmed:resume%'`,
      );
      expect(complete.rows).toHaveLength(5);
    });

    test("asks for the next documents per batch, and the encoder for 4 texts at most", async () => {
      for (let index = 0; index < 9; index++) {
        await database.pool.query(
          "INSERT INTO documents (id, source, native_id, content_type, title, canonical_url, retrieved_at) VALUES ($1, 'pubmed', $2, 'journal_article', 'Alpha', 'https://example.org', now())",
          [`pubmed:batch${index}`, `batch${index}`],
        );
      }
      let lookups = 0;
      const db: Queryable = {
        query(text, values) {
          // The query of `documentsToIndex`, which reads all of `documents`.
          if (text.includes("LEFT JOIN")) lookups++;
          return database.pool.query(text, values);
        },
      };
      const requests: number[] = [];
      await createSemanticApproach({
        db,
        model: "qwen",
        encoder: {
          encode: async (_model, _mode, texts) => {
            requests.push(texts.length);
            return texts.map(() => vector(0));
          },
        },
      }).indexer.index(() => {});
      expect(requests).toEqual([4, 4, 1]);
      expect(lookups).toBe(2); // the 9 documents, then none
      const stored = await database.pool.query(
        `SELECT 1 FROM ${indexTable("qwen")} WHERE document_id LIKE 'pubmed:batch%' AND embedding IS NOT NULL`,
      );
      expect(stored.rows).toHaveLength(9);
    });
  },
);
