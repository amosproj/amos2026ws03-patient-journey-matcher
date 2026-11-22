import type { Approach } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { createGraphIndexer } from "./indexer.ts";
import { createGraphMatcher } from "./matcher.ts";

export function createGraphApproach({
  db,
  fetchAnnotations,
}: {
  db: Queryable;
  fetchAnnotations?: (url: string, init?: RequestInit) => Promise<Response>;
}): Approach {
  return {
    name: "graph",
    indexer: createGraphIndexer(db, fetchAnnotations),
    matcher: createGraphMatcher(db),
  };
}
