import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createApproaches } from "@matcher/approaches";
import { createDocumentStore } from "@matcher/db";
import { createTestDatabase, testDatabaseUrl } from "@matcher/db/testing";
import { createDownloader } from "@matcher/download";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHttpServer } from "../http.ts";
import { createMatchService } from "../match.ts";
import { createProviders } from "./providers.ts";

export async function createHarness() {
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
    const url = testDatabaseUrl();
    if (!url)
      throw new Error(
        "Integration tests require TEST_DATABASE_URL and make db",
      );
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
