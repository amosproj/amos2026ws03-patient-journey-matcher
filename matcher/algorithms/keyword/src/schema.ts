import type { Queryable } from "@matcher/db";

// The keyword index (pg_textsearch). Only the keyword indexer writes it; it creates the schema,
// as no other component uses it.
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

/** Creates what is missing of the keyword index; safe to run again. */
export async function createSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA);
}
