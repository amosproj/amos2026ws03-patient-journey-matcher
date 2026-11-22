// The indexer job, run after each crawl: brings the indexes of the approaches up to date with
// `documents`. Arguments name the approaches to index, e.g. `keyword`; none means all.
import { createApproaches, selectApproaches } from "@matcher/approaches";
import {
  createPool,
  dropTranscriptTexts,
  storedTranscripts,
} from "@matcher/db";
import { createDownloader } from "@matcher/download";

const pool = createPool();
try {
  const names = process.argv.slice(2);
  // Every index reads the transcripts stored before this run (Documentation/design/storage.md).
  const { rows } = await pool.query<{ now: Date }>("SELECT now()");
  const downloader = createDownloader({ transcript: storedTranscripts(pool) });
  const approaches = selectApproaches(
    createApproaches({ db: pool, downloader }),
    names,
  );
  for (const { name, indexer } of approaches) {
    await indexer.index((line) => console.log(`${name}: ${line}`));
  }
  if (names.length === 0) {
    const dropped = await dropTranscriptTexts(pool, rows[0].now);
    if (dropped > 0) {
      console.log(`transcripts: dropped ${dropped} that every index has read`);
    }
  }
} finally {
  await pool.end();
}
