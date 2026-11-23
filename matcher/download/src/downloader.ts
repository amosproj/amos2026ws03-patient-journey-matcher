import { extractText, formatOf } from "./extract.ts";
import type { Transcribe } from "./transcribe.ts";

export {
  createTranscriber,
  silence,
  type Transcribe,
  type TranscribeLimits,
} from "./transcribe.ts";

/** Where a full text can be fetched: an entry of `documents.full_text`, written by the crawler. */
export interface Locator {
  kind: string;
  url: string;
  media_type: string | null;
  size: number | null;
}

/**
 * The full text of a document. `skipped`: nothing readable, for good. `failed`: the download
 * failed, worth another try later.
 */
export interface FullText {
  status: "ok" | "skipped" | "failed";
  /** The text if `ok`, else empty. Kept in memory; only a transcript is stored, until every index read it. */
  text: string;
  /** The locator the text comes from, or the last one tried. */
  url?: string;
  mediaType?: string;
  /** Why it was skipped or failed. */
  detail?: string;
}

/** What a server answered: its status and, if that is 2xx, the body, unless it is too large. */
export interface Answer {
  status: number;
  body?: Uint8Array;
}

/** Reads the full text of a document from its locators. */
export interface Downloader {
  /** `transcribe`: speech-to-text for audio files; without it, audio is not read. */
  fullText(
    locators: readonly Locator[],
    transcribe?: Transcribe,
  ): Promise<FullText>;
  /**
   * The answer of any other URL, such as an API, with the retries and the request budget of
   * its host. Throws when the network or the server keeps failing.
   */
  get(url: string): Promise<Answer>;
}

export interface DownloaderOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds between two requests to the same host. */
  intervalMs?: (host: string) => number;
  maxBytes?: number;
  timeoutMs?: number;
  maxAudioBytes?: number;
  /** The transcript stored for an audio file, read instead of it when no `transcribe` is given. */
  transcript?: (url: string) => Promise<FullText | undefined>;
}

/** Why a document with audio was skipped: no transcript of it is stored yet. */
export const NO_SPEECH_TO_TEXT = "audio, and speech-to-text is off";

/** The locators whose audio speech-to-text can read. */
export function audioLocators<L extends Locator>(locators: readonly L[]): L[] {
  return locators.filter((locator) => formatOf(locator) === "audio");
}

const USER_AGENT =
  "patient-journey-matcher/0.1 (+https://github.com/amosproj/amos2026ws03-patient-journey-matcher)";
// The request budgets of Documentation/design/sources.md: arXiv's robots.txt asks for 15 s,
// Zenodo allows 60 file requests a minute, the PMC bucket publishes no limit; PubTator3 at
// NCBI gets our own one a second, podcast hosts and all others our own 20 a minute.
const INTERVAL_MS: Record<string, number> = {
  "arxiv.org": 15_000,
  "zenodo.org": 1_000,
  "pmc-oa-opendata.s3.amazonaws.com": 100,
  "www.ncbi.nlm.nih.gov": 1_000,
};
const DEFAULT_INTERVAL_MS = 3_000;
const MAX_BYTES = 50_000_000;
// An hour of podcast at 320 kbit/s.
const MAX_AUDIO_BYTES = 150_000_000;
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
// Locators come in fetch order (arXiv: HTML, then the PDF); later ones are supplements.
const MAX_LOCATORS = 3;

/** A locator and how the text of its file is read. */
interface Reader {
  locator: Locator;
  audio: boolean;
  text: (bytes: Uint8Array) => Promise<string>;
}

