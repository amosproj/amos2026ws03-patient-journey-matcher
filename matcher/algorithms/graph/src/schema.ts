import type { Queryable } from "@matcher/db";
import type { NormalizedEntity, NormalizedRelation } from "./types.ts";

export interface Paper {
  entities: Record<string, Pick<NormalizedEntity, "name" | "type" | "inTitle">>;
  relations: NormalizedRelation[];
}

export async function ensureGraphSchema(db: Queryable): Promise<void> {
  await db.query(`
    CREATE SCHEMA IF NOT EXISTS graph;
    CREATE TABLE IF NOT EXISTS graph.documents (
      document_id text PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
      document_changed_at timestamptz NOT NULL,
      entities jsonb NOT NULL,
      relations jsonb NOT NULL,
      -- When to ask PubTator3 again for a paper it did not have; infinity when done.
      retry_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graph_entities ON graph.documents USING gin (entities);
    -- Hide due retries from the change detector, but keep any last good data searchable.
    CREATE OR REPLACE VIEW graph.indexed_documents AS
      SELECT document_id, document_changed_at FROM graph.documents WHERE retry_at > now();
  `);
}
