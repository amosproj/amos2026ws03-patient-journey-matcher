import type { Queryable } from "@matcher/db";

// The keyword index (pg_textsearch): one row per document for its metadata, one for its full
// text. Only the keyword indexer and its transcription job write it; they create the schema, as
// no other component uses it.
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
  -- The keywords of a full text, sorted, each as often as it occurs; BM25 ranks them like the
  -- text, which is not stored. Also a row without text (status).
  CREATE TABLE IF NOT EXISTS keyword.full_texts (
    document_id text PRIMARY KEY REFERENCES public.documents (id) ON DELETE CASCADE,
    document_changed_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('indexed', 'skipped', 'failed')),
    detail text,
    url text,
    media_type text,
    words integer NOT NULL,
    terms text NOT NULL,
    lexemes tsvector GENERATED ALWAYS AS (strip(to_tsvector('english', terms))) STORED,
    fetched_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS full_texts_terms_idx ON keyword.full_texts
    USING bm25 (terms) WITH (text_config = 'english') WHERE status = 'indexed';
  -- The transcription job, in one row: how many audio files it is to read at once (0: none; the
  -- debug UI sets it), and what the running job reported last (transcription.ts).
  CREATE TABLE IF NOT EXISTS keyword.transcription (
    only_row boolean PRIMARY KEY DEFAULT true CHECK (only_row),
    workers integer NOT NULL DEFAULT 0 CHECK (workers >= 0),
    state jsonb,
    reported_at timestamptz
  );
`;

/** Creates what is missing of the keyword index; safe to run again. */
export async function createSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA);
}
