import type { JourneyEvent, JourneyState } from "@matcher/core";

export interface Journey {
  as_of?: string;
  events: readonly JourneyEvent[];
}

/**
 * The state every matcher gets. The focus is the latest event on or before `as_of`, the last
 * listed one on a tie; the other events up to then are its context. The MCP contract ensures
 * that there is such an event.
 */
export function journeyState({ as_of, events }: Journey): JourneyState {
  const past = events.filter(
    ({ date }) => as_of === undefined || date <= as_of,
  );
  const focus = past.reduce((latest, event) =>
    event.date >= latest.date ? event : latest,
  );
  return { focus, context: past.filter((event) => event !== focus) };
}
