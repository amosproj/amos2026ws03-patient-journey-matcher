import { expect, test, vi } from "vitest";
import type { MatchResult, SourceDownloads } from "./contract.ts";
import { explain, explainSource } from "./explain.ts";
import { type MatchService, ToolError } from "./server.ts";

const journey = {
  patient_id: "Patient-1",
  events: [{ id: "e1", type: "lab_test", label: "PSA", date: "2026-01-10" }],
};
const answer: MatchResult = {
  algorithm: "keyword",
  focus_event_id: "e1",
  results: [],
  degraded: false,
};

/** A service whose `matchJourney` is this function. */
function service(matchJourney: MatchService["matchJourney"]) {
  return {
    matchJourney: vi.fn(matchJourney),
    getSource: async () => {
      throw new ToolError("NOT_AVAILABLE", "No source store.");
    },
  };
}

test("answers like match_journey and lists the steps of the match", async () => {
  const matching = service(async (_request, debug) => {
    debug?.trace?.("terms", { focus: ["psa"] });
    return answer;
  });

  const explanation = await explain(matching, {
    journey,
    tuning: { focusWeight: 5 },
  });

  expect(matching.matchJourney).toHaveBeenCalledWith(
    { journey, algorithm: "keyword", limit: 10 },
    { tuning: { focusWeight: 5 }, trace: expect.any(Function) },
  );
  expect(explanation).toEqual({
    answer,
    steps: [{ step: "terms", data: { focus: ["psa"] } }],
  });
});

test("names what is wrong with a request the contract refuses", async () => {
  const matching = service(async () => answer);

  const explanation = await explain(matching, {
    journey: { ...journey, events: [] },
  });

  expect(matching.matchJourney).not.toHaveBeenCalled();
  expect(explanation.error?.code).toBe("INVALID_REQUEST");
  expect(explanation.error?.message).toContain("journey.events");
});

test("answers with the tool error of an algorithm without a matcher", async () => {
  const matching = service(async () => {
    throw new ToolError(
      "NOT_AVAILABLE",
      "The graph matcher is not available yet.",
    );
  });

  const explanation = await explain(matching, { journey, algorithm: "graph" });

  expect(explanation).toEqual({
    error: {
      code: "NOT_AVAILABLE",
      message: "The graph matcher is not available yet.",
    },
    steps: [],
  });
});

const source: SourceDownloads = {
  source_id: "pubmed:1",
  title: "Salvage radiotherapy after radical prostatectomy",
  source: "pubmed",
  content_type: "journal_article",
  url: "https://pubmed.ncbi.nlm.nih.gov/1/",
  downloads: [],
};

/** A service whose `getSource` is this function. */
function sources(getSource: MatchService["getSource"]) {
  return { matchJourney: async () => answer, getSource: vi.fn(getSource) };
}

test("answers like get_source", async () => {
  const stored = sources(async () => source);

  const explanation = await explainSource(stored, { source_id: "pubmed:1" });

  expect(stored.getSource).toHaveBeenCalledWith("pubmed:1");
  expect(explanation).toEqual({ answer: source });
});

test("answers with the tool error of a source that is not stored", async () => {
  const stored = sources(async (id) => {
    throw new ToolError("SOURCE_NOT_FOUND", `Unknown source ${id}.`);
  });

  expect(await explainSource(stored, { source_id: "pubmed:0" })).toEqual({
    error: { code: "SOURCE_NOT_FOUND", message: "Unknown source pubmed:0." },
  });
});

test("names what is wrong with a get_source request the contract refuses", async () => {
  const stored = sources(async () => source);

  const explanation = await explainSource(stored, {});

  expect(stored.getSource).not.toHaveBeenCalled();
  expect(explanation.error?.code).toBe("INVALID_REQUEST");
  expect(explanation.error?.message).toContain("source_id");
});
