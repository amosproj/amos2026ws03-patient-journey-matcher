import type { Approach } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { createGraphIndexer, type Get } from "./indexer.ts";
import { createGraphMatcher } from "./matcher.ts";

export function createGraphApproach({
  db,
  downloader,
}: {
  db: Queryable;
  downloader: { get: Get };
}): Approach {
  return {
    name: "graph",
    indexer: createGraphIndexer(db, downloader.get),
    matcher: createGraphMatcher(db),
  };
}
