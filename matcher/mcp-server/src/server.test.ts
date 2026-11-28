import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, expect, test, vi } from "vitest";
import type {
  MatchJourneyInput,
  MatchResult,
  SourceDownloads,
} from "./contract.ts";
import { buildServer, type MatchService, ToolError } from "./server.ts";

const journey = {
  patient_id: "Patient-5",
  pathway_id: "p05",
  start_date: "2026-10-31",
  events: [
    {
      id: "e01",
      type: "referral",
      label: "Überweisung zur Urologie",
      date: "2026-10-31",
      specialist: "hausarzt",
      parameters: { psa_value: 6.2, psa_trend: "rising" },
      documents: ["ueberweisung"],
      repeat_index: null,
    },
    {
      id: "e02",
      type: "progression",
      label: "PSA-Anstieg",
      date: "2028-03-02",
      specialist: "urologie",
      parameters: { psa_event: "biochemical_recurrence" },
      documents: [],
      repeat_index: 2,
    },
  ],
};

// The smallest patient graph: the patient, a diagnosis and one dated fact between them.
const graph = {
  nodes: [
    { uuid: "patient", name: "Patient-5", labels: ["Entity", "Patient"] },
    {
      uuid: "cancer",
      name: "C61 Prostatakarzinom",
      labels: ["Entity", "Diagnosis"],
    },
  ],
  edges: [
    {
      uuid: "e1",
      name: "HAS_DIAGNOSIS",
      fact: "Patient-5 has a diagnosis of C61 Prostatakarzinom.",
      source_node_uuid: "patient",
      target_node_uuid: "cancer",
      valid_at: "2026-12-08T00:00:00" as string | null,
    },
  ],
};

const matchResult: MatchResult = {
  algorithm: "keyword",
  focus_event_id: "e02",
  results: [
    {
      rank: 1,
      source_id: "pubmed:42745507",
      title: "Salvage radiotherapy after radical prostatectomy",
      source: "pubmed",
      content_type: "journal_article",
      url: "https://pubmed.ncbi.nlm.nih.gov/42745507/",
      summary: "When radiotherapy helps after PSA rises again.",
      image_url: "https://example.org/salvage-radiotherapy.png",
      score: 1,
    },
  ],
  degraded: false,
};

const sourceDownloads: SourceDownloads = {
  source_id: "arxiv:2007.05098",
  title: "Optimal control of therapies on prostate cancer growth",
  source: "arxiv",
  content_type: "preprint",
  url: "https://arxiv.org/abs/2007.05098",
  summary: "A model of how prostate cancer responds to two therapies.",
  licence: "CC-BY-4.0",
  downloads: [
    {
      url: "https://arxiv.org/html/2007.05098v1",
      kind: "html",
      media_type: "text/html",
    },
    {
      url: "https://arxiv.org/pdf/2007.05098v1",
      kind: "pdf",
      media_type: "application/pdf",
      size: 2_400_000,
    },
  ],
};

let received: MatchJourneyInput | undefined;
let client: Client;

const service: MatchService = {
  matchJourney: async (request) => {
    received = request;
    return matchResult;
  },
  getSource: async (sourceId) => {
    if (sourceId === sourceDownloads.source_id) return sourceDownloads;
    if (sourceId === "pubmed:broken")
      throw new Error("Patient-5 lookup failed");
    throw new ToolError("SOURCE_NOT_FOUND", `Unknown source ${sourceId}.`);
  },
};

beforeEach(async () => {
  received = undefined;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.1.0" });
  await buildServer(service).connect(serverSide);
  await client.connect(clientSide);
});

test("offers the documented tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual([
    "match_journey",
    "get_source",
  ]);
  // The listed schema shows `journey` and `graph` as optional, so the description has the rule.
  expect(tools[0]?.description).toContain("Send either `journey` or `graph`");
});

test("accepts a generated journey and applies the defaults", async () => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: { journey },
  });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual(matchResult);
  expect(received?.algorithm).toBe("keyword");
  expect(received?.limit).toBe(10);
  expect(received?.journey.events[1]).not.toHaveProperty("documents");
});

test("rejects a journey without events", async () => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: { journey: { patient_id: "Patient-5", events: [] } },
  });

  expect(result.isError).toBe(true);
  expect(received).toBeUndefined();
});

test("rejects an as_of earlier than every event", async () => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: { journey: { ...journey, as_of: "2026-10-30" } },
  });

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(
    "as_of must not be earlier than the first event.",
  );
  expect(received).toBeUndefined();
});

test("accepts an as_of on the date of the first event", async () => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: { journey: { ...journey, as_of: "2026-10-31" } },
  });

  expect(result.isError).toBeFalsy();
  expect(received?.journey.as_of).toBe("2026-10-31");
});

test("passes the original graph and its daily journey through MCP", async () => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: { graph },
  });

  expect(result.isError).toBeFalsy();
  expect(received?.graph).toEqual(graph);
  expect(received?.journey).toEqual({
    patient_id: "Patient-5",
    events: [
      {
        id: "2026-12-08",
        type: "facts",
        label: "C61 Prostatakarzinom",
        date: "2026-12-08",
      },
    ],
  });
});

test.each([
  ["a journey and a graph", { journey, graph }],
  ["neither a journey nor a graph", {}],
])("rejects a request with %s", async (_, patient) => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: patient,
  });

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(
    "Send either journey or graph, not both and not neither.",
  );
  expect(received).toBeUndefined();
});

test.each([
  [
    "without a dated fact",
    { ...graph, edges: [{ ...graph.edges[0], valid_at: null }] },
    "The journey made from the graph is not valid.",
  ],
  [
    "whose as_of is earlier than its first fact",
    { ...graph, as_of: "2026-12-07" },
    "as_of must not be earlier than the first event.",
  ],
  [
    "with an edge to a node that is not in it",
    { ...graph, nodes: graph.nodes.slice(0, 1) },
    "The edge points to a node that is not in the graph.",
  ],
])("rejects a graph %s", async (_, broken, message) => {
  const result = await client.callTool({
    name: "match_journey",
    arguments: { graph: broken },
  });

  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain(message);
  expect(received).toBeUndefined();
});

test("returns the download links of a source", async () => {
  const result = await client.callTool({
    name: "get_source",
    arguments: { source_id: "arxiv:2007.05098" },
  });

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toEqual(sourceDownloads);
});

test("reports a known failure with a stable error code", async () => {
  const result = await client.callTool({
    name: "get_source",
    arguments: { source_id: "pubmed:1" },
  });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        error_code: "SOURCE_NOT_FOUND",
        message: "Unknown source pubmed:1.",
      }),
    },
  ]);
});

test("keeps the text of an unexpected failure out of the result and the log", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await client.callTool({
    name: "get_source",
    arguments: { source_id: "pubmed:broken" },
  });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        error_code: "INTERNAL_ERROR",
        message: "The request failed unexpectedly.",
      }),
    },
  ]);
  expect(log).toHaveBeenCalledWith("Unexpected failure during a tool call");
  log.mockRestore();
});
