// The transcription job: speech-to-text for audio that has no transcript. The indexer leaves
// such a document with the row "audio, and speech-to-text is off"; this job reads the audio of
// those rows, newest first and several at once, and stores the keywords as the indexer would.
// It holds no row lock and no transaction while it reads, so nothing waits for it.
import { setTimeout as wait } from "node:timers/promises";
import type { DocumentRow, Queryable } from "@matcher/db";
import {
  type Downloader,
  NO_SPEECH_TO_TEXT,
  type Transcribe,
} from "@matcher/download";
import {
  type FullTextRow,
  type FullTextStatus,
  fullTextRow,
} from "./full-texts.ts";
import { NON_ENGLISH_METADATA } from "./language.ts";
import { createSchema } from "./schema.ts";

/** What each worker reads, for the report. */
interface Reading {
  id: string;
  title: string;
  venue: string | null;
  duration_seconds: number | null;
  /** When the worker took it. */
  since: string;
  step: "downloading" | "transcribing";
}

/** What the job writes to `keyword.transcription.state` for the debug UI. */
export interface TranscriptionState {
  model: string;
  /** Threads of one transcription. */
  threads: number;
  /** The most audio files this machine reads at once; a higher setting counts as this. */
  max_workers: number;
  started_at: string;
  /** Workers running; above the setting while some end after their audio. */
  workers: number;
  reading: Reading[];
  /** Audio read since the start, by what became of it; `changed`: the indexer wrote the row meanwhile. */
  read: Record<FullTextStatus | "changed", number>;
  /** The audio read last, newest first. */
  recent: {
    id: string;
    title: string;
    status: FullTextStatus | "changed";
    detail: string | null;
    /** Seconds the worker took. */
    seconds: number;
    duration_seconds: number | null;
    at: string;
  }[];
  /** Seconds of audio a worker reads in a second, over the files read last; null before the first. */
  speed: number | null;
  /** Speech-to-text is being set up: the first run downloads the model. */
  preparing: boolean;
  /** Why nothing is read at the moment. */
  error: string | null;
}

export interface TranscriptionOptions {
  downloader: Downloader;
  transcribe: Transcribe;
  /** Ends the job at once: audio in work is given up and stays waiting. */
  signal: AbortSignal;
  /** For the report: the Whisper model, and the threads of one transcription. */
  model: string;
  threads: number;
  /** The most audio files to read at once on this machine; a higher setting counts as this. */
  maxWorkers: number;
  /** Runs before the first audio is read, e.g. to download the model; a failure is tried again. */
  prepare?: () => Promise<void>;
  log?: (line: string) => void;
  /** Milliseconds between two looks at the setting, which are also the reports. */
  pollMs?: number;
  /** Milliseconds without a look for audio when none waits or `prepare` failed. */
  idleMs?: number;
  /** Milliseconds without new audio after speech-to-text failed `FAILURES` times in a row. */
  pauseMs?: number;
}

/** A document whose audio waits, with the version of it that its index row was built from. */
type Waiting = Pick<
  DocumentRow,
  "id" | "title" | "venue" | "duration_seconds" | "full_text"
> & { document_changed_at: Date };

const POLL_MS = 2_000;
const IDLE_MS = 60_000;
/** Speech-to-text that fails this often in a row is taken to be broken, not the files. */
const FAILURES = 5;
const PAUSE_MS = 600_000;
const RECENT = 10;
/** Files the speed is measured over. */
const SPEED_FILES = 30;
// A file takes a fraction of its length, but at the lowest priority a busy machine holds it up:
// twice its length, at least an hour. Two hours stand in for an unknown length.
const MIN_TIMEOUT_MS = 3_600_000;
const UNKNOWN_SECONDS = 7_200;

// The rows the indexer left for this job, of the document version that is stored now: a changed
// document is the indexer's first. `$1` is NO_SPEECH_TO_TEXT.
const WAITING = `f.status = 'skipped' AND f.detail = $1
  AND f.document_changed_at = date_trunc('milliseconds', d.changed_at)
  AND (d.expires_at IS NULL OR d.expires_at > now())
  AND (${NON_ENGLISH_METADATA}) IS NOT TRUE`;

/**
 * Sets how many audio files the job reads at once; 0 stops it after the audio in work. The
 * running job follows within seconds.
 */
export async function setWorkers(
  db: Queryable,
  workers: number,
): Promise<void> {
  if (!Number.isInteger(workers) || workers < 0) {
    throw new RangeError(
      `workers must be a whole number from 0, not ${workers}`,
    );
  }
  await createSchema(db);
  await db.query(
    `INSERT INTO keyword.transcription (workers) VALUES ($1)
     ON CONFLICT (only_row) DO UPDATE SET workers = EXCLUDED.workers`,
    [workers],
  );
}

