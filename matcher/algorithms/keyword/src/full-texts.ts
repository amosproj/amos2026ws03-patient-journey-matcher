import {
  createDocumentStore,
  indexChangedDocuments,
  type Queryable,
} from "@matcher/db";
import {
  audioLocators,
  type Downloader,
  type FullText,
  NO_SPEECH_TO_TEXT,
} from "@matcher/download";
// Common non-medical English words, most frequent first.
import basicWords from "../data/basic-words.json" with { type: "json" };
import { englishMetadata, NON_ENGLISH_METADATA } from "./language.ts";
import { createSchema } from "./schema.ts";
import { ENGLISH_WORDS } from "./terms.ts";

export type FullTextStatus = "indexed" | "skipped" | "failed";

/** What `keyword.full_texts` holds of a read file. */
export interface FullTextRow {
  status: FullTextStatus;
  /** Why skipped or failed. */
  detail: string | null;
  url: string | null;
  mediaType: string | null;
  words: number;
  terms: string;
}

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
// Enough for any paper; keeps the lexemes of a long book under Postgres' 1 MB tsvector limit.
const MAX_WORDS = 50_000;
const BASIC = new Set(basicWords.words);
// The 100 most frequent: about 30% of an English text's words, under 10% in other languages.
const MOST_FREQUENT = new Set(basicWords.words.slice(0, 100));
const MIN_ENGLISH_SHARE = 0.12;
// shortcut: plural "s" only ("rising" goes for "rise"); use stems if needed.
const JOURNEY_WORDS = new Set(
  ENGLISH_WORDS.flatMap((word) => [word, `${word}s`, word.replace(/s$/, "")]),
);

/**
 * Downloads and indexes the full texts of new and changed documents, and of those whose
 * download failed last time; logs how many are to read, the progress every minute and a
 * summary, and returns how many of each status.
 */
export async function indexFullTexts(
  db: Queryable,
  downloader: Downloader,
  log: (line: string) => void = () => {},
): Promise<Record<FullTextStatus, number>> {
  await createSchema(db);
  await db.query(`UPDATE keyword.full_texts f
    SET status = 'skipped', detail = 'non-English metadata', terms = '', words = 0
    FROM documents d WHERE f.document_id = d.id
    AND (f.status <> 'skipped' OR f.detail IS DISTINCT FROM 'non-English metadata')
    AND ${NON_ENGLISH_METADATA}`);
  // A failed download (a server error, or PMC's 404 before an article is in its bucket) is tried
  // again in every run; a skipped one only when the document changes. Audio without a transcript
  // is skipped too: the transcription job reads it (transcription.ts).
  await db.query("DELETE FROM keyword.full_texts WHERE status = 'failed'");
  const toRead = () =>
    createDocumentStore(db).countToIndex("keyword.full_texts");
  let total = await toRead();
  log(`full texts: ${total} to read`);
  const counts = { indexed: 0, skipped: 0, failed: 0 };
  const read = () => counts.indexed + counts.skipped + counts.failed;
  // By the clock, not by count: arXiv's 15 s per request can hold the last documents up for minutes.
  const progress = setInterval(
    () => log(`full texts: ${read()} of ${total} read`),
    60_000,
  );
  await indexChangedDocuments(db, "keyword.full_texts", async (documents) => {
    // Again per batch, so that documents a crawl stores meanwhile raise the total.
    total = read() + (await toRead());
    // All at once: the downloader keeps each host's pace, so different hosts work in parallel.
    await Promise.all(
      documents.map(async (document) => {
        const result = englishMetadata(document)
          ? await downloader.fullText(document.full_text)
          : {
              status: "skipped" as const,
              text: "",
              detail: "non-English metadata",
            };
        if (result.detail === NO_SPEECH_TO_TEXT) {
          // What the transcription job read of this audio holds, whatever else changed.
          const { rows } = await db.query<{ status: FullTextStatus }>(
            `UPDATE keyword.full_texts SET document_changed_at = $2
             WHERE document_id = $1 AND status <> 'failed' AND url = ANY($3::text[])
             RETURNING status`,
            [
              document.id,
              document.changed_at,
              audioLocators(document.full_text).map((locator) => locator.url),
            ],
          );
          const [kept] = rows;
          if (kept !== undefined) {
            counts[kept.status]++;
            return;
          }
        }
        const row = fullTextRow(result);
        await db.query(
          `INSERT INTO keyword.full_texts (document_id, document_changed_at, status, detail, url,
                                           media_type, words, terms, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (document_id) DO UPDATE
           SET document_changed_at = EXCLUDED.document_changed_at, status = EXCLUDED.status,
               detail = EXCLUDED.detail, url = EXCLUDED.url, media_type = EXCLUDED.media_type,
               words = EXCLUDED.words, terms = EXCLUDED.terms, fetched_at = EXCLUDED.fetched_at`,
          [
            document.id,
            document.changed_at,
            row.status,
            row.detail,
            row.url,
            row.mediaType,
            row.words,
            row.terms,
          ],
        );
        counts[row.status]++;
      }),
    );
  }).finally(() => clearInterval(progress));
  log(
    `full texts: ${counts.indexed} indexed, ${counts.skipped} without text, ` +
      `${counts.failed} failed (tried again next run)`,
  );
  return counts;
}

/** The row for what a download gave: the keywords of an English text, else why it has none. */
export function fullTextRow(result: FullText): FullTextRow {
  const found = result.status === "ok" ? keywords(result.text) : [];
  const words = found ?? [];
  const status =
    result.status === "failed"
      ? "failed"
      : words.length > 0
        ? "indexed"
        : "skipped";
  return {
    status,
    detail:
      result.detail ??
      (found === undefined
        ? "not English"
        : status === "skipped"
          ? "no keywords"
          : null),
    url: result.url ?? null,
    mediaType: result.mediaType ?? null,
    words: words.length,
    terms: words.join(" "),
  };
}

/** The keywords of an English text, sorted, each as often as it occurs; undefined for other languages. */
export function keywords(text: string): string[] | undefined {
  const words = (
    text.toLowerCase().replaceAll("’", "'").match(WORD) ?? []
  ).filter((word) => word.length <= 40 && /\p{L}/u.test(word));
  const frequent = words.filter((word) => MOST_FREQUENT.has(word)).length;
  if (frequent < words.length * MIN_ENGLISH_SHARE) return undefined;
  return words
    .filter((word) => !BASIC.has(word) || JOURNEY_WORDS.has(word))
    .slice(0, MAX_WORDS)
    .sort();
}
