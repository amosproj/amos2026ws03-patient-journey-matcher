import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import { createDownloader } from "@matcher/download";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
import {
  setWorkers,
  type TranscriptionOptions,
  type TranscriptionState,
  transcribeAudio,
} from "./job.ts";

const databaseUrl = testDatabaseUrl();

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
      "UPDATE transcription SET state = NULL, reported_at = NULL",
    );
  });

  const audioUrl = (id: string) => `https://audio.example/${id}.mp3`;

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
        JSON.stringify(fields.extra ?? {}),
        JSON.stringify(locators.map((locator) => ({ ...locator, size: null }))),
      ],
    );
  }

  /** What the job stored, by document: the text, or `status: detail`. */
  async function transcripts(): Promise<Record<string, string>> {
    const { rows } = await pool.query<{ id: string; stored: string }>(
      `SELECT document_id AS id, coalesce(text, concat_ws(': ', status, detail)) AS stored
       FROM transcripts`,
    );
    return Object.fromEntries(rows.map(({ id, stored }) => [id, stored]));
  }

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
      downloader: createDownloader({
        fetch,
        sleep: async () => {},
        intervalMs: () => 0,
      }),
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
    }>("SELECT workers, state, reported_at FROM transcription");
    return rows[0];
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

  test("reads the audio of episodes without a transcript once, newest first, and stores what it heard", async () => {
    await episode("old", { published_at: "2024-05-01" });
    await episode("new", { published_at: "2026-05-01" });
    await episode("written", {
      published_at: "2025-05-01",
      transcript: "https://example.org/t.txt",
    });
    await episode("middle", {
      published_at: "2025-01-01",
      extra: { metadata_language: "en" },
    });
    await episode("german", { extra: { metadata_language: "de" } });
    const fetch = serve({
      [audioUrl("old")]: "The old episode.",
      [audioUrl("new")]: "The new episode.",
      [audioUrl("middle")]: "The middle episode.",
    });
    await setWorkers(pool, 1);

    start(fetch);

    await until(async () =>
      expect(await transcripts()).toEqual({
        "podcast:new": "The new episode.",
        "podcast:middle": "The middle episode.",
        "podcast:old": "The old episode.",
      }),
    );
    // Newest first; unknown metadata language counts as English. An episode with a transcript
    // file is the indexer's, one with German metadata is left out.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      ["new", "middle", "old"].map(audioUrl),
    );
    const { rows } = await pool.query(
      `SELECT url, status, model FROM transcripts
       WHERE document_id = 'podcast:new'`,
    );
    expect(rows).toEqual([
      {
        url: audioUrl("new"),
        status: "ok",
        model: "test-model",
      },
    ]);
    await until(async () =>
      expect((await job())?.state).toMatchObject({
        model: "test-model",
        max_workers: 3,
        workers: 0,
        read: { ok: 3, skipped: 0, failed: 0 },
        speed: expect.any(Number),
        error: null,
      }),
    );
    expect((await job())?.state?.recent.map(({ id }) => id)).toEqual([
      "podcast:old",
      "podcast:middle",
      "podcast:new",
    ]);
    // Once every index read the texts, they go; the rows keep the job from reading again.
    await pool.query("UPDATE transcripts SET text = NULL");
    await polls();
    expect(fetch).toHaveBeenCalledTimes(3);
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
    expect(Object.keys(await transcripts()).sort()).toEqual(
      ["1", "2", "3", "4"].map((id) => `podcast:${id}`),
    );
  });

  test("reads the audio again when the episode has another file", async () => {
    await episode("1");
    const fetch = serve({
      [audioUrl("1")]: "The first file.",
      [audioUrl("1b")]: "The second file.",
    });
    await setWorkers(pool, 1);
    start(fetch);
    await until(async () =>
      expect(await transcripts()).toEqual({ "podcast:1": "The first file." }),
    );

    await pool.query(
      `UPDATE documents SET full_text = jsonb_set(full_text, '{0,url}', $1)`,
      [JSON.stringify(audioUrl("1b"))],
    );

    await until(async () =>
      expect(await transcripts()).toEqual({ "podcast:1": "The second file." }),
    );
  });

  test("stores a failed download as failed, and tries it again a day later", async () => {
    await episode("1");
    const fetch = serve({ [audioUrl("1")]: 503 });
    await setWorkers(pool, 1);
    start(fetch);

    await until(async () =>
      expect(await transcripts()).toEqual({ "podcast:1": "failed: HTTP 503" }),
    );
    await until(async () =>
      expect((await job())?.state?.read).toMatchObject({ failed: 1 }),
    );
    const calls = fetch.mock.calls.length;
    await polls();
    expect(fetch).toHaveBeenCalledTimes(calls);

    fetch.mockImplementation(async () => new Response("The episode."));
    await pool.query(
      "UPDATE transcripts SET read_at = now() - interval '25 hours'",
    );
    await until(async () =>
      expect(await transcripts()).toEqual({ "podcast:1": "The episode." }),
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
    expect(Object.keys(await transcripts())).toHaveLength(5);

    broken = false;
    await until(async () =>
      expect(Object.values(await transcripts()).sort()).toEqual(
        [
          ...Array(5).fill("failed: speech-to-text failed: no such model"),
          "Olaparib and the PSA.",
          "Olaparib and the PSA.",
        ].sort(),
      ),
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    // The text is stored before the job reports.
    await until(async () => expect((await job())?.state?.error).toBeNull());
  });

  test("does not rest when downloads fail: a host that is down holds up no other file", async () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7"];
    for (const id of ids) await episode(id);
    const fetch = serve({
      ...Object.fromEntries(ids.map((id) => [audioUrl(id), 503])),
      [audioUrl("7")]: "Olaparib and the PSA.",
    });
    await setWorkers(pool, 1);
    start(fetch);

    await until(async () =>
      expect(Object.values(await transcripts()).sort()).toEqual(
        [...Array(6).fill("failed: HTTP 503"), "Olaparib and the PSA."].sort(),
      ),
    );
    expect((await job())?.state?.error).toBeNull();
  });

  test("sets speech-to-text up before the first audio, and again when that fails", async () => {
    await episode("1");
    const fetch = serve({ [audioUrl("1")]: "Olaparib and the PSA." });
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
      expect(await transcripts()).toEqual({
        "podcast:1": "Olaparib and the PSA.",
      }),
    );
    expect(prepare).toHaveBeenCalledTimes(2);
    await until(async () => expect((await job())?.state?.error).toBeNull());
  });

  test("gives up the audio in work when it is stopped, and leaves it waiting", async () => {
    await episode("1");
    const fetch = serve({ [audioUrl("1")]: "Olaparib and the PSA." });
    const speech = held();
    await setWorkers(pool, 1);
    const { end } = start(fetch, { transcribe: speech.transcribe });
    await until(() => expect(speech.running()).toBe(1));

    await end();
    speech.releaseAll();
    await polls();

    expect(await transcripts()).toEqual({});
    // The setting stays, and the row tells that no job runs.
    expect(await job()).toMatchObject({ workers: 1, reported_at: null });
  });

  test("refuses a setting that is no count", async () => {
    await expect(setWorkers(pool, -1)).rejects.toThrow(RangeError);
    await expect(setWorkers(pool, 1.5)).rejects.toThrow(RangeError);
  });
});
