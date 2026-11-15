import { testDatabaseUrl } from "@matcher/db/testing";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  onTestFinished,
  test,
} from "vitest";
import {
  ARTICLE,
  createHarness,
  type Harness,
  JOURNEY,
  zenodoSearch,
} from "./harness.ts";

const databaseUrl = testDatabaseUrl();
const file = "/api/records/101/files/article.html/content";
const event = JOURNEY.events[0];

describe.skipIf(!databaseUrl)("crawl, index and MCP", () => {
  let h: Harness;
  let crawled: Awaited<ReturnType<Harness["crawl"]>>;
  let degradedBeforeIndexing: boolean;

  beforeAll(async () => {
    h = await createHarness(databaseUrl as string);
    h.providers.routes.set("/api/records", [
      zenodoSearch([
        {
          id: "101",
          title: "Clinical treatment evidence",
          files: {
            "article.html": { key: "article.html", mimetype: "text/html" },
          },
        },
        { id: "102", title: "Olaparib clinical evidence" },
        { id: "103", title: "Weather observations" },
      ]),
    ]);
    h.providers.routes.set(file, [{ body: ARTICLE }]);
    crawled = await h.crawl();
    degradedBeforeIndexing = (await h.match()).degraded;
    await h.index();
  });
  afterAll(async () => {
    await h?.close();
  });

  test("the crawler stores every record in a successful run", async () => {
    expect(crawled.failures).toBe(0);
    expect(crawled.ids.sort()).toEqual([
      "zenodo:101",
      "zenodo:102",
      "zenodo:103",
    ]);
    expect((await h.db.pool.query("SELECT ok FROM crawl_runs")).rows).toEqual([
      { ok: true },
    ]);
  });

  test("search is degraded until the first index run", () => {
    expect(degradedBeforeIndexing).toBe(true);
  });

  test("MCP lists both tools", async () => {
    const { tools } = await h.client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_source",
      "match_journey",
    ]);
  });

  test("a word only in the downloaded full text matches like one in a title", async () => {
    const answer = await h.match();
    expect(answer.degraded).toBe(false);
    expect(answer.focus_event_id).toBe("focus");
    expect(answer.results.map((r) => r.source_id).sort()).toEqual([
      "zenodo:101",
      "zenodo:102",
    ]);
    const indexed = await h.db.pool.query(
      "SELECT status, terms::text FROM keyword.full_texts WHERE document_id = 'zenodo:101'",
    );
    expect(indexed.rows[0].status).toBe("indexed");
    expect(indexed.rows[0].terms).toContain("olaparib");
  });

  test("get_source returns the links the client downloads", async () => {
    const source = await h.source("zenodo:101");
    expect(source.downloads).toHaveLength(1);
    const download = await h.providers.fetchLocal(source.downloads[0].url);
    expect(await download.text()).toContain("Olaparib");
    expect((await h.source("zenodo:102")).downloads).toEqual([]);
  });

  test("as_of, limit and content types shape the answer", async () => {
    const future = {
      id: "future",
      type: "therapy",
      label: "Pembrolizumab",
      date: "2027-01-01",
    };
    const historic = await h.match({
      journey: { ...JOURNEY, as_of: "2026-01-02", events: [event, future] },
    });
    expect(historic.focus_event_id).toBe("focus");
    expect(historic.results.map((r) => r.source_id)).toContain("zenodo:101");
    expect((await h.match({ limit: 1 })).results).toHaveLength(1);
    const podcasts = await h.match({ content_types: ["podcast_episode"] });
    expect(podcasts.results).toEqual([]);
  });

  test("a journey without matches is not degraded", async () => {
    const answer = await h.match({
      journey: { ...JOURNEY, events: [{ ...event, label: "Pembrolizumab" }] },
    });
    expect(answer).toMatchObject({ degraded: false, results: [] });
  });

  test("reindexing unchanged documents downloads nothing", async () => {
    const count = h.providers.requests.length;
    await h.index();
    expect(h.providers.requests).toHaveLength(count);
  });

  test("invalid requests name the bad field, and the server keeps working", async () => {
    const invalid: [Record<string, unknown>, string][] = [
      [{ journey: {} }, "journey.patient_id"],
      [
        { journey: { ...JOURNEY, patient_id: undefined } },
        "journey.patient_id",
      ],
      [{ journey: { ...JOURNEY, as_of: "2020-01-01" } }, "journey.as_of"],
      [
        { journey: { ...JOURNEY, events: [{ ...event, date: "invalid" }] } },
        "journey.events.0.date",
      ],
      [
        { journey: { ...JOURNEY, events: [{ ...event, label: undefined }] } },
        "journey.events.0.label",
      ],
      [
        {
          journey: {
            ...JOURNEY,
            events: Array.from({ length: 501 }, () => event),
          },
        },
        "journey.events",
      ],
      [{ journey: { ...JOURNEY, events: [] } }, "journey.events"],
      [{ limit: 0 }, "limit"],
      [{ limit: 51 }, "limit"],
      [{ content_types: ["invalid"] }, "content_types.0"],
    ];
    for (const [args, field] of invalid) {
      const result = await h.client.callTool({
        name: "match_journey",
        arguments: { journey: JOURNEY, ...args },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = JSON.stringify(result.content);
      expect(text).toContain("Input validation error");
      expect(text).toContain(field);
      expect((await h.match()).degraded).toBe(false);
    }
  });

  test("an unavailable algorithm, an unknown source and a failing database answer with error codes", async () => {
    const graph = await h.client.callTool({
      name: "match_journey",
      arguments: { journey: JOURNEY, algorithm: "graph" },
    });
    expect(graph.isError).toBe(true);
    expect(JSON.stringify(graph.content)).toContain("NOT_AVAILABLE");
    const missing = await h.client.callTool({
      name: "get_source",
      arguments: { source_id: "absent" },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("SOURCE_NOT_FOUND");
    const empty = await h.client.callTool({
      name: "get_source",
      arguments: { source_id: "" },
    });
    expect(empty.isError).toBe(true);
    expect(JSON.stringify(empty.content)).toContain("Input validation error");
    expect(JSON.stringify(empty.content)).toContain("source_id");
    await h.db.pool.query("ALTER TABLE documents RENAME TO hidden_documents");
    try {
      const failed = await h.client.callTool({
        name: "get_source",
        arguments: { source_id: "zenodo:101" },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain("INTERNAL_ERROR");
      expect(JSON.stringify(failed.content)).not.toContain("hidden_documents");
    } finally {
      await h.db.pool.query("ALTER TABLE hidden_documents RENAME TO documents");
    }
    expect((await h.match()).degraded).toBe(false);
  });

  test("get_source still returns a link whose file is gone", async () => {
    h.providers.routes.set(file, [{ status: 404, body: "gone" }]);
    onTestFinished(() => {
      h.providers.routes.set(file, [{ body: ARTICLE }]);
    });
    const source = await h.source("zenodo:101");
    const download = await h.providers.fetchLocal(source.downloads[0].url);
    expect(download.status).toBe(404);
    expect((await h.match()).degraded).toBe(false);
  });

  test("no request reached an unknown fixture route", () => {
    expect(h.providers.unexpected).toEqual([]);
  });
});
