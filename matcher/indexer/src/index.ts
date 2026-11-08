// The indexer job, run after each crawl: brings the indexes of the approaches up to date with
// `documents`. Arguments name the approaches to index, e.g. `keyword`; none means all.
import { createApproaches, selectApproaches } from "@matcher/approaches";
import { createPool } from "@matcher/db";

const pool = createPool();
try {
  const approaches = selectApproaches(
    createApproaches({ db: pool }),
    process.argv.slice(2),
  );
  for (const { name, indexer } of approaches) {
    await indexer.index((line) => console.log(`${name}: ${line}`));
  }
} finally {
  await pool.end();
}
