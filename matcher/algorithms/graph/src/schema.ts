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

/**
 * How a paper has a concept, in `graph.evidence.flags`; one concept can have several. The MeSH
 * flags are also those of `graph.documents.mesh`.
 */
export const ENTITY = 1; // found by PubTator3
export const ENTITY_TITLE = 2; // found by PubTator3 in the title
export const MESH_MAJOR = 4;
export const MESH_MINOR = 8;
export const MESH_SUBSTANCE = 16;

// Raise with every change to what is derived from graph.documents (tables, views, triggers): the
// next index run builds it all again from the stored papers, without asking PubTator3.
const SCHEMA_VERSION = 2;

/**
 * Raise with every change to what is stored of an annotated paper: index runs fetch the papers
 * again, and each stays searchable with its old annotations until then.
 */
export const NORMALIZATION_VERSION = 1;

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

// One row per concept of a paper with how the paper has it, and its treats relations: what a
// match reads. `papers` has the columns of graph.documents.
const evidenceRows = (papers: string) => `
  INSERT INTO graph.evidence (concept, document_id, flags)
  SELECT concept, document_id, bit_or(flags)::smallint FROM (
    SELECT e.key, p.document_id,
           CASE WHEN (e.value ->> 'inTitle')::boolean THEN ${ENTITY | ENTITY_TITLE} ELSE ${ENTITY} END
    FROM ${papers} AS p CROSS JOIN LATERAL jsonb_each(p.entities) AS e
    UNION ALL
    SELECT m.key, p.document_id, m.value::int
    FROM ${papers} AS p CROSS JOIN LATERAL jsonb_each(p.mesh) AS m
  ) AS found (concept, document_id, flags)
  GROUP BY concept, document_id;
  INSERT INTO graph.treats (document_id, subject, object)
  SELECT DISTINCT p.document_id, r ->> 'subject', r ->> 'object'
  FROM ${papers} AS p CROSS JOIN LATERAL jsonb_array_elements(p.relations) AS r
  WHERE r ->> 'predicate' = 'treats';`;

// Built when the schema version changes; the foreign keys come after the rows, which is faster.
const DERIVED = `
  DROP VIEW IF EXISTS graph.indexed_documents;
  DROP MATERIALIZED VIEW IF EXISTS graph.concept_names;
  DROP TABLE IF EXISTS graph.evidence, graph.treats;
  -- Before version 2 the matcher searched graph.documents itself.
  DROP INDEX IF EXISTS graph.graph_entities, graph.graph_mesh;
  CREATE TABLE graph.evidence (concept text NOT NULL, document_id text NOT NULL, flags smallint NOT NULL);
  CREATE TABLE graph.treats (document_id text NOT NULL, subject text NOT NULL, object text NOT NULL);
  ${evidenceRows("graph.documents")}
  CREATE INDEX graph_evidence_concept ON graph.evidence (concept, document_id) INCLUDE (flags);
  CREATE INDEX graph_evidence_document ON graph.evidence (document_id);
  CREATE INDEX graph_treats_object ON graph.treats (object, subject);
  CREATE INDEX graph_treats_document ON graph.treats (document_id);
  ALTER TABLE graph.evidence ADD FOREIGN KEY (document_id) REFERENCES graph.documents ON DELETE CASCADE;
  ALTER TABLE graph.treats ADD FOREIGN KEY (document_id) REFERENCES graph.documents ON DELETE CASCADE;
  CREATE MATERIALIZED VIEW graph.concept_names AS ${CONCEPT_NAMES};
  CREATE UNIQUE INDEX graph_concept_names_id_type ON graph.concept_names (id, type);
  ANALYZE graph.evidence, graph.treats;
  COMMENT ON SCHEMA graph IS '${SCHEMA_VERSION}';`;

const SCHEMA = `
  -- Serialize schema changes when two index jobs start together.
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
  -- The NORMALIZATION_VERSION of the row; rows from before it existed have the first.
  ALTER TABLE graph.documents ADD COLUMN IF NOT EXISTS normalized smallint NOT NULL DEFAULT 1;
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
  -- Keeps graph.evidence and graph.treats in step with every write to graph.documents.
  CREATE OR REPLACE FUNCTION graph.derive() RETURNS trigger LANGUAGE plpgsql AS $derive$
  BEGIN
    DELETE FROM graph.evidence WHERE document_id = NEW.document_id;
    DELETE FROM graph.treats WHERE document_id = NEW.document_id;
    ${evidenceRows("(SELECT NEW.*)")}
    RETURN NULL;
  END $derive$;
  CREATE OR REPLACE TRIGGER derive AFTER INSERT OR UPDATE OF entities, relations, mesh
  ON graph.documents FOR EACH ROW EXECUTE FUNCTION graph.derive();
  DO $$ BEGIN
    IF obj_description('graph'::regnamespace, 'pg_namespace') IS DISTINCT FROM '${SCHEMA_VERSION}' THEN
      ${DERIVED}
    END IF;
  END $$;
  -- Hide due retries and rows of an older normalization from the change detector, but keep any
  -- last good data searchable. A paper PubTator3 did not have waits for its retry either way.
  CREATE OR REPLACE VIEW graph.indexed_documents AS
    SELECT document_id, document_changed_at FROM graph.documents
    WHERE retry_at > now() AND (normalized = ${NORMALIZATION_VERSION} OR isfinite(retry_at));
`;

/** Creates the graph index on its first run, and builds what is derived again after a version change. */
export async function ensureGraphSchema(db: Queryable): Promise<void> {
  await db.query(SCHEMA);
}
