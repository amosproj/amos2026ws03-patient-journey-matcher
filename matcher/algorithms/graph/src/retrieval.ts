import type { Queryable } from "@matcher/db";
import type { GraphQuery } from "./query.ts";
import { isProstateCancer } from "./resolve.ts";
import {
  ENTITY,
  ENTITY_TITLE,
  MESH_MAJOR,
  MESH_MINOR,
  MESH_SUBSTANCE,
} from "./schema.ts";
import type { Values } from "./settings.ts";
import type { Triple } from "./types.ts";

/** A shortlisted paper with what the re-rank reads. */
export type Candidate = {
  document_id: string;
  diagnoses: string[];
  matched: Record<string, number>;
  idf: Record<string, number>;
  title: string;
  published: string | null;
  publication_types: string[];
  relations: Triple[];
  mesh: Record<string, number>;
  /** How many papers name a diagnosis, up to `pool`. */
  named?: number;
};

/** Explicit indications also take part in shortlisting, before the candidate limit. */
function treatmentPatterns(
  query: GraphQuery,
  diagnosisOnly: boolean,
): { subject: string | null; object: string }[] {
  if (diagnosisOnly)
    return [...query.diagnoses.keys()]
      .filter((id) => id !== query.histology?.conflicting)
      .map((object) => ({ subject: null, object }));
  return query.concepts.flatMap(({ ids, role, diagnoses, plannedFor }) =>
    (role === "drug" || role === "procedure") && diagnoses
      ? diagnoses
          .filter((id) => !plannedFor?.includes(id))
          .flatMap((object) => ids.map((subject) => ({ subject, object })))
      : [],
  );
}

