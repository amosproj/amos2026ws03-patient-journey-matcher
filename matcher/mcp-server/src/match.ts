import { createHash } from "node:crypto";
import type { Approach, Hit } from "@matcher/core";
import type { DocumentRow, DocumentStore } from "@matcher/db";
import type { MatchResult } from "./contract.ts";
import { journeyState } from "./journey.ts";
import { type MatchService, ToolError, withSqlState } from "./server.ts";
import { toSourceDownloads, toSourceReference } from "./sources.ts";

// The same request within five minutes gets the same answer without a search; degraded answers
// are not kept.
const CACHE_MS = 300_000;
const CACHE_SIZE = 200;

/** Why `name` found nothing, for `degraded_reason`; SQLSTATE 57014 is the statement timeout. */
function failure(name: string, error: unknown): string {
  return (error as { code?: unknown } | null | undefined)?.code === "57014"
    ? `The ${name} search took longer than allowed.`
    : `The ${name} index could not be searched.`;
}

/**
 * `match_journey` with the matcher of the approach the request names as `algorithm`, and the
 * metadata and links of its hits; `get_source` with the download links of one stored document.
 * Works for every approach alike.
 */
export function createMatchService(
  approaches: readonly Pick<Approach, "name" | "matcher">[],
  store: DocumentStore,
): MatchService {
  const byAlgorithm = new Map(
    approaches.map(({ name, matcher }) => [name, matcher]),
  );
  const cache = new Map<string, { expires: number; answer: MatchResult }>();
  return {
    async matchJourney(request, debug = {}) {
      const { journey, graph, algorithm, limit, content_types } = request;
      const matcher = byAlgorithm.get(algorithm);
      if (matcher === undefined) {
        throw new ToolError(
          "NOT_AVAILABLE",
          `The ${algorithm} matcher is not available yet.`,
        );
      }
      const state = journeyState(journey);
      if (graph) state.graph = graph;
      debug.trace?.("journey", {
        focus: state.focus.id,
        context: state.context.map((event) => event.id),
      });
      // Traced or tuned requests come from the debug UI, which wants a fresh search.
      const key =
        debug.trace || debug.tuning
          ? undefined
          : createHash("sha256").update(JSON.stringify(request)).digest("hex");
      const cached = key === undefined ? undefined : cache.get(key);
      if (cached && cached.expires > Date.now()) return cached.answer;
      const answer = { algorithm, focus_event_id: state.focus.id };
      const report = (part: string, error: unknown) => {
        console.error(withSqlState(`${part} search failed`, error));
        // The trace goes back to the developer who sent the journey, so it gets the message.
        const details =
          typeof error === "object" && error !== null ? error : {};
        const { name, code, message } = details as {
          name?: unknown;
          code?: unknown;
          message?: unknown;
        };
        debug.trace?.("error", {
          ...(part !== algorithm && { part }),
          name,
          code,
          message,
        });
      };
      const missing: string[] = [];
      try {
        const hits = await matcher.match(state, {
          limit,
          contentTypes: content_types,
          ...debug,
          partFailed: (part, error) => {
            report(part, error);
            missing.push(
              `${failure(part, error).slice(0, -1)}; the results are without it.`,
            );
          },
        });
        const documents = await store.getDocuments(
          hits.map((hit) => hit.documentId),
        );
        const result: MatchResult = {
          ...answer,
          results: results(hits, documents),
          degraded: missing.length > 0,
          ...(missing.length > 0 && { degraded_reason: missing.join(" ") }),
        };
        if (key !== undefined && !result.degraded) {
          cache.delete(key);
          cache.set(key, { expires: Date.now() + CACHE_MS, answer: result });
          if (cache.size > CACHE_SIZE)
            cache.delete(cache.keys().next().value as string);
        }
        return result;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "NOT_AVAILABLE"
        ) {
          throw new ToolError("NOT_AVAILABLE", error.message);
        }
        report(algorithm, error);
        return {
          ...answer,
          results: [],
          degraded: true,
          degraded_reason: failure(algorithm, error),
        };
      }
    },
    async getSource(sourceId) {
      const document = await store.getDocument(sourceId);
      if (document === undefined) {
        throw new ToolError("SOURCE_NOT_FOUND", `Unknown source ${sourceId}.`);
      }
      return toSourceDownloads(document);
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
    explanation: byId.get(document.id)?.explanation,
  }));
}
