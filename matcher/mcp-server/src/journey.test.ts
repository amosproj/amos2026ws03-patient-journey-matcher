import { expect, test } from "vitest";
import { journeyState } from "./journey.ts";

function event(id: string, date: string) {
  return { id, type: "followup", label: `Event ${id}`, date };
}

const events = [
  event("e1", "2026-01-10"),
  event("e2", "2026-03-01"),
  event("e3", "2026-03-01"),
  event("e4", "2026-02-01"),
  event("e5", "2027-01-01"),
];

test("focuses on the latest event up to as_of, the last listed one on a tie", () => {
  const { focus, context } = journeyState({ as_of: "2026-06-30", events });

  expect(focus.id).toBe("e3");
  expect(context.map(({ id }) => id)).toEqual(["e1", "e2", "e4"]);
});

test("focuses on the latest event of the journey without as_of", () => {
  expect(journeyState({ events }).focus.id).toBe("e5");
});