/**
 * Reads waiting audio with as many workers as `keyword.transcription.workers` says, and follows
 * that setting while it runs: a worker more starts within `pollMs`, a worker too many ends
 * after its audio. Runs until `signal` aborts; reports what it does to the same row.
 */
export async function transcribeAudio(
  db: Queryable,
  {
    downloader,
    transcribe,
    signal,
    model,
    threads,
    maxWorkers,
    prepare,
    log = () => {},
    pollMs = POLL_MS,
    idleMs = IDLE_MS,
    pauseMs = PAUSE_MS,
  }: TranscriptionOptions,
): Promise<void> {
  await createSchema(db);
  const state: TranscriptionState = {
    model,
    threads,
    max_workers: maxWorkers,
    started_at: new Date().toISOString(),
    workers: 0,
    reading: [],
    read: { indexed: 0, skipped: 0, failed: 0, changed: 0 },
    recent: [],
    speed: null,
    preparing: false,
    error: null,
  };
  const reading = new Set<Reading>();
  // Given to a worker in this run and not written since: not given out again, so that a row
  // that cannot be written is not read over and over.
  const unwritten = new Map<string, Date>();
  const speeds: { audio: number; took: number }[] = [];
  let wanted = 0;
  let workers = 0;
  let failures = 0;
  // No new audio before this time: none waits, or too much failed.
  let restUntil = 0;
  let ready = prepare === undefined;
  let turn: Promise<unknown> = Promise.resolve();
  /** The state as the row holds it. */
  let reported = "";
  /** Whether the database answered the last report. */
  let answered = true;

  /** Sleeps, at most until the job ends. */
  const sleep = (ms: number) => wait(ms, undefined, { signal }).catch(() => {});

  /** Writes what the job does and returns the setting: how many files to read at once. */
  async function report(running: boolean): Promise<number> {
    // The last report of a job that ends: what was in work is given up.
    state.workers = running ? workers : 0;
    state.reading = running ? [...reading] : [];
    const json = JSON.stringify(state);
    // Most reports only say that the job still runs, and leave the state as it is. Without a
    // row, as after the table was emptied, the state is written again.
    if (running && json === reported) {
      const { rows } = await db.query<{ workers: number }>(
        "UPDATE keyword.transcription SET reported_at = now() RETURNING workers",
      );
      if (rows[0]) return Math.min(rows[0].workers, maxWorkers);
    }
    const { rows } = await db.query<{ workers: number }>(
      `INSERT INTO keyword.transcription (state, reported_at)
       VALUES ($1, CASE WHEN $2 THEN now() END)
       ON CONFLICT (only_row) DO UPDATE
       SET state = EXCLUDED.state, reported_at = EXCLUDED.reported_at
       RETURNING workers`,
      [json, running],
    );
    reported = json;
    return Math.min(rows[0]?.workers ?? 0, maxWorkers);
  }

  /** The newest waiting document; one query at a time, so that no two workers take the same. */
  function take(): Promise<Waiting | undefined> {
    const taken = turn.then(async () => {
      if (signal.aborted || Date.now() < restUntil) return undefined;
      const { rows } = await db.query<Waiting>(
        `SELECT d.id, d.title, d.venue, d.duration_seconds, d.full_text, f.document_changed_at
         FROM keyword.full_texts AS f JOIN documents AS d ON d.id = f.document_id
         WHERE ${WAITING}
           AND NOT EXISTS (
             SELECT FROM unnest($2::text[], $3::timestamptz[]) AS given (id, changed_at)
             WHERE given.id = f.document_id AND given.changed_at = f.document_changed_at)
         ORDER BY d.published_at DESC NULLS LAST, d.id
         LIMIT 1`,
        [NO_SPEECH_TO_TEXT, [...unwritten.keys()], [...unwritten.values()]],
      );
      const [document] = rows;
      if (document === undefined) restUntil = Date.now() + idleMs;
      else unwritten.set(document.id, document.document_changed_at);
      return document;
    });
    turn = taken.catch(() => {});
    return taken;
  }

  /**
   * Stores what was read, unless the indexer wrote the row meanwhile: the document changed, or
   * its metadata turned out not to be English.
   */
  async function write(document: Waiting, row: FullTextRow): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE keyword.full_texts
       SET status = $3, detail = $4, url = $5, media_type = $6, words = $7, terms = $8,
           fetched_at = now()
       WHERE document_id = $1 AND document_changed_at = $2
         AND status = 'skipped' AND detail = $9`,
      [
        document.id,
        document.document_changed_at,
        row.status,
        row.detail,
        row.url,
        row.mediaType,
        row.words,
        row.terms,
        NO_SPEECH_TO_TEXT,
      ],
    );
    return rowCount === 1;
  }

  /** Reads one document like the indexer would with speech-to-text, and stores the result. */
  async function read(document: Waiting): Promise<void> {
    const started = Date.now();
    const entry: Reading = {
      id: document.id,
      title: document.title,
      venue: document.venue,
      duration_seconds: document.duration_seconds,
      since: new Date(started).toISOString(),
      step: "downloading",
    };
    const seconds = document.duration_seconds ?? UNKNOWN_SECONDS;
    const limits = {
      signal,
      timeoutMs: Math.max(MIN_TIMEOUT_MS, 2_000 * seconds),
    };
    let transcribed = false;
    reading.add(entry);
    const result = await downloader
      .fullText(document.full_text, async (audio) => {
        entry.step = "transcribing";
        const text = await transcribe(audio, limits);
        transcribed = true;
        return text;
      })
      .finally(() => reading.delete(entry));
    // Given up, not failed: the row stays as it is, and the next run reads the audio.
    if (signal.aborted) return;
    const row = fullTextRow(result);
    let status: FullTextStatus | "changed" = row.status;
    let detail = row.detail;
    try {
      if (await write(document, row)) unwritten.delete(document.id);
      else status = "changed";
    } catch (error) {
      if (signal.aborted) return;
      status = "failed";
      detail = `not stored: ${message(error)}`;
    }
    const took = (Date.now() - started) / 1000;
    state.read[status]++;
    state.recent.unshift({
      id: document.id,
      title: document.title,
      status,
      detail,
      seconds: Math.round(took),
      duration_seconds: document.duration_seconds,
      at: new Date().toISOString(),
    });
    state.recent.splice(RECENT);
    if (transcribed && document.duration_seconds) {
      speeds.unshift({ audio: document.duration_seconds, took });
      speeds.splice(SPEED_FILES);
      const sum = (key: "audio" | "took") =>
        speeds.reduce((total, speed) => total + speed[key], 0);
      state.speed = sum("took") > 0 ? sum("audio") / sum("took") : null;
    }
    log(
      `${status}${detail ? ` (${detail})` : ""} after ${Math.round(took)} s: ${document.id}`,
    );
    if (status !== "failed") state.error = null;
    // Broken speech-to-text must not cost the download of every waiting file: after some
    // failures in a row the job rests, then sets it up again. A failed download is cheap and
    // does not count, so that a host that is down does not hold up the files of the others.
    if (transcribed) {
      failures = 0;
    } else if (entry.step === "transcribing" && ++failures >= FAILURES) {
      failures = 0;
      restUntil = Date.now() + pauseMs;
      ready = prepare === undefined;
      state.error = `Speech-to-text failed ${FAILURES} times in a row, the last time with: ${detail}. Trying again at ${new Date(restUntil).toISOString()}`;
      log(state.error);
    }
  }

  /** One worker: reads audio until none waits or the setting asks for fewer workers. */
  async function work(): Promise<void> {
    try {
      // One worker too many ends after its audio, so lowering the setting loses no work.
      while (!signal.aborted && workers <= wanted) {
        const document = await take();
        if (document === undefined || signal.aborted) return;
        await read(document);
      }
    } catch (error) {
      // The database did not answer: the next look at the setting starts a worker again.
      if (state.error !== message(error)) log(`no audio: ${message(error)}`);
      state.error = message(error);
    } finally {
      workers--;
    }
  }

  /** Reports, and takes over the setting; without an answer the job goes on with the last one. */
  async function look(): Promise<void> {
    try {
      const setting = await report(true);
      if (setting !== wanted) log(`reading ${setting} at once, was ${wanted}`);
      wanted = setting;
      answered = true;
    } catch (error) {
      // A report that fails ends no transcription here; the job itself ends when the
      // connection of its lock breaks (transcriber/src/main.ts).
      if (answered) log(`no report, the database said: ${message(error)}`);
      answered = false;
    }
  }

  /** Starts what the setting asks for and nothing keeps from starting; true if something started. */
  function follow(): boolean {
    if (signal.aborted || wanted === 0 || Date.now() < restUntil) return false;
    if (!ready) {
      if (state.preparing) return false;
      state.preparing = true;
      prepare?.()
        .then(
          () => {
            ready = true;
            state.error = null;
          },
          (error) => {
            restUntil = Date.now() + idleMs;
            state.error = message(error);
            log(state.error);
          },
        )
        .finally(() => {
          state.preparing = false;
          follow();
        });
      return true;
    }
    const before = workers;
    while (workers < wanted) {
      workers++;
      void work();
    }
    return workers > before;
  }

  log(
    `transcription with ${model}, ${threads} threads per file, at most ${maxWorkers} files at once`,
  );
  while (!signal.aborted) {
    await look();
    // What just started shows at once, not with the next report.
    if (follow()) await look();
    await sleep(pollMs);
  }
  await report(false).catch(() => {});
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