// The papers that name a diagnosis (the newest `pool` of them), each concept counted once with
// its strongest evidence × its rarity among them × its weight, and the best `candidates` with
// the columns of the re-rank. graph.evidence holds one row per concept of a paper.
const SQL = `WITH q AS (
    SELECT grp, id, weight, scope FROM unnest($1::int[], $2::text[], $3::float8[]) AS terms(grp, id, weight)
    LEFT JOIN jsonb_to_recordset($11::jsonb) AS bindings(grp int, scope text[]) USING (grp)
  ),
  candidates AS MATERIALIZED (
    SELECT d.id AS document_id, d.published_at
    FROM public.documents d
    WHERE d.id IN (SELECT document_id FROM graph.evidence WHERE concept = ANY ($4::text[]))
      AND (d.expires_at IS NULL OR d.expires_at > now())
      AND ($5::text[] IS NULL OR d.content_type = ANY ($5::text[]))
    ORDER BY d.published_at DESC NULLS LAST, d.id
    LIMIT $16
  ),
  -- The diagnoses of each candidate and the other diagnoses a scoped concept needs.
  named AS MATERIALIZED (
    SELECT e.document_id, array_agg(e.concept) AS ids
    FROM graph.evidence e JOIN candidates c USING (document_id)
    WHERE e.concept = ANY ($4::text[] || ARRAY(SELECT unnest(scope) FROM q))
    GROUP BY e.document_id
  ),
  evidence AS (
    SELECT e.document_id, q.grp, max(q.weight) AS weight,
           max(greatest(
             CASE WHEN (e.flags & ${ENTITY_TITLE}) <> 0 THEN $6::float8
                  WHEN (e.flags & ${ENTITY}) <> 0 THEN $7::float8 ELSE 0 END,
             CASE WHEN (e.flags & ${MESH_MAJOR}) <> 0 THEN $8::float8
                  WHEN (e.flags & ${MESH_MINOR}) <> 0 THEN $9::float8
                  WHEN (e.flags & ${MESH_SUBSTANCE}) <> 0 THEN $10::float8 ELSE 0 END)) AS strength
    -- One index scan per concept; OFFSET 0 keeps the planner from scanning all of graph.evidence.
    FROM q
    CROSS JOIN LATERAL (
      SELECT document_id, flags FROM graph.evidence WHERE concept = q.id OFFSET 0
    ) AS e
    JOIN named n ON n.document_id = e.document_id
    -- A scoped concept counts only on a paper that also names one of its diagnoses.
    WHERE q.scope IS NULL OR n.ids && q.scope
    GROUP BY e.document_id, q.grp
  ),
  -- Rare among the papers on the diagnosis means telling: inverse frequency as in BM25.
  idf AS (
    SELECT grp, greatest(CASE WHEN grp = ANY ($12::int[]) THEN 1 ELSE 0 END,
           ln(1 + ((SELECT count(*) FROM candidates) - count(e.document_id) + 0.5) /
                  (count(e.document_id) + 0.5))) AS idf
    FROM (SELECT DISTINCT grp FROM q) AS requested
    LEFT JOIN evidence e USING (grp)
    GROUP BY grp
  ),
  scored AS (
    SELECT e.document_id, sum(e.weight * e.strength * i.idf) AS score,
           jsonb_object_agg(e.grp, e.strength) AS matched
    FROM evidence e JOIN idf i USING (grp)
    GROUP BY e.document_id
  ),
  -- The wide columns only for the shortlist; ties go to the newer paper.
  top AS (
    SELECT s.document_id, s.matched, c.published_at,
           s.score * (1 + CASE WHEN EXISTS (
             SELECT 1 FROM graph.treats t
             JOIN unnest($13::text[], $14::text[]) AS p(object, subject)
               ON t.object = p.object AND (p.subject IS NULL OR t.subject = p.subject)
             WHERE t.document_id = s.document_id) THEN $15::float8 ELSE 0 END) AS rank_score
    FROM scored s JOIN candidates c USING (document_id)
    ORDER BY rank_score DESC, c.published_at DESC NULLS LAST, s.document_id
    LIMIT $17
  )
  SELECT t.document_id, t.matched, (SELECT jsonb_object_agg(grp, idf) FROM idf) AS idf,
         d.title, d.published_at::text AS published, d.publication_types, g.relations, g.mesh,
         ARRAY(SELECT dx FROM unnest($4::text[]) dx WHERE dx = ANY (n.ids)) AS diagnoses,
         (SELECT count(*) FROM candidates)::int AS named
  FROM top t
  JOIN named n ON n.document_id = t.document_id
  JOIN graph.documents g ON g.document_id = t.document_id
  JOIN public.documents d ON d.id = t.document_id
  ORDER BY t.rank_score DESC, t.published_at DESC NULLS LAST, t.document_id`;

/** The best papers for the query by concept score, for the re-rank. */
export async function shortlist(
  db: Queryable,
  query: GraphQuery,
  values: Values,
  diagnosisOnly: boolean,
  contentTypes: readonly string[] | undefined,
): Promise<Candidate[]> {
  // One group per concept: its IDs count once, with the strongest evidence.
  const groups = query.concepts.flatMap((concept, index) =>
    concept.ids.map((id) => ({ index, id, weight: concept.weight })),
  );
  const bindings = query.concepts.flatMap((c, grp) =>
    c.diagnoses ? [{ grp, scope: c.diagnoses }] : [],
  );
  const patterns = treatmentPatterns(query, diagnosisOnly);
  const { rows } = await db.query<Candidate>(SQL, [
    groups.map(({ index }) => index),
    groups.map(({ id }) => id),
    groups.map(({ weight }) => weight),
    [...query.diagnoses.keys()],
    contentTypes ?? null,
    values.title,
    values.text,
    values.major,
    values.minor,
    values.substance,
    JSON.stringify(bindings),
    // An anchor shared by every candidate has near-zero IDF. Preserve the strength
    // of title/major-topic evidence when ranking a new clinical population; prostate
    // cancer keeps its calibrated IDF.
    query.concepts.flatMap((c, i) =>
      c.role === "diagnosis" && !c.ids.some(isProstateCancer) ? [i] : [],
    ),
    patterns.map(({ object }) => object),
    patterns.map(({ subject }) => subject),
    values.relation,
    values.pool,
    values.candidates,
  ]);
  return rows;
}
