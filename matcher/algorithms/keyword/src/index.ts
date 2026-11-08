import {
  createDocumentStore,
  type DocumentRow,
  type Queryable,
} from "@matcher/db";
import { eventTerms, type JourneyEvent } from "./terms.ts";

export type { JourneyEvent } from "./terms.ts";

// The keyword index: one row per document with the text BM25 ranks (pg_textsearch). Only the
// indexer writes it; it creates the schema, as no other component uses it.
const SCHEMA = `
  CREATE EXTENSION IF NOT EXISTS pg_textsearch;
  CREATE SCHEMA IF NOT EXISTS keyword;
  CREATE TABLE IF NOT EXISTS keyword.documents (
    document_id text PRIMARY KEY REFERENCES public.documents (id) ON DELETE CASCADE,
    document_changed_at timestamptz NOT NULL,
    content text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS documents_content_idx ON keyword.documents
    USING bm25 (content) WITH (text_config = 'english');
`;
const INDEX = "keyword.documents_content_idx";
const BATCH_SIZE = 500;

/** Indexes the new and changed documents; returns how many. */
export async function indexDocuments(db: Queryable): Promise<number> {
  await db.query(SCHEMA);
  const store = createDocumentStore(db);
  let indexed = 0;
  for (;;) {
    const documents = await store.documentsToIndex(
      "keyword.documents",
      BATCH_SIZE,
    );
    if (documents.length === 0) return indexed;
    await db.query(
      `INSERT INTO keyword.documents (document_id, document_changed_at, content)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[])
       ON CONFLICT (document_id) DO UPDATE
       SET document_changed_at = EXCLUDED.document_changed_at, content = EXCLUDED.content`,
      [
        documents.map((document) => document.id),
        documents.map((document) => document.changed_at),
        documents.map(indexedText),
      ],
    );
    indexed += documents.length;
  }
}

/** Title, abstract or description, and subject labels (MeSH for PubMed). */
function indexedText(document: DocumentRow): string {
  const subjects = document.subjects.map((subject) => subject.label);
  return [document.title, document.summary ?? "", ...subjects].join("\n");
}

export interface KeywordQuery {
  focus: JourneyEvent;
  /** Older events that still matter; their terms count a third as much as the focus terms. */
  context: JourneyEvent[];
  limit: number;
  /** `content_type` values to keep; all if left out. */
  contentTypes?: string[];
}

export interface KeywordHit {
  id: string;
  /** BM25 relative to the best hit of the list, which has 1. */
  score: number;
  /** The query terms found in the document. */
  matchedTerms: string[];
}

/** The indexed documents that share terms with the journey, best BM25 score first. */
export async function matchJourney(
  db: Queryable,
  query: KeywordQuery,
): Promise<KeywordHit[]> {
  const focus = eventTerms(query.focus);
  const context = query.context.flatMap(eventTerms);
  const terms = [...new Set([...focus, ...context])];
  if (terms.length === 0) return [];
  // BM25 counts repeated query terms, so the focus terms go in three times: with two, the many
  // terms of older events outweighed them on the synthetic journeys. To be tuned in #11.
  const text = [...focus, ...focus, ...focus, ...new Set(context)].join(" ");
  // Rows without any term score 0 and sort last, so dropping them after the LIMIT loses no hit.
  const { rows } = await db.query<{
    id: string;
    score: number;
    matched_terms: string[];
  }>(
    `SELECT hit.id, hit.score,
            ARRAY(SELECT term FROM unnest($2::text[]) AS term
                  WHERE to_tsvector('english', hit.content) @@ plainto_tsquery('english', term))
              AS matched_terms
     FROM (
       SELECT k.document_id AS id, k.content,
              -(k.content <@> to_bm25query($1, '${INDEX}')) AS score
       FROM keyword.documents AS k
       JOIN public.documents AS d ON d.id = k.document_id
       WHERE (d.expires_at IS NULL OR d.expires_at > now())
         AND ($3::text[] IS NULL OR d.content_type = ANY ($3::text[]))
       ORDER BY k.content <@> to_bm25query($1, '${INDEX}')
       LIMIT $4
     ) AS hit
     WHERE hit.score > 0
     ORDER BY hit.score DESC, hit.id`,
    [text, terms, query.contentTypes ?? null, query.limit],
  );
  const best = rows[0]?.score ?? 1;
  return rows.map((row) => ({
    id: row.id,
    score: row.score / best,
    matchedTerms: row.matched_terms,
  }));
}
