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
const PAGE_SIZE = 128;

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
        const evidence =
          (treatment || exact ? 3 : 1) +
          1.5 * exact +
          known +
          0.5 * detail +
          (inTitle ? 4 : 0);
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
    async match(state, { contentTypes, limit }) {
      const query = patientQuery(state);
      if (!query.diagnoses.size) return [];
      const hits: Hit[] = [];
      const ids = [...query.diagnoses.keys()];
      const relations = query.conceptOnly ? "'[]'::jsonb" : "g.relations";
      let after: string | null = null;
      for (;;) {
        const { rows }: { rows: Candidate[] } = await db.query<Candidate>(
          `WITH page AS (
             SELECT g.document_id, g.entities, ${relations} AS relations
             FROM graph.documents g JOIN documents d ON d.id = g.document_id
             WHERE g.entities ?| $1::text[] AND (d.expires_at IS NULL OR d.expires_at > now())
               AND ($2::text[] IS NULL OR d.content_type = ANY($2::text[]))
               AND ($3::text IS NULL OR g.document_id > $3)
             ORDER BY g.document_id LIMIT $4
           )
           SELECT p.document_id, (
             SELECT jsonb_object_agg(id, p.entities -> id)
             FROM unnest($1::text[] || coalesce(links.ends, '{}'::text[])) AS e(id) WHERE p.entities ? id
           ) AS entities, links.relations
           FROM page p CROSS JOIN LATERAL (
             SELECT coalesce(jsonb_agg(to_jsonb(r) - 'position' ORDER BY r.position), '[]'::jsonb) AS relations,
                    array_agg(DISTINCT r.subject) || array_agg(DISTINCT r.object) AS ends
             FROM ROWS FROM (jsonb_to_recordset(p.relations) AS (subject text, predicate text, object text))
                  WITH ORDINALITY AS r(subject, predicate, object, position)
             WHERE r.subject = ANY($1::text[]) OR r.object = ANY($1::text[])
           ) links ORDER BY p.document_id`,
          [ids, contentTypes ?? null, after, PAGE_SIZE],
        );
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
        if (rows.length < PAGE_SIZE) break;
        after = rows[rows.length - 1].document_id;
      }
      return hits.map((hit) => ({ ...hit, score: hit.score / hits[0].score }));
    },
  };
}

function compareHits(a: Hit, b: Hit): number {
  return b.score - a.score || a.documentId.localeCompare(b.documentId);
}
