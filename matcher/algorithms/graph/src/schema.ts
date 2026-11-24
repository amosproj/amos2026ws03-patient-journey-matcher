import type { Queryable } from "@matcher/db";
import type { NormalizedEntity, NormalizedRelation } from "./types.ts";

export interface Paper {
  entities: Record<string, Pick<NormalizedEntity, "name" | "type" | "inTitle">>;
  relations: NormalizedRelation[];
}

/** Flags of a MeSH ID in `graph.documents.mesh`; one ID can have several. */
export const MESH_MAJOR = 4;
export const MESH_MINOR = 8;
export const MESH_SUBSTANCE = 16;

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
    -- The PubMed MeSH headings of the paper from documents.subjects, by ID with flags: 4 major
    -- topic, 8 other heading, 16 substance of the chemical list. A descriptor with a qualifier
    -- is an ID of its own (mesh:D011471Q000601, Prostatic Neoplasms/surgery). NULL until filled.
    ALTER TABLE graph.documents ADD COLUMN IF NOT EXISTS mesh jsonb;
    CREATE INDEX IF NOT EXISTS graph_entities ON graph.documents USING gin (entities);
    CREATE INDEX IF NOT EXISTS graph_mesh ON graph.documents USING gin (mesh);
    CREATE OR REPLACE FUNCTION graph.mesh_flags(subjects jsonb) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
      SELECT coalesce(jsonb_object_agg(id, flags), '{}'::jsonb)
      FROM (
        SELECT 'mesh:' || (s ->> 'id') AS id,
               bit_or(CASE WHEN s ->> 'id' LIKE 'C%' OR s -> 'major' IS NULL
                             OR jsonb_typeof(s -> 'major') = 'null' THEN ${MESH_SUBSTANCE}
                           WHEN (s ->> 'major')::boolean THEN ${MESH_MAJOR}
                           ELSE ${MESH_MINOR} END) AS flags
        FROM jsonb_array_elements(subjects) AS s
        WHERE s ->> 'scheme' = 'mesh' AND s ->> 'id' ~ '^[CD][0-9]+(Q[0-9]+)?$'
        GROUP BY 1
      ) AS flagged
    $$;
    -- Hide due retries from the change detector, but keep any last good data searchable.
    CREATE OR REPLACE VIEW graph.indexed_documents AS
      SELECT document_id, document_changed_at FROM graph.documents WHERE retry_at > now();
    -- Rows from before the mesh column get it from the stored headings, without PubTator3.
    UPDATE graph.documents AS g SET mesh = graph.mesh_flags(d.subjects)
    FROM public.documents AS d WHERE d.id = g.document_id AND g.mesh IS NULL;
  `);
}
