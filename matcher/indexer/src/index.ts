// The indexer job, run after each crawl: brings the keyword index up to date with `documents`.
import { createPool } from "@matcher/db";
import { indexDocuments } from "@matcher/keyword";

const pool = createPool();
try {
  const count = await indexDocuments(pool);
  console.log(`keyword index: ${count} new or changed document(s) indexed`);
} finally {
  await pool.end();
}
