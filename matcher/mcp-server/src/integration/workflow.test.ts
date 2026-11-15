import { afterAll, beforeAll, expect, test } from "vitest";
import { matchResultSchema, sourceDownloadsSchema } from "../contract.ts";
import { createHarness } from "./harness.ts";

let h: Awaited<ReturnType<typeof createHarness>>;
const journey = {
  patient_id: "synthetic",
  events: [
    { id: "focus", type: "therapy", label: "Olaparib", date: "2026-01-01" },
  ],
};
const article = `<html><body>${"The patients in this study were given a treatment and the results of the study showed that the therapy was effective. ".repeat(30)} Olaparib improves treatment outcomes.</body></html>`;
const file = "/api/records/101/files/article.html/content";
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});
async function match(extra = {}) {
  const result = await h.client.callTool({
    name: "match_journey",
    arguments: { journey, ...extra },
  });
  expect(result.isError).not.toBe(true);
  return matchResultSchema.parse(result.structuredContent);
}

test("real crawler, full-text indexing, MCP discovery, matching, retrieval and reindexing", async () => {
  const records = [
    { id: 101, title: "Clinical treatment evidence", files: true },
    { id: 102, title: "Olaparib clinical evidence", files: false },
    { id: 103, title: "Weather observations", files: false },
  ].map((r) => ({
    id: String(r.id),
    metadata: {
      title: r.title,
      resource_type: { id: "publication-article" },
      publication_date: "2025-01-01",
      languages: [{ id: "eng" }],
    },
    access: { status: "open" },
    files: {
      enabled: true,
      entries: r.files
        ? { "article.html": { key: "article.html", mimetype: "text/html" } }
        : {},
    },
  }));
  h.providers.routes.set("/api/records", [
    {
      body: JSON.stringify({ hits: { hits: records } }),
      type: "application/json",
    },
  ]);
  h.providers.routes.set(file, [{ body: article }]);
  const summary = await h.crawl();
  expect(summary.failures).toBe(0);
  expect(summary.ids.sort()).toEqual([
    "zenodo:101",
    "zenodo:102",
    "zenodo:103",
  ]);
  expect((await h.db.pool.query("SELECT ok FROM crawl_runs")).rows).toEqual([
    { ok: true },
  ]);
  const tools = await h.client.listTools();
  expect(tools.tools.map((t) => t.name).sort()).toEqual([
    "get_source",
    "match_journey",
  ]);
  expect((await match()).degraded).toBe(true);
  await h.index();
  const answer = await match();
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
  const source = sourceDownloadsSchema.parse(
    (
      await h.client.callTool({
        name: "get_source",
        arguments: { source_id: "zenodo:101" },
      })
    ).structuredContent,
  );
  expect(source.downloads).toHaveLength(1);
  expect(
    await (await h.providers.fetchLocal(source.downloads[0].url)).text(),
  ).toContain("Olaparib");
  const noFiles = sourceDownloadsSchema.parse(
    (
      await h.client.callTool({
        name: "get_source",
        arguments: { source_id: "zenodo:102" },
      })
    ).structuredContent,
  );
  expect(noFiles.downloads).toEqual([]);
  const historic = await match({
    journey: {
      ...journey,
      as_of: "2026-01-02",
      events: [
        ...journey.events,
        {
          id: "future",
          label: "Pembrolizumab",
          type: "therapy",
          date: "2027-01-01",
        },
      ],
    },
  });
  expect(historic.focus_event_id).toBe("focus");
  expect(historic.results.map((r) => r.source_id)).toContain("zenodo:101");
  const noMatch = await match({
    journey: {
      ...journey,
      events: [{ ...journey.events[0], label: "Pembrolizumab" }],
    },
  });
  expect(noMatch).toMatchObject({ degraded: false, results: [] });
  const empty = await h.client.callTool({
    name: "get_source",
    arguments: { source_id: "" },
  });
  expect(empty.isError).toBe(true);
  const count = h.providers.requests.length;
  await h.index();
  expect(h.providers.requests).toHaveLength(count);
  expect((await match({ limit: 1 })).results).toHaveLength(1);
  expect((await match({ content_types: ["podcast_episode"] })).results).toEqual(
    [],
  );
  expect(
    (
      await match({
        journey: {
          ...journey,
          events: [{ ...journey.events[0], label: "Pembrolizumab" }],
        },
      })
    ).degraded,
  ).toBe(false);
  expect(h.providers.unexpected).toEqual([]);
});

test("invalid SDK inputs and unavailable tools recover on the same HTTP server", async () => {
  for (const args of [
    { journey: {} },
    { journey: { ...journey, patient_id: undefined } },
    { journey: { ...journey, as_of: "2020-01-01" } },
    {
      journey: {
        ...journey,
        events: [{ ...journey.events[0], date: "invalid" }],
      },
    },
    {
      journey: {
        ...journey,
        events: [{ ...journey.events[0], label: undefined }],
      },
    },
    {
      journey: {
        ...journey,
        events: Array.from({ length: 501 }, () => journey.events[0]),
      },
    },
    { journey: { ...journey, events: [] } },
    { journey, limit: 0 },
    { journey, limit: 51 },
    { journey, content_types: ["invalid"] },
    { journey, algorithm: "graph" },
  ]) {
    const result = await h.client.callTool({
      name: "match_journey",
      arguments: args,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.stringify(result.content).length).toBeGreaterThan(20);
    expect((await match()).degraded).toBe(false);
  }
  const missing = await h.client.callTool({
    name: "get_source",
    arguments: { source_id: "absent" },
  });
  expect(missing.isError).toBe(true);
  expect(JSON.stringify(missing.content)).toContain("SOURCE_NOT_FOUND");
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
  expect((await match()).degraded).toBe(false);
});

test("source links remain available when a client download later fails", async () => {
  h.providers.routes.set(file, [{ status: 404, body: "gone" }]);
  const result = await h.client.callTool({
    name: "get_source",
    arguments: { source_id: "zenodo:101" },
  });
  const source = sourceDownloadsSchema.parse(result.structuredContent);
  expect((await h.providers.fetchLocal(source.downloads[0].url)).status).toBe(
    404,
  );
  expect((await match()).degraded).toBe(false);
});
