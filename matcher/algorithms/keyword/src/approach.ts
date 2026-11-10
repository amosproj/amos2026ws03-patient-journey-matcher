import type { Approach } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import type { Downloader } from "@matcher/download";
import { createKeywordIndexer } from "./indexer.ts";
import { createKeywordMatcher } from "./matcher.ts";

/**
 * The keyword approach (#8): BM25 on the words a document shares with the journey, in its
 * metadata and its full text.
 */
export function createKeywordApproach({
  db,
  downloader,
}: {
  db: Queryable;
  downloader: Downloader;
}): Approach {
  return {
    name: "keyword",
    indexer: createKeywordIndexer(db, downloader),
    matcher: createKeywordMatcher(db),
  };
}
