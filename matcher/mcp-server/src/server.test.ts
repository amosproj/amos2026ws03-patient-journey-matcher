import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, expect, test } from "vitest";
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
