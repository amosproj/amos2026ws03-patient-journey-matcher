import type { Queryable } from "@matcher/db";
import type { NormalizedEntity, NormalizedRelation } from "./types.ts";

export interface Paper {
  entities: Record<
    string,
    Pick<NormalizedEntity, "type" | "inTitle"> & {
      /** PubTator3's own name of the concept. How the paper spells it is not kept. */
      term?: string;
    }
  >;
  relations: NormalizedRelation[];
}

/** Flags of a MeSH ID in `graph.documents.mesh`; one ID can have several. */
export const MESH_MAJOR = 4;
export const MESH_MINOR = 8;
export const MESH_SUBSTANCE = 16;

// The names PubTator3 gives the diseases and chemicals of the indexed papers, for drugs the
// distributed vocabulary lacks. Only its own name of a concept (`term`) counts, never a spelling
// from a paper: one wrong annotation would make a common word a synonym of a disease.
export const CONCEPT_NAMES = `
    SELECT e.key AS id, e.value->>'type' AS type, min(e.value->>'term') AS name,
           array_agg(DISTINCT e.value->>'term' ORDER BY e.value->>'term') AS names
    FROM graph.documents AS g
    CROSS JOIN LATERAL jsonb_each(g.entities) AS e
    WHERE e.value->>'type' IN ('disease', 'chemical')
      AND e.key ~ '^mesh:[CD][0-9]+$' AND length(e.value->>'term') BETWEEN 4 AND 160
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
  CREATE MATERIALIZED VIEW IF NOT EXISTS graph.concept_names AS ${CONCEPT_NAMES};
  CREATE UNIQUE INDEX IF NOT EXISTS graph_concept_names_id_type ON graph.concept_names (id, type);
`;

/** Creates the graph index on its first run. */
export async function ensureGraphSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA);
}
