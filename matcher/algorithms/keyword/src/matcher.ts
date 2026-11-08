import { type Hit, type Matcher, reciprocalRankFusion } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { eventTerms } from "./terms.ts";

const FILTERS = `(d.expires_at IS NULL OR d.expires_at > now())
  AND ($2::text[] IS NULL OR d.content_type = ANY ($2::text[]))`;
// Each index gives its best candidates, in its order; only the BM25 index scan is fast for full
// texts, as scoring one outside of it costs milliseconds.
const CANDIDATES = 100;
const METADATA_RANKING = `
  SELECT k.document_id AS id FROM keyword.documents AS k
  JOIN public.documents AS d ON d.id = k.document_id
  WHERE ${FILTERS}
  ORDER BY k.content <@> to_bm25query($1, 'keyword.documents_content_idx')
  LIMIT ${CANDIDATES}`;
const FULL_TEXT_RANKING = `
  SELECT f.document_id AS id FROM keyword.full_texts AS f
  JOIN public.documents AS d ON d.id = f.document_id
  WHERE f.status = 'indexed' AND ${FILTERS}
  ORDER BY f.terms <@> to_bm25query($1, 'keyword.full_texts_terms_idx')
  LIMIT ${CANDIDATES}`;
const CANDIDATE_DETAILS = `
  SELECT k.document_id AS id, f.document_id IS NOT NULL AS has_full_text,
         ARRAY(SELECT term FROM unnest($2::text[]) AS term
               WHERE metadata @@ plainto_tsquery('english', term)
                  OR coalesce(f.lexemes @@ plainto_tsquery('english', term), false))
           AS matched_terms
  FROM keyword.documents AS k
  LEFT JOIN keyword.full_texts AS f ON f.document_id = k.document_id AND f.status = 'indexed'
  CROSS JOIN LATERAL to_tsvector('english', k.content) AS metadata
  WHERE k.document_id = ANY ($1::text[])`;
// Full texts count as much as the metadata: on four journeys of #11 this ranked the papers on
// the current situation higher than half the weight did. To be tuned in #11.
const FULL_TEXT_WEIGHT = 1;

/**
 * BM25 on the words a document shares with the journey, in its metadata and its full text; the
 * two rankings merged by rank fusion.
 */
export function createKeywordMatcher(db: Queryable): Matcher {
  return {
    async match({ focus, context }, { limit, contentTypes }): Promise<Hit[]> {
      const focusTerms = eventTerms(focus);
      const contextTerms = context.flatMap(eventTerms);
      const terms = [...new Set([...focusTerms, ...contextTerms])];
      if (terms.length === 0) return [];
      // BM25 counts repeated query terms, so the focus terms go in three times: with two, the
      // many terms of older events outweighed them on the synthetic journeys. To be tuned in #11.
      const text = [
        ...focusTerms,
        ...focusTerms,
        ...focusTerms,
        ...new Set(contextTerms),
      ].join(" ");
      const parameters = [text, contentTypes ?? null];
      const [metadata, fullTexts] = await Promise.all([
        ranks(db, METADATA_RANKING, parameters),
        ranks(db, FULL_TEXT_RANKING, parameters),
      ]);
      const candidates = [
        ...new Set([...metadata.keys(), ...fullTexts.keys()]),
      ];
      if (candidates.length === 0) return [];
      const { rows } = await db.query<{
        id: string;
        has_full_text: boolean;
        matched_terms: string[];
      }>(CANDIDATE_DETAILS, [candidates, terms]);
      // Every hit shows a term it matched. This also drops the documents without any, which an
      // index scores 0 when Postgres scores every row instead of using its index (small tables).
      const matched = rows.filter((row) => row.matched_terms.length > 0);
      // Without a full text, the metadata rank stands in for it: no penalty for lacking one.
      const fullTextRanks = new Map<string, number>();
      for (const row of matched) {
        const rank = row.has_full_text
          ? fullTexts.get(row.id)
          : metadata.get(row.id);
        if (rank !== undefined) fullTextRanks.set(row.id, rank);
      }
      const fused = reciprocalRankFusion([
        { ranks: metadata, weight: 1 },
        { ranks: fullTextRanks, weight: FULL_TEXT_WEIGHT },
      ]);
      const hits = matched
        .map((row) => ({
          documentId: row.id,
          score: fused.get(row.id) ?? 0,
          matchedTerms: row.matched_terms,
        }))
        .sort(
          (a, b) => b.score - a.score || (a.documentId < b.documentId ? -1 : 1),
        )
        .slice(0, limit);
      const best = hits[0]?.score ?? 1;
      return hits.map((hit) => ({ ...hit, score: hit.score / best }));
    },
  };
}

/** The rank of each document a query returns, from 1. */
async function ranks(
  db: Queryable,
  sql: string,
  parameters: unknown[],
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ id: string }>(sql, parameters);
  return new Map(rows.map(({ id }, index) => [id, index + 1]));
}
