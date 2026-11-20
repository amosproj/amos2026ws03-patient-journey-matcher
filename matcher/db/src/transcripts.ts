import type { Queryable } from "./documents.ts";

/** What the transcription job read from an audio file, as the downloader gives a full text. */
export interface StoredTranscript {
  status: "ok" | "skipped";
  text: string;
  url: string;
  detail?: string;
}

/**
 * The transcript of an audio file, while its text is kept, for `createDownloader({ transcript })`
 * of @matcher/download: indexes read it like a downloaded full text.
 */
export function storedTranscripts(
  db: Queryable,
): (url: string) => Promise<StoredTranscript | undefined> {
  return async (url) => {
    const { rows } = await db.query<{
      status: "ok" | "skipped";
      text: string | null;
      detail: string | null;
    }>(
      `SELECT status, text, detail FROM transcripts
       WHERE url = $1 AND (status = 'skipped' OR text IS NOT NULL)
       ORDER BY read_at DESC
       LIMIT 1`,
      [url],
    );
    const [row] = rows;
    return (
      row && {
        status: row.status,
        text: row.text ?? "",
        url,
        detail: row.detail ?? undefined,
      }
    );
  };
}

/**
 * Drops the texts that every index has read: those stored before `before`, the start of an
 * indexer run over all approaches. The rows stay, so that the job does not read the audio again.
 */
export async function dropTranscriptTexts(
  db: Queryable,
  before: Date,
): Promise<number> {
  const { rowCount } = await db.query(
    "UPDATE transcripts SET text = NULL WHERE text IS NOT NULL AND read_at < $1",
    [before],
  );
  return rowCount ?? 0;
}
