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
      log(`${count} new or changed document(s) indexed`);
      const counts = await indexFullTexts(db, downloader, (counts) => {
        const done = counts.indexed + counts.skipped + counts.failed;
        if (done % 50 === 0) log(`full texts: ${done} read`);
      });
      log(
        `full texts: ${counts.indexed} indexed, ${counts.skipped} without text, ` +
          `${counts.failed} failed (tried again next run)`,
      );
    },
  };
}
