import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, expect, test, vi } from "vitest";
import type { MatchJourneyInput, MatchResult } from "./contract.ts";
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

const matchResult: MatchResult = {
  algorithm: "keyword",
  focus_event_id: "e02",
  results: [
    {
      rank: 1,
      source_id: "pubmed:42745507",
      title: "Salvage radiotherapy after radical prostatectomy",
      source: "pubmed",
      source_type: "paper",
      url: "https://pubmed.ncbi.nlm.nih.gov/42745507/",
      score: 1,
    },
  ],
  degraded: false,
};

let received: MatchJourneyInput | undefined;
let client: Client;

const service: MatchService = {
  matchJourney: async (request) => {
    received = request;
    return matchResult;
  },
  getSource: async (sourceId) => {
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
  expect(log).toHaveBeenCalledWith("Unexpected Error during a tool call");
  log.mockRestore();
});
