import { createSemanticApproach, parseModel } from "@matcher/ai-summary";
import { type Approach, createFusedMatcher } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import type { Downloader } from "@matcher/download";
import { createGraphApproach } from "@matcher/graph";
import { createKeywordApproach } from "@matcher/keyword";

/** What the approaches need from the process that runs them. */
export interface Dependencies {
  db: Queryable;
  /** One for all approaches, so the request budgets per host hold across them. */
  downloader: Downloader;
}

/**
 * Every matching approach, in the order the indexer job runs them. The MCP server and the
 * indexer job know the approaches only through this list: a new approach (AI summary #9,
 * graph #10) is one more entry here.
 */
export function createApproaches(dependencies: Dependencies): Approach[] {
  const approaches = [
    createKeywordApproach(dependencies),
    createGraphApproach(dependencies),
  ];
  if (process.env.SEMANTIC_MODEL) {
    approaches.push(
      createSemanticApproach({
        db: dependencies.db,
        model: parseModel(process.env.SEMANTIC_MODEL),
        indexModels: (process.env.SEMANTIC_MODELS || process.env.SEMANTIC_MODEL)
          .split(",")
          .map(parseModel),
      }),
    );
  }
  return approaches;
}

/**
 * Matchers that fuse the rankings of approaches, chosen by `algorithm` like an approach; they
 * have no index of their own. `graph_keyword` merges graph and keyword.
 */
export function createFusions(
  approaches: readonly Approach[],
): Pick<Approach, "name" | "matcher">[] {
  const parts = ["graph", "keyword"].flatMap(
    (name) => approaches.find((approach) => approach.name === name) ?? [],
  );
  return parts.length === 2
    ? [{ name: "graph_keyword", matcher: createFusedMatcher(parts) }]
    : [];
}

/** The approaches with these names, in the order of the list; all of them for no names. */
export function selectApproaches(
  approaches: readonly Approach[],
  names: readonly string[],
): Approach[] {
  const unknown = names.filter(
    (name) => !approaches.some((approach) => approach.name === name),
  );
  if (unknown.length > 0) {
    const known = approaches.map((approach) => approach.name).join(", ");
    throw new Error(
      `Unknown approach ${unknown.join(", ")}; choose from ${known}`,
    );
  }
  return names.length === 0
    ? [...approaches]
    : approaches.filter((approach) => names.includes(approach.name));
}
