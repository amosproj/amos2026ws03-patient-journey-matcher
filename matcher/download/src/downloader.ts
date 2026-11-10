import { extractText, formatOf } from "./extract.ts";

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
  /** The text if `ok`, else empty. Kept in memory only, never stored. */
  text: string;
  /** The locator the text comes from, or the last one tried. */
  url?: string;
  mediaType?: string;
  /** Why it was skipped or failed. */
  detail?: string;
}

/** Reads the full text of a document from its locators. */
export interface Downloader {
  fullText(locators: readonly Locator[]): Promise<FullText>;
}

export interface DownloaderOptions {
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds between two requests to the same host. */
  intervalMs?: (host: string) => number;
  maxBytes?: number;
}

const USER_AGENT =
  "patient-journey-matcher/0.1 (+https://github.com/amosproj/amos2026ws03-patient-journey-matcher)";
// The request budgets of Documentation/sources/README.md §5: arXiv's robots.txt asks for 15 s,
// Zenodo allows 60 file requests a minute, the PMC bucket publishes no limit; podcast hosts
// and all others get our own 20 a minute.
const INTERVAL_MS: Record<string, number> = {
  "arxiv.org": 15_000,
  "zenodo.org": 1_000,
  "pmc-oa-opendata.s3.amazonaws.com": 100,
};
const DEFAULT_INTERVAL_MS = 3_000;
const MAX_BYTES = 50_000_000;
const TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
// Locators come in fetch order (arXiv: HTML, then the PDF); later ones are supplements.
const MAX_LOCATORS = 3;

/** A 4xx answer: the file is not there, the next locator may be. */
class Unavailable extends Error {}

/** Downloads and reads full texts, keeping each host's request budget across parallel calls. */
export function createDownloader({
  fetch = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  intervalMs = (host) => INTERVAL_MS[host] ?? DEFAULT_INTERVAL_MS,
  maxBytes = MAX_BYTES,
}: DownloaderOptions = {}): Downloader {
  const nextStart = new Map<string, number>();
  const tooLarge = `larger than ${maxBytes} bytes`;

  /** Waits for the host's turn. The slot is taken before waiting, so parallel calls queue up. */
  async function turn(host: string): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, nextStart.get(host) ?? 0);
    nextStart.set(host, start + intervalMs(host));
    if (start > now) await sleep(start - now);
  }

  /** The body, or undefined if it is larger than `maxBytes`; network and server errors are retried. */
  async function get(url: string): Promise<Uint8Array | undefined> {
    for (let attempt = 1; ; attempt++) {
      await turn(new URL(url).host);
      let response: Response;
      try {
        response = await fetch(url, {
          headers: { "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (response.ok) return await readBody(response, maxBytes);
      } catch (error) {
        if (attempt === ATTEMPTS) throw new Error(networkError(error));
        await sleep(2_000 * attempt);
        continue;
      }
      await response.body?.cancel();
      const { status } = response;
      if (status !== 408 && status !== 429 && status < 500) {
        throw new Unavailable(`HTTP ${status}`);
      }
      if (attempt === ATTEMPTS) throw new Error(`HTTP ${status}`);
      await sleep(retryAfterMs(response) ?? 2_000 * attempt);
    }
  }

  /** The text of the first readable locator that has one. */
  async function fullText(locators: readonly Locator[]): Promise<FullText> {
    const readable = locators.flatMap((locator) => {
      const format = formatOf(locator);
      return format ? [{ locator, format }] : [];
    });
    if (readable.length === 0) {
      const types = [...new Set(locators.map((l) => l.media_type ?? l.kind))];
      return {
        status: "skipped",
        text: "",
        detail:
          types.length > 0
            ? `no readable format: ${types.join(", ")}`
            : "no full text",
      };
    }
    let result: FullText = { status: "skipped", text: "" };
    for (const { locator, format } of readable.slice(0, MAX_LOCATORS)) {
      const tried = {
        text: "",
        url: locator.url,
        mediaType: locator.media_type ?? undefined,
      };
      if ((locator.size ?? 0) > maxBytes) {
        result = { ...tried, status: "skipped", detail: tooLarge };
        continue;
      }
      let bytes: Uint8Array | undefined;
      try {
        bytes = await get(locator.url);
      } catch (error) {
        result = { ...tried, status: "failed", detail: message(error) };
        // A missing file (arXiv has no HTML for PDF-only uploads): read the next one. A server
        // or network error: try again later rather than read a lesser file now.
        if (error instanceof Unavailable) continue;
        return result;
      }
      if (bytes === undefined) {
        result = { ...tried, status: "skipped", detail: tooLarge };
        continue;
      }
      try {
        const text = await extractText(bytes, format);
        if (text.trim() !== "") return { ...tried, status: "ok", text };
        result = { ...tried, status: "skipped", detail: "no text" };
      } catch (error) {
        result = {
          ...tried,
          status: "skipped",
          detail: `unreadable: ${message(error)}`,
        };
      }
    }
    return result;
  }

  return { fullText };
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
