// The indexer job, run after each crawl: brings the indexes of the approaches up to date with
// `documents`. Arguments name the approaches to index, e.g. `keyword`; none means all.
// WHISPER_MODEL, e.g. `small.en`, turns on speech-to-text for audio without a transcript.
import { createApproaches, selectApproaches } from "@matcher/approaches";
import { createPool } from "@matcher/db";
import { createDownloader, createTranscriber } from "@matcher/download";

const model = process.env.WHISPER_MODEL;
const transcribe = model ? createTranscriber(model) : undefined;
// No audio: fails now, not once per episode, if uv is missing or the model name is wrong.
await transcribe?.(new Uint8Array());
const downloader = createDownloader({ transcribe });
const pool = createPool();
try {
  const approaches = selectApproaches(
    createApproaches({ db: pool, downloader }),
    process.argv.slice(2),
  );
  for (const { name, indexer } of approaches) {
    await indexer.index((line) => console.log(`${name}: ${line}`));
  }
} finally {
  await pool.end();
}
