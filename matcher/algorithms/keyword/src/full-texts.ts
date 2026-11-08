import { indexChangedDocuments, type Queryable } from "@matcher/db";
import type { Downloader } from "@matcher/download";
import { createSchema } from "./schema.ts";

export type FullTextStatus = "indexed" | "skipped" | "failed";

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
// Enough for any paper; keeps the lexemes of a long book under Postgres' 1 MB tsvector limit.
const MAX_WORDS = 50_000;

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
        const words = result.status === "ok" ? wordBag(result.text) : [];
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
            result.detail ?? (status === "skipped" ? "no words" : null),
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

/** The words of a text in lower case and alphabetical order: what BM25 counts, but no text. */
function wordBag(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? [])
    .filter((word) => word.length <= 40)
    .slice(0, MAX_WORDS)
    .sort();
}
