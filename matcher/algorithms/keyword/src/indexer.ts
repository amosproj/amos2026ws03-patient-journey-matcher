import type { Indexer } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { indexMetadata } from "./metadata.ts";

/** Indexes title, abstract and subjects of the documents. */
export function createKeywordIndexer(db: Queryable): Indexer {
  return {
    async index(log) {
      const count = await indexMetadata(db);
      log(`${count} new or changed document(s) indexed`);
    },
  };
}