/** Downloads and reads full texts, keeping each host's request budget across parallel calls. */
export function createDownloader({
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = (host) => INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS,
  maxBytes = MAX_BYTES,
  timeoutMs = TIMEOUT_MS,
  maxAudioBytes = MAX_AUDIO_BYTES,
  transcript,
}: DownloaderOptions = {}): Downloader {
  const nextStart = new Map<string, number>();

  /** Waits for the host's turn. The slot is taken before waiting, so parallel calls queue up. */
  async function turn(host: string): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, nextStart.get(host) ?? 0);
    nextStart.set(host, start + intervalMs(host));
    if (start > now) await sleep(start - now);
  }

  /** No body if it is larger than `maxBytes`; network and server errors are retried. */
  async function get(url: string, maxBytes: number): Promise<Answer> {
    for (let attempt = 1; ; attempt++) {
      await turn(new URL(url).host);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) {
          const body = await readBody(response, maxBytes);
          return { status: response.status, body };
        }
      } catch (error) {
        if (attempt === ATTEMPTS) throw new Error(networkError(error));
        await sleep(2_000 * attempt);
        continue;
      }
      await response.body?.cancel();
      const { status } = response;
      if (status !== 408 && status !== 429 && status < 500) return { status };
      if (attempt === ATTEMPTS) throw new Error(`HTTP ${status}`);
      await sleep(retryAfterMs(response) ?? 2_000 * attempt);
    }
  }

  /** Reads one locator; `last` if the locators after it are not to be tried. */
  async function read({
    locator,
    audio,
    text,
  }: Reader): Promise<{ result: FullText; last: boolean }> {
    const tried = {
      text: "",
      url: locator.url,
      mediaType: locator.media_type ?? undefined,
    };
    const limit = audio ? maxAudioBytes : maxBytes;
    const tooLarge: FullText = {
      ...tried,
      status: "skipped",
      detail: `larger than ${limit} bytes`,
    };
    if ((locator.size ?? 0) > limit) return { result: tooLarge, last: false };
    let answer: Answer;
    try {
      answer = await get(locator.url, limit);
    } catch (error) {
      // A server or network error: try again later rather than read a lesser file now.
      return {
        result: { ...tried, status: "failed", detail: message(error) },
        last: true,
      };
    }
    const { status, body: bytes } = answer;
    // A missing file (arXiv has no HTML for PDF-only uploads): read the next one.
    if (status < 200 || status > 299) {
      return {
        result: { ...tried, status: "failed", detail: `HTTP ${status}` },
        last: false,
      };
    }
    if (bytes === undefined) return { result: tooLarge, last: false };
    try {
      const found = await text(bytes);
      return found.trim() !== ""
        ? { result: { ...tried, status: "ok", text: found }, last: true }
        : {
            result: { ...tried, status: "skipped", detail: "no text" },
            last: false,
          };
    } catch (error) {
      // Speech-to-text fails for reasons a later run may not have: no model yet, no uv.
      return audio
        ? {
            result: { ...tried, status: "failed", detail: message(error) },
            last: true,
          }
        : {
            result: {
              ...tried,
              status: "skipped",
              detail: `unreadable: ${message(error)}`,
            },
            last: false,
          };
    }
  }

  /** The text of the first readable locator that has one. */
  async function fullText(
    locators: readonly Locator[],
    transcribe?: Transcribe,
  ): Promise<FullText> {
    const readers = locators.flatMap((locator): Reader[] => {
      const format = formatOf(locator);
      if (format === undefined) return [];
      if (format !== "audio") {
        const text = (bytes: Uint8Array) => extractText(bytes, format);
        return [{ locator, audio: false, text }];
      }
      return transcribe ? [{ locator, audio: true, text: transcribe }] : [];
    });
    const unreadAudio =
      !transcribe && locators.some((l) => formatOf(l) === "audio");
    let result: FullText = { status: "skipped", text: "" };
    if (readers.length === 0 && !unreadAudio) {
      const types = [...new Set(locators.map((l) => l.media_type ?? l.kind))];
      result.detail =
        types.length > 0
          ? `no readable format: ${types.join(", ")}`
          : "no full text";
    }
    for (const reader of readers.slice(0, MAX_LOCATORS)) {
      const { result: tried, last } = await read(reader);
      result = tried;
      if (last) return result;
    }
    if (!unreadAudio || result.status !== "skipped") return result;
    for (const locator of audioLocators(locators)) {
      const stored = await transcript?.(locator.url);
      if (stored)
        return { ...stored, mediaType: locator.media_type ?? undefined };
    }
    return { ...result, detail: NO_SPEECH_TO_TEXT };
  }

  return { fullText, get: (url) => get(url, maxBytes) };
}

/** The body, or undefined once it grows over `maxBytes`. */
async function readBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    return undefined;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) return undefined; // leaving the loop cancels the stream
    chunks.push(chunk);
  }
  // A Uint8Array, not a Buffer: pdf.js refuses Buffers.
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Retry-After in seconds, at most a minute. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  return header !== null && Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds, 60) * 1000
    : undefined;
}

function networkError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return "timed out";
  const code =
    error instanceof Error
      ? (error.cause as { code?: string })?.code
      : undefined;
  return `network error: ${code ?? message(error)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
