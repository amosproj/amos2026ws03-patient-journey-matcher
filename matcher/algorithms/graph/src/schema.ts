import type { Queryable } from "@matcher/db";
import type { NormalizedEntity, NormalizedRelation } from "./types.ts";

export interface Paper {
  entities: Record<
    string,
    Pick<NormalizedEntity, "name" | "type" | "inTitle"> & { names?: string[] }
  >;
  relations: NormalizedRelation[];
}

/** Flags of a MeSH ID in `graph.documents.mesh`; one ID can have several. */
export const MESH_MAJOR = 4;
export const MESH_MINOR = 8;
export const MESH_SUBSTANCE = 16;

export const CORPUS_TERMS = `
    SELECT e.key AS id, e.value->>'type' AS type, min(alias) AS name,
           array_agg(DISTINCT alias ORDER BY alias) AS names
    FROM graph.documents AS g
    CROSS JOIN LATERAL jsonb_each(g.entities) AS e
    CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(e.value->'names', jsonb_build_array(e.value->>'name'))
    ) AS mention(alias)
    WHERE e.value->>'type' IN ('disease', 'chemical')
      AND e.key ~ '^mesh:[CD][0-9]+$' AND length(alias) BETWEEN 4 AND 160
    GROUP BY e.key, e.value->>'type'
  `;

const SCHEMA = `
  -- Serialize schema creation when two index jobs start together.
  SELECT pg_advisory_xact_lock(hashtext('graph.schema'));
  CREATE SCHEMA IF NOT EXISTS graph;
  CREATE TABLE IF NOT EXISTS graph.documents (
    document_id text PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
    document_changed_at timestamptz NOT NULL,
    entities jsonb NOT NULL,
    relations jsonb NOT NULL,
    -- When to ask PubTator3 again for a paper it did not have; infinity when done.
    retry_at timestamptz NOT NULL,
    -- MeSH IDs from documents.subjects, including descriptor/qualifier pairs.
    mesh jsonb NOT NULL
  );
  CREATE INDEX IF NOT EXISTS graph_entities ON graph.documents USING gin (entities);
  CREATE INDEX IF NOT EXISTS graph_mesh ON graph.documents USING gin (mesh);
  CREATE OR REPLACE FUNCTION graph.mesh_flags(source text, subjects jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT coalesce(jsonb_object_agg(id, flags), '{}'::jsonb)
    FROM (
      SELECT 'mesh:' || (s ->> 'id') AS id,
             -- PubMed lists chemicals without a major-topic flag. Zenodo omits it on headings too.
             bit_or(CASE
               WHEN source = 'pubmed' AND (s ->> 'id' LIKE 'C%' OR
                    (s ->> 'major' IS NULL AND s ->> 'id' NOT LIKE '%Q%')) THEN ${MESH_SUBSTANCE}
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
  CREATE MATERIALIZED VIEW IF NOT EXISTS graph.corpus_terms AS ${CORPUS_TERMS};
  CREATE UNIQUE INDEX IF NOT EXISTS graph_corpus_terms_id_type ON graph.corpus_terms (id, type);
`;

/** Creates the graph index on its first run. */
export async function ensureGraphSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA);
}
