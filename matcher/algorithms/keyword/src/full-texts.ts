import { indexChangedDocuments, type Queryable } from "@matcher/db";
import type { Downloader } from "@matcher/download";
// Common non-medical English words, most frequent first.
import basicWords from "../data/basic-words.json" with { type: "json" };
import { createSchema } from "./schema.ts";
import { ENGLISH_WORDS } from "./terms.ts";

type FullTextStatus = "indexed" | "skipped" | "failed";

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
 * download failed last time; returns how many of each status.
 */
export async function indexFullTexts(
  db: Queryable,
  downloader: Downloader,
  onDocument?: (counts: Record<FullTextStatus, number>) => void,
): Promise<Record<FullTextStatus, number>> {
  await createSchema(db);
  // A failed download (a server error, or PMC's 404 before an article is in its bucket) is tried
  // again in every run; a skipped one only when the document changes.
  await db.query("DELETE FROM keyword.full_texts WHERE status = 'failed'");
  const counts = { indexed: 0, skipped: 0, failed: 0 };
  await indexChangedDocuments(db, "keyword.full_texts", async (documents) => {
    // All at once: the downloader keeps each host's pace, so different hosts work in parallel.
    await Promise.all(
      documents.map(async (document) => {
        const result = await downloader.fullText(document.full_text);
        const found = result.status === "ok" ? keywords(result.text) : [];
        const words = found ?? [];
        const status: FullTextStatus =
          result.status === "failed"
            ? "failed"
            : words.length > 0
              ? "indexed"
              : "skipped";
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
            status,
            result.detail ??
              (found === undefined
                ? "not English"
                : status === "skipped"
                  ? "no keywords"
                  : null),
            result.url ?? null,
            result.mediaType ?? null,
            words.length,
            words.join(" "),
          ],
        );
        counts[status]++;
        onDocument?.(counts);
      }),
    );
  });
  return counts;
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
