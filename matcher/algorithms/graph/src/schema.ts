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
      relations jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS graph_entities ON graph.documents USING gin (entities);
    ALTER TABLE graph.documents ADD COLUMN IF NOT EXISTS retry_at timestamptz;
    -- Older index rows did not distinguish missing exports from completed ones.
    UPDATE graph.documents g SET retry_at = CASE
      WHEN d.source = 'pubmed' AND d.native_id ~ '^[0-9]+$' AND g.entities = '{}'::jsonb THEN now()
      ELSE 'infinity'::timestamptz END
    FROM public.documents d WHERE g.document_id = d.id AND g.retry_at IS NULL;
    -- Hide due retries from the change detector, but keep any last good data searchable.
    CREATE OR REPLACE VIEW graph.indexed_documents AS
      SELECT document_id, document_changed_at FROM graph.documents WHERE retry_at > now();
  `);
}
