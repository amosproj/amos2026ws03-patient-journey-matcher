// The transcription job: speech-to-text for the audio that has no transcript, for the keyword
// index (Documentation/sources/podcasts.md#indexing). It runs until it is stopped and reads as
// many files at once as the debug UI sets; an argument, e.g. `2`, sets that number first.
// WHISPER_MODEL names the model, e.g. `small.en`.
import { availableParallelism, constants, setPriority } from "node:os";
import { createPool } from "@matcher/db";
import {
  createDownloader,
  createTranscriber,
  silence,
} from "@matcher/download";
import { setWorkers, transcribeAudio } from "@matcher/keyword/transcription";

/** The advisory lock of the running job; the crawler's store lock has another number. */
const LOCK = 57;
// Downloading a large model on the first run takes a while.
const PREPARE_TIMEOUT_MS = 1_800_000;

const [workers] = process.argv.slice(2);
if (workers !== undefined && !/^\d+$/.test(workers)) {
  console.error(`The number of files to read at once is no number: ${workers}`);
  process.exit(1);
}
// Whisper's own choice. More files at once gain more than more threads for one file.
const threads = Math.min(4, availableParallelism());
const maxWorkers = Math.max(1, Math.floor(availableParallelism() / threads));
// The lowest priority, for Whisper too: also where no systemd unit limits the job
// (deploy/vm-setup.sh), it leaves the processor to everything else.
setPriority(constants.priority.PRIORITY_LOW);

const pool = createPool();
// A restart of the database breaks idle connections; the pool opens new ones.
pool.on("error", (error) => console.error(`database: ${error.message}`));
if (workers !== undefined) {
  await setWorkers(pool, Number(workers));
  console.log(`set to read ${workers} at once`);
}
const lock = await pool.connect();
const { rows } = await lock.query<{ free: boolean }>(
  "SELECT pg_try_advisory_lock($1) AS free",
  [LOCK],
);
if (!rows[0]?.free) {
  lock.release();
  await pool.end();
  console.error(
    "The transcription job is already running and follows the setting.",
  );
  process.exit(workers === undefined ? 1 : 0);
}
const model = process.env.WHISPER_MODEL?.trim();
if (!model) {
  lock.release();
  await pool.end();
  console.error(
    "WHISPER_MODEL is not set: name the Whisper model, e.g. WHISPER_MODEL=tiny-q5_1 make transcribe",
  );
  process.exit(1);
}

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => stop.abort());
}
let broken = false;
lock.on("error", (error) => {
  console.error(
    `The connection that holds the job's lock broke: ${error.message}`,
  );
  broken = true;
  stop.abort();
});
const transcribe = createTranscriber(model, { threads });
try {
  await transcribeAudio(pool, {
    downloader: createDownloader(),
    transcribe,
    signal: stop.signal,
    model,
    threads,
    maxWorkers,
    // Installs the script's packages and downloads the model once, not by every worker at once.
    prepare: async () => {
      await transcribe(silence(), {
        signal: stop.signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
    },
    log: (line) => console.log(line),
  });
} finally {
  lock.release(broken);
  await pool.end();
}
// A download that was given up may still be open.
process.exit(broken ? 1 : 0);
