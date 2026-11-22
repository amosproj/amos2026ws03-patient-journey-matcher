import type { Hit, Matcher } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { type GraphQuery, patientQuery, tripleKey } from "./query.ts";
import type { Paper } from "./schema.ts";
import type { Triple } from "./types.ts";

type Candidate = {
  document_id: string;
  entities: Paper["entities"];
  relations: Triple[];
};

/** Score each diagnosis with its strongest paper relation. Repeated mentions never add weight. */
function scorePaper(query: GraphQuery, paper: Candidate): Hit | undefined {
  let best = 0;
  let diagnoses = 0;
  let explanation = "";
  const terms = new Set<string>();
  for (const [id, weight] of query.diagnoses) {
    const diagnosis = paper.entities[id];
    if (diagnosis?.type !== "disease") continue;
    diagnoses++;
    terms.add(diagnosis.name);
    let strongest = 0;
    let reason = `Matched the diagnosis ${diagnosis.name}.`;
    let connected = 0;
    if (!query.conceptOnly) {
      for (const relation of paper.relations) {
        const { subject, predicate, object } = relation;
        if (subject !== id && object !== id) continue;
        const otherId = subject === id ? object : subject;
        const other = paper.entities[otherId];
        const recorded = query.relations.get(tripleKey(relation));
        if (recorded === 0) continue;
        const exact = recorded ?? 0;
        const treatment =
          predicate === "treats" && object === id && other.type === "chemical";
        const detail = Math.max(
          query.details.get(otherId) ?? 0,
          query.diagnoses.get(otherId) ?? 0,
        );
        if (!exact && !treatment && (!detail || predicate === "related"))
          continue;
        const known = treatment ? (query.treatments.get(otherId) ?? 0) : 0;
        // shortcut: title co-mentions approximate study focus, use evidence passages when available.
        const inTitle = diagnosis.inTitle && other.inTitle;
        const strong = treatment || exact > 0;
        const evidence =
          (strong ? 3 : 1) +
          1.5 * exact +
          known +
          0.5 * detail +
          (inTitle ? (strong ? 4 : 1) : 0);
        terms.add(other.name);
        connected++;
        if (evidence <= strongest) continue;
        strongest = evidence;
        const link = `${paper.entities[subject].name} — ${predicate} → ${paper.entities[object].name}`;
        const context = exact
          ? "The patient graph records the same relationship."
          : known
            ? "The journey also records this treatment."
            : treatment
              ? "The paper links a treatment to the diagnosis."
              : "The paper links the diagnosis to another patient finding.";
        reason = `${context} PubTator3 annotated ${link}.${inTitle ? " Both concepts occur in the title." : ""}`;
      }
    }
    const score =
      weight *
      (1 +
        (diagnosis.inTitle ? 0.5 : 0) +
        strongest +
        Math.min(2, Math.max(0, connected - 1)) * 0.15);
    if (score > best) {
      best = score;
      explanation = reason;
    }
  }
  if (!best) return undefined;
  return {
    documentId: paper.document_id,
    score: best + 0.15 * Math.min(2, diagnoses - 1),
    matchedTerms: [...terms].sort(),
    explanation,
  };
}

export function createGraphMatcher(db: Queryable): Matcher {
  return {
    async match(state, { contentTypes, limit, trace }) {
      const query = patientQuery(state);
      trace?.("query", {
        cutoff: query.cutoff,
        focusDate: state.focus.date,
        conceptOnly: query.conceptOnly,
        diagnoses: Object.fromEntries(query.diagnoses),
        treatments: Object.fromEntries(query.treatments),
        details: Object.fromEntries(query.details),
        relations: Object.fromEntries(query.relations),
      });
      if (!query.diagnoses.size) return [];
      const diagnosisIds = [...query.diagnoses.keys()];
      const diagnosisWeights = [...query.diagnoses.values()];
      const contextIds = new Set<string>([
        ...query.details.keys(),
        ...diagnosisIds,
      ]);
      for (const key of query.relations.keys()) {
        const [subject, , object] = JSON.parse(key) as [string, string, string];
        contextIds.add(subject);
        contextIds.add(object);
      }
      const relations = query.conceptOnly ? "'[]'::jsonb" : "g.relations";
      // Single GIN scan: keep every candidate with a relevant link plus the top `limit`
      // diagnosis-only papers, avoiding repeated keyset re-sorting over an unordered GIN index.
      const { rows } = await db.query<Candidate>(
        `WITH scored AS MATERIALIZED (
           SELECT g.document_id, dx.score AS dx_score, links.relations, links.ends,
                  jsonb_array_length(links.relations) > 0 AS has_links
           FROM graph.documents g
           JOIN public.documents d ON d.id = g.document_id
           CROSS JOIN LATERAL (
             SELECT max(q.weight * (1 + CASE WHEN (g.entities -> q.id ->> 'inTitle')::boolean IS TRUE THEN 0.5 ELSE 0 END))
                    + 0.15 * least(2, count(*) - 1) AS score
             FROM unnest($1::text[], $2::float8[]) AS q(id, weight)
             WHERE g.entities -> q.id ->> 'type' = 'disease'
           ) dx
           CROSS JOIN LATERAL (
             SELECT coalesce(jsonb_agg(to_jsonb(r) - 'position' ORDER BY r.position), '[]'::jsonb) AS relations,
                    array_agg(DISTINCT r.subject) || array_agg(DISTINCT r.object) AS ends
             FROM ROWS FROM (jsonb_to_recordset(${relations}) AS (subject text, predicate text, object text))
                  WITH ORDINALITY AS r(subject, predicate, object, position)
             WHERE (r.subject = ANY($1::text[]) OR r.object = ANY($1::text[]))
               AND ((r.predicate = 'treats' AND r.object = ANY($1::text[]))
                    OR (r.predicate <> 'related'
                        AND (CASE WHEN r.subject = ANY($1::text[]) THEN r.object ELSE r.subject END) = ANY($3::text[])))
           ) links
           WHERE g.entities ?| $1::text[]
             AND (d.expires_at IS NULL OR d.expires_at > now())
             AND ($4::text[] IS NULL OR d.content_type = ANY($4::text[]))
             AND dx.score IS NOT NULL
         ),
         kept AS (
           SELECT document_id, relations, ends FROM scored WHERE has_links
           UNION ALL
           (SELECT document_id, relations, ends FROM scored WHERE NOT has_links
            ORDER BY dx_score DESC, document_id COLLATE "C" ASC LIMIT $5)
         )
         SELECT k.document_id, (
           SELECT jsonb_object_agg(id, g.entities -> id)
           FROM unnest($1::text[] || coalesce(k.ends, '{}'::text[])) AS e(id) WHERE g.entities ? id
         ) AS entities, k.relations
         FROM kept k
         JOIN graph.documents g ON g.document_id = k.document_id`,
        [
          diagnosisIds,
          diagnosisWeights,
          [...contextIds],
          contentTypes ?? null,
          limit,
        ],
      );
      const hits: Hit[] = [];
      for (const row of rows) {
        const hit = scorePaper(query, row);
        if (!hit) continue;
        // The MCP limit is at most 50. Start at the weakest retained hit.
        let rank = hits.length;
        while (rank > 0 && compareHits(hit, hits[rank - 1]) < 0) rank--;
        if (rank < limit) {
          hits.splice(rank, 0, hit);
          if (hits.length > limit) hits.pop();
        }
      }
      return hits.map((hit) => ({ ...hit, score: hit.score / hits[0].score }));
    },
  };
}

function compareHits(a: Hit, b: Hit): number {
  return (
    b.score - a.score ||
    (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0)
  );
}
