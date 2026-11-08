import type { Approach } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { createKeywordApproach } from "@matcher/keyword";

/** What the approaches need from the process that runs them. */
export interface Dependencies {
  db: Queryable;
}

/**
 * Every matching approach, in the order the indexer job runs them. The MCP server and the
 * indexer job know the approaches only through this list: a new approach (AI summary #9,
 * graph #10) is one more entry here.
 */
export function createApproaches(dependencies: Dependencies): Approach[] {
  return [createKeywordApproach(dependencies)];
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
