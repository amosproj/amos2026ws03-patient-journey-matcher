import type { Indexer } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import type { Downloader } from "@matcher/download";
import { indexFullTexts } from "./full-texts.ts";
import { indexMetadata } from "./metadata.ts";

/** Indexes title, abstract and subjects of the documents, then their full texts. */
export function createKeywordIndexer(
  db: Queryable,
  downloader: Downloader,
): Indexer {
  return {
    async index(log) {
      const count = await indexMetadata(db);
      log(`metadata: ${count} new or changed document(s) indexed`);
      await indexFullTexts(db, downloader, log);
    },
  };
}
