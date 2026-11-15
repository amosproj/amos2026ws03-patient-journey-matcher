import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createApproaches } from "@matcher/approaches";
import { createDocumentStore } from "@matcher/db";
import { createTestDatabase } from "@matcher/db/testing";
import { createDownloader } from "@matcher/download";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { expect } from "vitest";
import { matchResultSchema, sourceDownloadsSchema } from "../contract.ts";
import { createMcpHttpServer } from "../http.ts";
import { createMatchService } from "../match.ts";
import { createProviders, type Reply } from "./providers.ts";

// Common English words: the indexer keeps only full texts that read as English (full-texts.ts).
export const FILLER =
  "The patients in this study were given a treatment and the results of the study showed that the therapy was effective. ".repeat(
    30,
  );
export const ARTICLE = `<html><body>${FILLER} Olaparib improves treatment outcomes.</body></html>`;
export const JOURNEY = {
  patient_id: "synthetic",
  events: [
    { id: "focus", type: "therapy", label: "Olaparib", date: "2026-01-01" },
  ],
};

/** Zenodo's search answer with these records; `files` are the entries of a record's files. */
export function zenodoSearch(
  records: { id: string; title: string; files?: Record<string, unknown> }[],
): Reply {
  const hits = records.map(({ id, title, files = {} }) => ({
    id,
    metadata: {
      title,
      resource_type: { id: "publication-article" },
      publication_date: "2025-01-01",
      languages: [{ id: "eng" }],
    },
    access: { status: "open" },
    files: { enabled: true, entries: files },
  }));
  return { type: "application/json", body: JSON.stringify({ hits: { hits } }) };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(url: string) {
  const cleanup: (() => Promise<unknown>)[] = [];
  async function close() {
    const failures: unknown[] = [];
    for (const action of cleanup.reverse()) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
    cleanup.length = 0;
    if (failures.length)
      throw new AggregateError(failures, "Integration cleanup failed");
  }
  try {
    const db = await createTestDatabase(url);
    cleanup.push(() => db.drop());
    const providers = await createProviders();
    cleanup.push(() => providers.close());
    const sleeps: number[] = [];
    const downloader = createDownloader({
      fetch: providers.fetchLocal,
      intervalMs: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      timeoutMs: 100,
      maxBytes: 100000,
    });
    const approaches = createApproaches({ db: db.pool, downloader });
    const server = createMcpHttpServer(
      createMatchService(approaches, createDocumentStore(db.pool)),
    );
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing MCP address");
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    cleanup.push(() => transport.close());
    const client = new Client({ name: "integration", version: "1" });
    cleanup.push(() => client.close());
    await client.connect(transport);
    const children = new Set<ChildProcess>();
    cleanup.push(async () => {
      await Promise.all(
        [...children].map(async (child) => {
          const closed = once(child, "close");
          child.kill("SIGTERM");
          const force = setTimeout(() => child.kill("SIGKILL"), 1000);
          try {
            await closed;
          } finally {
            clearTimeout(force);
          }
        }),
      );
    });
    async function crawl(scenario = "zenodo") {
      return new Promise<{ ids: string[]; failures: number }>(
        (resolve, reject) => {
          const child = spawn(
            "uv",
            [
              "run",
              "--locked",
              "--no-sync",
              "python",
              "tests/integration_support/crawl.py",
              scenario,
            ],
            {
              cwd: fileURLToPath(
                new URL("../../../../crawler/", import.meta.url),
              ),
              shell: false,
              env: {
                ...process.env,
                PYTHONPATH: fileURLToPath(
                  new URL("../../../../crawler/src/", import.meta.url),
                ),
                DATABASE_URL: db.connectionString,
                FIXTURE_BASE_URL: providers.baseUrl,
              },
            },
          );
          children.add(child);
          let stdout = "";
          let stderr = "";
          let expired = false;
          const timer = setTimeout(() => {
            expired = true;
            child.kill("SIGTERM");
          }, 25000);
          const force = setTimeout(() => child.kill("SIGKILL"), 28000);
          child.stdout.on("data", (chunk) => {
            stdout = (stdout + chunk).slice(-65536);
          });
          child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-8192);
          });
          child.on("error", reject);
          child.on("close", (code) => {
            children.delete(child);
            clearTimeout(timer);
            clearTimeout(force);
            if (code !== 0 || expired) {
              reject(new Error(`Crawler failed (${code}): ${stderr}`));
              return;
            }
            try {
              const summary = JSON.parse(stdout);
              console.info(
                JSON.stringify({
                  scenario,
                  stage: "stored",
                  ids: summary.ids,
                  failures: summary.failures,
                }),
              );
              resolve(summary);
            } catch {
              reject(new Error(`Invalid crawler summary: ${stdout}`));
            }
          });
        },
      );
    }
    return {
      db,
      providers,
      sleeps,
      client,
      crawl,
      close,
      async index() {
        for (const approach of approaches)
          await approach.indexer.index(() => {});
      },
      /** `match_journey` for `JOURNEY`; `args` adds options or replaces the journey. */
      async match(args = {}) {
        const result = await client.callTool({
          name: "match_journey",
          arguments: { journey: JOURNEY, ...args },
        });
        expect(result.isError).not.toBe(true);
        return matchResultSchema.parse(result.structuredContent);
      },
      async source(sourceId: string) {
        const result = await client.callTool({
          name: "get_source",
          arguments: { source_id: sourceId },
        });
        expect(result.isError).not.toBe(true);
        return sourceDownloadsSchema.parse(result.structuredContent);
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError]);
    }
    throw error;
  }
}
