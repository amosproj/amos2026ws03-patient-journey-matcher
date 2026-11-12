import { expect, test, vi } from "vitest";
import {
  createDownloader,
  type Locator,
  NO_SPEECH_TO_TEXT,
} from "./downloader.ts";

function locator(
  url: string,
  media_type: string | null,
  kind = "transcript",
  size: number | null = null,
): Locator {
  return { kind, url, media_type, size };
}

/** A fetch that answers each URL with the next of its answers; an Error is thrown. */
function fakeFetch(answers: Record<string, (Response | Error)[]>) {
  const fetch = vi.fn(
    async (input: string | URL | Request, _init?: RequestInit) => {
      const next = answers[String(input)]?.shift();
      if (next === undefined)
        throw new Error(`unexpected request ${String(input)}`);
      if (next instanceof Error) throw next;
      return next;
    },
  );
  return fetch;
}

const instant = { sleep: async () => {}, intervalMs: () => 0 };

test("reads the first readable locator with the project's User-Agent", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.txt": [new Response("Olaparib for prostate cancer.")],
  });
  const { fullText } = createDownloader({ fetch, ...instant });

  const result = await fullText([
    locator("https://a.org/a.mp3", "audio/mpeg", "audio"),
    locator("https://a.org/t.txt", "text/plain"),
  ]);

  expect(result).toEqual({
    status: "ok",
    text: "Olaparib for prostate cancer.",
    url: "https://a.org/t.txt",
    mediaType: "text/plain",
  });
  expect(fetch).toHaveBeenCalledOnce();
  const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
  expect(headers.get("user-agent")).toMatch(/^patient-journey-matcher\//);
});

test("tries the next locator when a file is missing", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.vtt": [new Response("", { status: 404 })],
    "https://a.org/t.txt": [new Response("Olaparib.")],
  });
  const { fullText } = createDownloader({ fetch, ...instant });

  const result = await fullText([
    locator("https://a.org/t.vtt", "text/vtt"),
    locator("https://a.org/t.txt", "text/plain"),
  ]);

  expect(result).toMatchObject({ status: "ok", url: "https://a.org/t.txt" });
});

test("fails when the only file is missing, to be tried again later", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.txt": [new Response("", { status: 404 })],
  });
  const { fullText } = createDownloader({ fetch, ...instant });

  await expect(
    fullText([locator("https://a.org/t.txt", "text/plain")]),
  ).resolves.toMatchObject({ status: "failed", detail: "HTTP 404" });
});

test("retries a server error after the time the server asks for", async () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const fetch = fakeFetch({
    "https://a.org/t.txt": [
      new Response("", { status: 503, headers: { "Retry-After": "7" } }),
      new Response("Olaparib."),
    ],
  });
  const { fullText } = createDownloader({ fetch, sleep, intervalMs: () => 0 });

  const result = await fullText([locator("https://a.org/t.txt", "text/plain")]);

  expect(result.status).toBe("ok");
  expect(sleep).toHaveBeenCalledWith(7000);
});

test("fails without reading another file when a server keeps failing", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.vtt": [
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new TypeError("fetch failed"),
    ],
  });
  const { fullText } = createDownloader({ fetch, ...instant });

  const result = await fullText([
    locator("https://a.org/t.vtt", "text/vtt"),
    locator("https://a.org/t.txt", "text/plain"),
  ]);

  expect(result).toMatchObject({
    status: "failed",
    url: "https://a.org/t.vtt",
  });
  expect(result.detail).toMatch(/^network error/);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("skips documents without a readable file, without a request", async () => {
  const fetch = fakeFetch({});
  const { fullText } = createDownloader({ fetch, ...instant });

  await expect(fullText([])).resolves.toMatchObject({
    status: "skipped",
    detail: "no full text",
  });
  await expect(
    fullText([
      locator("https://a.org/a.m4a", "audio/x-m4a", "audio"),
      locator("https://a.org/data", "application/octet-stream", "file"),
    ]),
  ).resolves.toMatchObject({
    status: "skipped",
    detail: "no readable format: audio/x-m4a, application/octet-stream",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("skips audio without speech-to-text, so that a run with it reads the audio", async () => {
  const fetch = fakeFetch({ "https://a.org/t.txt": [new Response(" ")] });
  const downloader = createDownloader({ fetch, ...instant });
  const audio = locator("https://a.org/a.mp3", "audio/mpeg", "audio");

  expect(downloader.transcribes).toBe(false);
  await expect(downloader.fullText([audio])).resolves.toEqual({
    status: "skipped",
    text: "",
    detail: NO_SPEECH_TO_TEXT,
  });
  // Also when a transcript is listed but empty.
  await expect(
    downloader.fullText([locator("https://a.org/t.txt", "text/plain"), audio]),
  ).resolves.toMatchObject({ status: "skipped", detail: NO_SPEECH_TO_TEXT });
  expect(fetch).toHaveBeenCalledOnce();
});

test("transcribes the audio when no transcript gives a text", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.vtt": [new Response("", { status: 404 })],
    "https://a.org/a.mp3": [new Response("mp3 bytes")],
  });
  const transcribe = vi.fn(async (_audio: Uint8Array) => "Olaparib, spoken.");
  const downloader = createDownloader({ fetch, ...instant, transcribe });

  const result = await downloader.fullText([
    locator("https://a.org/t.vtt", "text/vtt"),
    locator("https://a.org/a.mp3", "audio/mpeg", "audio"),
  ]);

  expect(downloader.transcribes).toBe(true);
  expect(result).toEqual({
    status: "ok",
    text: "Olaparib, spoken.",
    url: "https://a.org/a.mp3",
    mediaType: "audio/mpeg",
  });
  expect(new TextDecoder().decode(transcribe.mock.calls[0]?.[0])).toBe(
    "mp3 bytes",
  );
});

test("reads a transcript rather than the audio", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.txt": [new Response("Written.")],
  });
  const transcribe = vi.fn(async () => "Spoken.");
  const { fullText } = createDownloader({ fetch, ...instant, transcribe });

  const result = await fullText([
    locator("https://a.org/t.txt", "text/plain"),
    locator("https://a.org/a.mp3", "audio/mpeg", "audio"),
  ]);

  expect(result).toMatchObject({ status: "ok", text: "Written." });
  expect(transcribe).not.toHaveBeenCalled();
});

