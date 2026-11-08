import { createDocumentStore, type Queryable } from "@matcher/db";
import { matchJourney as matchKeywords } from "@matcher/keyword";
import type { MatchJourneyInput, MatchResult } from "./contract.ts";
import { type MatchService, ToolError } from "./server.ts";
import { toSourceReference } from "./sources.ts";

type Journey = MatchJourneyInput["journey"];

/**
 * The focus is the latest event on or before `as_of`, the last listed one on a tie; the other
 * events up to then are its context. The schema ensures there is one.
 */
export function cutJourney({ as_of, events }: Journey) {
  const past = events.filter(
    ({ date }) => as_of === undefined || date <= as_of,
  );
  const focus = past.reduce((latest, event) =>
    event.date >= latest.date ? event : latest,
  );
  return { focus, context: past.filter((event) => event !== focus) };
}

/** `match_journey` with the keyword matcher over the stored documents. */
export function createMatchService(db: Queryable): MatchService {
  const store = createDocumentStore(db);
  return {
    async matchJourney({ journey, algorithm, limit, content_types }) {
      if (algorithm !== "keyword") {
        throw new ToolError(
          "NOT_AVAILABLE",
          `The ${algorithm} matcher is not available yet.`,
        );
      }
      const { focus, context } = cutJourney(journey);
      const answer = { algorithm, focus_event_id: focus.id };
      try {
        const hits = await matchKeywords(db, {
          focus,
          context,
          limit,
          contentTypes: content_types,
        });
        const byId = new Map(hits.map((hit) => [hit.id, hit]));
        const documents = await store.getDocuments(hits.map((hit) => hit.id));
        const results: MatchResult["results"] = documents.map(
          (document, index) => ({
            ...toSourceReference(document),
            rank: index + 1,
            score: byId.get(document.id)?.score,
            matched_terms: byId.get(document.id)?.matchedTerms,
          }),
        );
        return { ...answer, results, degraded: false };
      } catch (error) {
        // Name and SQLSTATE only: a message can hold terms of the journey.
        const { name, code } = error as { name?: string; code?: string };
        console.error(`Keyword search failed: ${name} ${code ?? ""}`.trim());
        return {
          ...answer,
          results: [],
          degraded: true,
          degraded_reason: "The keyword index could not be searched.",
        };
      }
    },
    async getSource() {
      throw new ToolError("NOT_AVAILABLE", "No source store is available yet.");
    },
  };
}
