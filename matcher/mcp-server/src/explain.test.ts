import { expect, test, vi } from "vitest";
import type { MatchResult } from "./contract.ts";
import { explain } from "./explain.ts";
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
