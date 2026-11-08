import type { Queryable } from "@matcher/db";
import { expect, test, vi } from "vitest";
import { createMatchService, cutJourney } from "./match.ts";

function event(id: string, date: string) {
  return { id, type: "followup", label: `Event ${id}`, date };
}

const journey = {
  patient_id: "Patient-1",
  events: [
    event("e1", "2026-01-10"),
    event("e2", "2026-03-01"),
    event("e3", "2026-03-01"),
    event("e4", "2026-02-01"),
    event("e5", "2027-01-01"),
  ],
};

test("focuses on the latest event up to as_of, the last listed one on a tie", () => {
  const { focus, context } = cutJourney({ ...journey, as_of: "2026-06-30" });

  expect(focus.id).toBe("e3");
  expect(context.map(({ id }) => id)).toEqual(["e1", "e2", "e4"]);
});

test("focuses on the latest event of the journey without as_of", () => {
  expect(cutJourney(journey).focus.id).toBe("e5");
});

test("answers degraded when the keyword index cannot be searched", async () => {
  const failing: Queryable = {
    query: () => Promise.reject(new Error("relation does not exist")),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});

  const result = await createMatchService(failing).matchJourney({
    journey,
    algorithm: "keyword",
    limit: 10,
  });

  expect(result).toEqual({
    algorithm: "keyword",
    focus_event_id: "e5",
    results: [],
    degraded: true,
    degraded_reason: "The keyword index could not be searched.",
  });
});

test("refuses the matchers that do not exist yet", async () => {
  const service = createMatchService({ query: vi.fn() });

  await expect(
    service.matchJourney({ journey, algorithm: "graph", limit: 10 }),
  ).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
});