test("fails when speech-to-text fails, to be tried again later", async () => {
  const fetch = fakeFetch({ "https://a.org/a.mp3": [new Response("mp3")] });
  const transcribe = async () => {
    throw new Error("speech-to-text failed: no such model");
  };
  const { fullText } = createDownloader({ fetch, ...instant, transcribe });

  await expect(
    fullText([locator("https://a.org/a.mp3", "audio/mpeg", "audio")]),
  ).resolves.toMatchObject({
    status: "failed",
    detail: "speech-to-text failed: no such model",
  });
});

test("reads one audio file at a time, up to its own size limit", async () => {
  const fetch = fakeFetch({
    "https://a.org/1.mp3": [new Response("x".repeat(20))],
    "https://b.org/2.mp3": [new Response("x".repeat(20))],
    "https://c.org/3.mp3": [new Response("x".repeat(31))],
  });
  let running = 0;
  const transcribe = vi.fn(async () => {
    expect(++running).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
    return "Spoken.";
  });
  const { fullText } = createDownloader({
    fetch,
    ...instant,
    transcribe,
    maxBytes: 10,
    maxAudioBytes: 30,
  });

  const results = await Promise.all(
    ["https://a.org/1.mp3", "https://b.org/2.mp3", "https://c.org/3.mp3"].map(
      (url) => fullText([locator(url, "audio/mpeg", "audio")]),
    ),
  );

  expect(results.map(({ status, detail }) => detail ?? status)).toEqual([
    "ok",
    "ok",
    "larger than 30 bytes",
  ]);
  // The second file is downloaded only after the first is transcribed.
  expect(fetch.mock.invocationCallOrder[1]).toBeGreaterThan(
    transcribe.mock.invocationCallOrder[0] ?? 0,
  );
});

test("skips files over the size limit, by their stored size or while reading", async () => {
  const fetch = fakeFetch({
    "https://a.org/t.txt": [new Response("x".repeat(11))],
  });
  const { fullText } = createDownloader({ fetch, ...instant, maxBytes: 10 });

  await expect(
    fullText([locator("https://a.org/big.pdf", "application/pdf", "file", 11)]),
  ).resolves.toMatchObject({
    status: "skipped",
    detail: "larger than 10 bytes",
  });
  await expect(
    fullText([locator("https://a.org/t.txt", "text/plain")]),
  ).resolves.toMatchObject({
    status: "skipped",
    detail: "larger than 10 bytes",
  });
  expect(fetch).toHaveBeenCalledOnce();
});

test("skips a file without text", async () => {
  const fetch = fakeFetch({ "https://a.org/t.txt": [new Response(" \n ")] });
  const { fullText } = createDownloader({ fetch, ...instant });

  await expect(
    fullText([locator("https://a.org/t.txt", "text/plain")]),
  ).resolves.toMatchObject({ status: "skipped", detail: "no text" });
});

test("keeps each host's pace when called in parallel", async () => {
  const sleep = vi.fn(async (_ms: number) => {});
  const fetch = fakeFetch({
    "https://a.org/1.txt": [new Response("One.")],
    "https://a.org/2.txt": [new Response("Two.")],
    "https://b.org/3.txt": [new Response("Three.")],
  });
  const { fullText } = createDownloader({
    fetch,
    sleep,
    intervalMs: () => 15_000,
  });

  await Promise.all(
    ["https://a.org/1.txt", "https://a.org/2.txt", "https://b.org/3.txt"].map(
      (url) => fullText([locator(url, "text/plain")]),
    ),
  );

  expect(sleep).toHaveBeenCalledOnce();
  expect(sleep.mock.calls[0]?.[0]).toBeGreaterThan(14_900);
});
