import { testDatabaseUrl } from "@matcher/db/testing";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  ARTICLE,
  createHarness,
  type Harness,
  zenodoSearch,
} from "./harness.ts";
import type { Reply } from "./providers.ts";

const databaseUrl = testDatabaseUrl();
const file = "/api/records/201/files/article.html/content";

describe.skipIf(!databaseUrl)("failed downloads and crawls", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(databaseUrl as string);
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h.db.pool.query(
      "TRUNCATE documents, crawl_runs RESTART IDENTITY CASCADE",
    );
    h.providers.routes.clear();
    h.providers.requests.length = 0;
    h.sleeps.length = 0;
  });
  async function seed(
    files: Record<string, unknown> = {
      "article.html": { key: "article.html", mimetype: "text/html" },
    },
  ) {
    h.providers.routes.set("/api/records", [
      zenodoSearch([
        { id: "201", title: "Clinical evidence", files },
        { id: "202", title: "Olaparib evidence" },
      ]),
    ]);
    expect((await h.crawl()).failures).toBe(0);
  }
  async function status() {
    return (
      await h.db.pool.query(
        "SELECT status, detail FROM keyword.full_texts WHERE document_id = 'zenodo:201'",
      )
    ).rows[0];
  }
  async function matching() {
    const answer = await h.match();
    expect(answer.degraded).toBe(false);
    const ids = answer.results.map((r) => r.source_id);
    expect(ids).toContain("zenodo:202");
    return ids;
  }

  test.each([503, 429])(
    "HTTP %s retries and recovery index real full text",
    async (code) => {
      await seed();
      h.providers.routes.set(file, [
        { status: code, body: "retry", headers: { "Retry-After": "1" } },
        { status: code, body: "retry" },
        { body: ARTICLE },
      ]);
      await h.index();
      expect((await status()).status).toBe("indexed");
      expect(h.providers.requests.filter((p) => p === file)).toHaveLength(3);
      expect(h.sleeps).toEqual([1000, 4000]);
      expect(await matching()).toContain("zenodo:201");
    },
  );

  test("exhausted download retries on the next index run; good metadata remains searchable", async () => {
    await seed();
    h.providers.routes.set(file, [{ status: 503, body: "unavailable" }]);
    await h.index();
    expect((await status()).status).toBe("failed");
    expect(h.providers.requests.filter((p) => p === file)).toHaveLength(3);
    expect(await matching()).not.toContain("zenodo:201");
    h.providers.routes.set(file, [{ body: ARTICLE }]);
    await h.index();
    expect((await status()).status).toBe("indexed");
    expect(await matching()).toContain("zenodo:201");
    expect(h.providers.requests.filter((p) => p === file)).toHaveLength(4);
  });

  test("404 locator fallback reads the second file", async () => {
    await seed({
      first: { key: "first.html", mimetype: "text/html" },
      second: { key: "article.html", mimetype: "text/html" },
    });
    const first = "/api/records/201/files/first.html/content";
    h.providers.routes.set(first, [{ status: 404, body: "missing" }]);
    h.providers.routes.set(file, [{ body: ARTICLE }]);
    await h.index();
    expect(h.providers.requests.slice(-2)).toEqual([first, file]);
    expect((await status()).status).toBe("indexed");
    expect(await matching()).toContain("zenodo:201");
  });

  test.each([
    {
      name: "unsupported",
      entry: { key: "data.bin", mimetype: "application/octet-stream" },
      reply: { body: "ignored" },
      fetches: 0,
    },
    {
      name: "preflight size",
      entry: { key: "article.html", mimetype: "text/html", size: 200000 },
      reply: { body: ARTICLE },
      fetches: 0,
    },
    {
      name: "response size",
      entry: { key: "article.html", mimetype: "text/html" },
      reply: { body: "x".repeat(100001), chunked: true },
      fetches: 1,
    },
    {
      name: "corrupt PDF",
      entry: { key: "bad.pdf", mimetype: "application/pdf" },
      reply: { body: "this is not a PDF", type: "application/pdf" },
      fetches: 1,
    },
    {
      name: "audio without transcription",
      entry: { key: "audio.mp3", mimetype: "audio/mpeg" },
      reply: { body: "ignored" },
      fetches: 0,
    },
  ])(
    "$name skips without preventing metadata matching",
    async ({ entry, reply, fetches }) => {
      await seed({ file: entry });
      const path = `/api/records/201/files/${entry.key}/content`;
      h.providers.routes.set(path, [reply as Reply]);
      await h.index();
      expect((await status()).status).toBe("skipped");
      expect(h.providers.requests.filter((p) => p === path)).toHaveLength(
        fetches,
      );
      await matching();
    },
  );

  test("stalled response aborts with bounded retries and preserves other matches", async () => {
    await seed();
    h.providers.routes.set(file, [{ body: ARTICLE, delayMs: 5000 }]);
    await h.index();
    expect((await status()).status).toBe("failed");
    expect(h.providers.requests.filter((p) => p === file)).toHaveLength(3);
    await matching();
  });

  test("partial collection persists successful records and unsuccessful crawl reporting", async () => {
    h.providers.routes.set("/api/records", (url) =>
      url.searchParams.get("q")?.includes("broken")
        ? { status: 503, body: "provider unavailable" }
        : zenodoSearch([{ id: "202", title: "Olaparib evidence" }]),
    );
    const summary = await h.crawl("zenodo-partial");
    expect(summary.ids).toEqual(["zenodo:202"]);
    expect(summary.failures).toBe(1);
    expect(
      (
        await h.db.pool.query(
          "SELECT ok, jsonb_array_length(failures) AS count FROM crawl_runs",
        )
      ).rows,
    ).toEqual([{ ok: false, count: 1 }]);
    await h.index();
    await matching();
  });

  test("disconnected file response retries without stopping other documents", async () => {
    await seed();
    h.providers.routes.set(file, [{ body: "", disconnect: true }]);
    await h.index();
    expect((await status()).status).toBe("failed");
    expect(h.providers.requests.filter((p) => p === file)).toHaveLength(3);
    await matching();
  });
});
