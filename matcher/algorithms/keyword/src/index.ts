import type { Approach } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { createKeywordIndexer } from "./indexer.ts";
import { createKeywordMatcher } from "./matcher.ts";

/** The keyword approach (#8): BM25 on the words a document shares with the journey. */
export function createKeywordApproach({ db }: { db: Queryable }): Approach {
  return {
    name: "keyword",
    indexer: createKeywordIndexer(db),
    matcher: createKeywordMatcher(db),
  };
}
