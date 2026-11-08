import type { Approach, Hit } from "@matcher/core";
import type { DocumentRow, DocumentStore } from "@matcher/db";
import type { MatchResult } from "./contract.ts";
import { journeyState } from "./journey.ts";
import { type MatchService, ToolError } from "./server.ts";
import { toSourceReference } from "./sources.ts";

/**
 * `match_journey` with the matcher of the approach the request names as `algorithm`, and the
 * metadata and links of its hits. Works for every approach alike.
 */
export function createMatchService(
  approaches: readonly Pick<Approach, "name" | "matcher">[],
  store: DocumentStore,
): MatchService {
  const byAlgorithm = new Map(
    approaches.map(({ name, matcher }) => [name, matcher]),
  );
  return {
    async matchJourney({ journey, algorithm, limit, content_types }) {
      const matcher = byAlgorithm.get(algorithm);
      if (matcher === undefined) {
        throw new ToolError(
          "NOT_AVAILABLE",
          `The ${algorithm} matcher is not available yet.`,
        );
      }
      const state = journeyState(journey);
      const answer = { algorithm, focus_event_id: state.focus.id };
      try {
        const hits = await matcher.match(state, {
          limit,
          contentTypes: content_types,
        });
        const documents = await store.getDocuments(
          hits.map((hit) => hit.documentId),
        );
        return {
          ...answer,
          results: results(hits, documents),
          degraded: false,
        };
      } catch (error) {
        // Name and SQLSTATE only: a message can hold terms of the journey.
        const { name, code } = error as { name?: string; code?: string };
        console.error(
          `${algorithm} search failed: ${name} ${code ?? ""}`.trim(),
        );
        return {
          ...answer,
          results: [],
          degraded: true,
          degraded_reason: `The ${algorithm} index could not be searched.`,
        };
      }
    },
    async getSource() {
      throw new ToolError("NOT_AVAILABLE", "No source store is available yet.");
    },
  };
}

/** The hits as tool results, in the order of `documents`: hits whose document is gone drop out. */
function results(
  hits: readonly Hit[],
  documents: readonly DocumentRow[],
): MatchResult["results"] {
  const byId = new Map(hits.map((hit) => [hit.documentId, hit]));
  return documents.map((document, index) => ({
    ...toSourceReference(document),
    rank: index + 1,
    score: byId.get(document.id)?.score,
    matched_terms: byId.get(document.id)?.matchedTerms,
  }));
}
