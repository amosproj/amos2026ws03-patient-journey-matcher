import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import { createDownloader, NO_SPEECH_TO_TEXT } from "@matcher/download";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import { indexFullTexts } from "./full-texts.ts";
import {
  setWorkers,
  type TranscriptionOptions,
  type TranscriptionState,
  transcribeAudio,
} from "./transcription.ts";

const databaseUrl = testDatabaseUrl();

// own database, not a schema per test: the index lives in the fixed schema `keyword`
describe.skipIf(!databaseUrl)("with PostgreSQL", { timeout: 30_000 }, () => {
  let pool: TestDatabase["pool"];

  beforeAll(async () => {
    const database = await createTestDatabase(databaseUrl as string);
    pool = database.pool;
    return () => database.drop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE documents CASCADE");
    await setWorkers(pool, 0);
    await pool.query(
      "UPDATE keyword.transcription SET state = NULL, reported_at = NULL",
    );
  });

  /** Stores a podcast episode with an MP3 at `https://audio.example/<id>.mp3`. */
  async function episode(
    id: string,
    fields: { published_at?: string; extra?: object; transcript?: string } = {},
  ) {
    const locators = [
      { kind: "audio", media_type: "audio/mpeg", url: audioUrl(id) },
    ];
    if (fields.transcript) {
      locators.unshift({
        kind: "transcript",
        media_type: "text/plain",
        url: fields.transcript,
      });
    }
    await pool.query(
      `INSERT INTO documents (id, source, native_id, content_type, title, canonical_url,
                              retrieved_at, published_at, published_precision,
                              duration_seconds, extra, full_text)
       VALUES ($1, 'podcast', $2, 'podcast_episode', $3, $4, now(), $5, 'day', 600, $6, $7)`,
      [
        `podcast:${id}`,
        id,
        `Episode ${id}`,
        `https://example.org/${id}`,
        fields.published_at ?? "2026-01-01",
        JSON.stringify(fields.extra ?? { metadata_language: "en" }),
        JSON.stringify(locators.map((locator) => ({ ...locator, size: null }))),
      ],
    );
  }

  const audioUrl = (id: string) => `https://audio.example/${id}.mp3`;

  /** A fetch that serves each URL's text as its file; a number is the HTTP status of an error. */
  function serve(files: Record<string, string | number>) {
    return vi.fn(async (url: string) => {
      const file = files[url];
      if (file === undefined) throw new Error(`unexpected request ${url}`);
      return typeof file === "number"
        ? new Response("", { status: file })
        : new Response(file);
    });
  }

  /** The indexer's run: leaves the episodes without a transcript to the job. */
  async function index(fetch: ReturnType<typeof serve>) {
    return indexFullTexts(pool, createDownloader({ fetch, ...instant }));
  }

  const instant = { sleep: async () => {}, intervalMs: () => 0 };

  /** Speech-to-text that hears the file's bytes as its words; it takes a moment, as a speed needs one. */
  const hear = async (audio: Uint8Array) => {
    await new Promise((resolve) => setTimeout(resolve, 3));
    return new TextDecoder().decode(audio);
  };

  /** Starts the job with short waits; it ends with the test. */
  function start(
    fetch: ReturnType<typeof serve>,
    options: Partial<TranscriptionOptions> = {},
  ) {
    const stop = new AbortController();
    const lines: string[] = [];
    const done = transcribeAudio(pool, {
      downloader: createDownloader({ fetch, ...instant }),
      transcribe: hear,
      signal: stop.signal,
      model: "test-model",
      threads: 1,
      maxWorkers: 3,
      log: (line) => lines.push(line),
      pollMs: 5,
      idleMs: 20,
      ...options,
    });
    const end = async () => {
      stop.abort();
      await done;
    };
    onTestFinished(end);
    return { lines, end };
  }

  /** The row of the job: the setting and what the job reported last. */
  async function job() {
    const { rows } = await pool.query<{
      workers: number;
      state: TranscriptionState | null;
      reported_at: Date | null;
    }>("SELECT workers, state, reported_at FROM keyword.transcription");
    return rows[0];
  }

  /** The index rows by document, as `status` or `status: detail`. */
  async function states(): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ id: string; state: string }>(
      `SELECT document_id AS id, concat_ws(': ', status, detail) AS state
       FROM keyword.full_texts`,
    );
    return Object.fromEntries(rows.map(({ id, state }) => [id, state]));
  }

  /** Waits until `check` passes; the job reports every few milliseconds. */
  const until = (check: () => unknown) =>
    vi.waitFor(check, { timeout: 10_000, interval: 10 });
  /** Long enough for the job to look at the setting several times. */
  const polls = () => new Promise((resolve) => setTimeout(resolve, 60));

  /** Speech-to-text that holds each file until it is released, and counts the files in work. */
  function held() {
    const releases = new Map<string, () => void>();
    const heard: string[] = [];
    return {
      heard,
      running: () => releases.size,
      release(text: string) {
        releases.get(text)?.();
      },
      releaseAll() {
        for (const release of releases.values()) release();
      },
      async transcribe(audio: Uint8Array) {
        const text = new TextDecoder().decode(audio);
        heard.push(text);
        await new Promise<void>((resolve) => releases.set(text, resolve));
        releases.delete(text);
        return text;
      },
    };
  }

  const WAITING = `skipped: ${NO_SPEECH_TO_TEXT}`;

  test("reads the waiting audio, newest first, and stores its keywords", async () => {
    await episode("old", { published_at: "2024-05-01" });
    await episode("new", { published_at: "2026-05-01" });
    await episode("unknown", { published_at: "2025-05-01", extra: {} });
    await episode("german", { extra: { metadata_language: "de" } });
    await episode("written", { transcript: "https://example.org/t.txt" });
    const fetch = serve({
      [audioUrl("old")]: "Olaparib and the PSA, the old episode.",
      [audioUrl("new")]: "Olaparib and the PSA, the new episode.",
      [audioUrl("unknown")]: "Die Patienten erhielten eine Strahlentherapie.",
      "https://example.org/t.txt": "Olaparib and the PSA, written down.",
    });
    expect(await index(fetch)).toEqual({ indexed: 1, skipped: 4, failed: 0 });
    fetch.mockClear();
    await setWorkers(pool, 1);

    start(fetch);

    await until(async () =>
      expect(await states()).toEqual({
        "podcast:new": "indexed",
        "podcast:unknown": "skipped: not English",
        "podcast:old": "indexed",
        "podcast:german": "skipped: non-English metadata",
        "podcast:written": "indexed",
      }),
    );
    // Newest first; nothing but the audio is asked for again.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      ["new", "unknown", "old"].map(audioUrl),
    );
    const stored = await pool.query(
      `SELECT url, media_type, words, terms FROM keyword.full_texts
       WHERE document_id = 'podcast:new'`,
    );
    expect(stored.rows).toEqual([
      {
        url: audioUrl("new"),
        media_type: "audio/mpeg",
        words: 3,
        terms: "episode olaparib psa",
      },
    ]);
    // The indexer has nothing to read again.
    expect(await index(fetch)).toEqual({ indexed: 0, skipped: 0, failed: 0 });
    await until(async () =>
      expect((await job())?.state).toMatchObject({
        model: "test-model",
        max_workers: 3,
        workers: 0,
        read: { indexed: 2, skipped: 1, failed: 0, changed: 0 },
        speed: expect.any(Number),
        error: null,
      }),
    );
    expect((await job())?.state?.recent.map(({ id }) => id)).toEqual([
      "podcast:old",
      "podcast:unknown",
      "podcast:new",
    ]);
  });

  test("follows the setting while it runs: more start at once, too many end after their audio", async () => {
    const ids = ["1", "2", "3", "4", "5", "6"];
    const said = (id: string) => `Olaparib and the PSA, file ${id}.`;
    for (const id of ids) {
      await episode(id, { published_at: `2026-01-0${7 - Number(id)}` });
    }
    const fetch = serve(
      Object.fromEntries(ids.map((id) => [audioUrl(id), said(id)])),
    );
    await index(fetch);
    const speech = held();
    onTestFinished(() => speech.releaseAll());
    const { lines } = start(fetch, { transcribe: speech.transcribe });
    // Off: the job runs and reports, but reads nothing.
    await until(async () => expect((await job())?.reported_at).not.toBeNull());
    await polls();
    expect(speech.heard).toEqual([]);

    await setWorkers(pool, 2);
    await until(() => expect(speech.running()).toBe(2));
    await until(async () =>
      expect((await job())?.state).toMatchObject({
        workers: 2,
        reading: [
          { id: "podcast:1", step: "transcribing", duration_seconds: 600 },
          { id: "podcast:2", step: "transcribing" },
        ],
      }),
    );

    // More than the machine reads at once counts as its most: three.
    await setWorkers(pool, 9);
    await until(() => expect(speech.running()).toBe(3));
    await polls();
    expect(speech.running()).toBe(3);

    // Fewer: the audio in work is read to its end, but no new one starts.
    await setWorkers(pool, 1);
    await until(() => expect(lines).toContain("reading 1 at once, was 3"));
    expect(speech.running()).toBe(3);
    speech.release(said("1"));
    speech.release(said("2"));
    await until(() => expect(speech.running()).toBe(1));
    await polls();
    expect(speech.heard).toEqual(["1", "2", "3"].map(said));
    speech.release(said("3"));
    await until(() => expect(speech.heard).toHaveLength(4));
    await polls();
    expect(speech.running()).toBe(1);

    // Off again: the audio in work is stored, the rest waits.
    await setWorkers(pool, 0);
    await until(() => expect(lines).toContain("reading 0 at once, was 1"));
    speech.release(said("4"));
    await until(async () =>
      expect((await job())?.state).toMatchObject({ workers: 0, reading: [] }),
    );
    await polls();
    expect(await states()).toEqual({
      "podcast:1": "indexed",
      "podcast:2": "indexed",
      "podcast:3": "indexed",
      "podcast:4": "indexed",
      "podcast:5": WAITING,
      "podcast:6": WAITING,
    });
  });

  test("does not overwrite a row the indexer wrote meanwhile, and reads the changed document again", async () => {
    await episode("changed");
    await episode("german");
    const fetch = serve({
      [audioUrl("changed")]: "Olaparib and the PSA, as first recorded.",
      [audioUrl("german")]: "Olaparib and the PSA.",
    });
    await index(fetch);
    const speech = held();
    onTestFinished(() => speech.releaseAll());
    await setWorkers(pool, 2);
    start(fetch, { transcribe: speech.transcribe });
    await until(() => expect(speech.running()).toBe(2));

    // While both are read: one document changes, the other turns out not to be English,
    // and the indexer runs.
    await pool.query(
      `UPDATE documents SET title = 'Edited', changed_at = changed_at + interval '1 second'
       WHERE id = 'podcast:changed'`,
    );
    await pool.query(
      `UPDATE documents SET extra = '{"metadata_language":"de"}' WHERE id = 'podcast:german'`,
    );
    expect(await index(fetch)).toEqual({ indexed: 0, skipped: 1, failed: 0 });
    speech.release("Olaparib and the PSA, as first recorded.");
    speech.release("Olaparib and the PSA.");

    await until(async () =>
      expect((await job())?.state?.read).toMatchObject({ changed: 2 }),
    );
    expect(await states()).toMatchObject({
      "podcast:german": "skipped: non-English metadata",
    });
    // The changed document waits again, and is read again.
    await until(() => expect(speech.running()).toBe(1));
    expect(await states()).toMatchObject({ "podcast:changed": WAITING });
    speech.release("Olaparib and the PSA, as first recorded.");
    await until(async () =>
      expect(await states()).toMatchObject({ "podcast:changed": "indexed" }),
    );
    expect(await index(fetch)).toEqual({ indexed: 0, skipped: 0, failed: 0 });
  });

  test("stores a failed download as failed, which the next index run opens again", async () => {
    await episode("1");
    const fetch = serve({ [audioUrl("1")]: 503 });
    await index(fetch);
    await setWorkers(pool, 1);
    start(fetch);

    await until(async () =>
      expect(await states()).toEqual({ "podcast:1": "failed: HTTP 503" }),
    );
    expect((await job())?.state?.read).toMatchObject({ failed: 1 });

    fetch.mockImplementation(async () => new Response("Olaparib and the PSA."));
    expect(await index(fetch)).toEqual({ indexed: 0, skipped: 1, failed: 0 });
    await until(async () =>
      expect(await states()).toEqual({ "podcast:1": "indexed" }),
    );
  });

  test("rests when speech-to-text failed five times in a row, and sets it up again", async () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7"];
    for (const id of ids) await episode(id);
    const fetch = serve(
      Object.fromEntries(
        ids.map((id) => [audioUrl(id), "Olaparib and the PSA."]),
      ),
    );
    await index(fetch);
    let broken = true;
    const transcribe = vi.fn(async (audio: Uint8Array) => {
      if (broken) throw new Error("speech-to-text failed: no such model");
      return hear(audio);
    });
    const prepare = vi.fn(async () => {});
    await setWorkers(pool, 1);
    start(fetch, { transcribe, prepare, pauseMs: 2_000 });

    await until(async () =>
      expect((await job())?.state?.error).toMatch(
        /^Speech-to-text failed 5 times in a row, the last time with: speech-to-text failed: no such model/,
      ),
    );
    // No further file is downloaded for nothing.
    expect(transcribe).toHaveBeenCalledTimes(5);
    const stored = Object.values(await states());
    expect(stored.filter((state) => state === WAITING)).toHaveLength(2);

    broken = false;
    await until(async () =>
      expect(Object.values(await states()).sort()).toEqual([
        ...Array(5).fill("failed: speech-to-text failed: no such model"),
        "indexed",
        "indexed",
      ]),
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    expect((await job())?.state?.error).toBeNull();
  });

  test("does not rest when downloads fail: a host that is down holds up no other file", async () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7"];
    for (const id of ids) await episode(id);
    const fetch = serve({
      ...Object.fromEntries(ids.map((id) => [audioUrl(id), 503])),
      [audioUrl("7")]: "Olaparib and the PSA.",
    });
    await index(fetch);
    await setWorkers(pool, 1);
    start(fetch);

    await until(async () =>
      expect(Object.values(await states()).sort()).toEqual([
        ...Array(6).fill("failed: HTTP 503"),
        "indexed",
      ]),
    );
    expect((await job())?.state?.error).toBeNull();
  });

  test("sets speech-to-text up before the first audio, and again when that fails", async () => {
    await episode("1");
    const fetch = serve({ [audioUrl("1")]: "Olaparib and the PSA." });
    await index(fetch);
    const prepare = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("speech-to-text did not start: no uv"))
      .mockResolvedValue();
    start(fetch, { prepare, idleMs: 2_000 });

    // Off: nothing is set up, so no model is downloaded for nothing.
    await polls();
    expect(prepare).not.toHaveBeenCalled();

    await setWorkers(pool, 1);
    await until(async () =>
      expect((await job())?.state?.error).toBe(
        "speech-to-text did not start: no uv",
      ),
    );
    await until(async () =>
      expect(await states()).toEqual({ "podcast:1": "indexed" }),
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    expect((await job())?.state?.error).toBeNull();
  });

  test("gives up the audio in work when it is stopped, and leaves it waiting", async () => {
    await episode("1");
    const fetch = serve({ [audioUrl("1")]: "Olaparib and the PSA." });
    await index(fetch);
    const speech = held();
    await setWorkers(pool, 1);
    const { end } = start(fetch, { transcribe: speech.transcribe });
    await until(() => expect(speech.running()).toBe(1));

    await end();
    speech.releaseAll();
    await polls();

    expect(await states()).toEqual({ "podcast:1": WAITING });
    // The setting stays, and the row tells that no job runs.
    expect(await job()).toMatchObject({ workers: 1, reported_at: null });
  });

  test("refuses a setting that is no count", async () => {
    await expect(setWorkers(pool, -1)).rejects.toThrow(RangeError);
    await expect(setWorkers(pool, 1.5)).rejects.toThrow(RangeError);
  });
});
