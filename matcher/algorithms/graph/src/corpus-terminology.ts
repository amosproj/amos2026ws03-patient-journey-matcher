import type { Queryable } from "@matcher/db";
import {
  type Concept,
  createTerminology,
  type Terminology,
} from "./resolve.ts";

const cache = new WeakMap<
  Queryable,
  { expires: number; terms: Promise<Terminology> }
>();

/** Read the local annotations once per serving pool. A completed index run becomes visible within five minutes. */
export function loadCorpusTerminology(db: Queryable): Promise<Terminology> {
  const current = cache.get(db);
  if (current && current.expires > Date.now()) return current.terms;
  const terms = db
    .query<Concept>(`
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
    ORDER BY e.key, e.value->>'type'
  `)
    .then(({ rows }) => createTerminology(rows));
  cache.set(db, { expires: Date.now() + 300_000, terms });
  terms.catch(() => {
    if (cache.get(db)?.terms === terms) cache.delete(db);
  });
  return terms;
}
