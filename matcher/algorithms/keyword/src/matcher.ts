import type { Hit, Matcher } from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { eventTerms } from "./terms.ts";

const INDEX = "keyword.documents_content_idx";

/** BM25 on the words a document shares with the journey. */
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
      // Rows without any term score 0 and sort last, so dropping them after the LIMIT loses no hit.
      const { rows } = await db.query<{
        id: string;
        score: number;
        matched_terms: string[];
      }>(
        `SELECT hit.id, hit.score,
                ARRAY(SELECT term FROM unnest($2::text[]) AS term
                      WHERE to_tsvector('english', hit.content) @@ plainto_tsquery('english', term))
                  AS matched_terms
         FROM (
           SELECT k.document_id AS id, k.content,
                  -(k.content <@> to_bm25query($1, '${INDEX}')) AS score
           FROM keyword.documents AS k
           JOIN public.documents AS d ON d.id = k.document_id
           WHERE (d.expires_at IS NULL OR d.expires_at > now())
             AND ($3::text[] IS NULL OR d.content_type = ANY ($3::text[]))
           ORDER BY k.content <@> to_bm25query($1, '${INDEX}')
           LIMIT $4
         ) AS hit
         WHERE hit.score > 0
         ORDER BY hit.score DESC, hit.id`,
        [text, terms, contentTypes ?? null, limit],
      );
      const best = rows[0]?.score ?? 1;
      return rows.map((row) => ({
        documentId: row.id,
        score: row.score / best,
        matchedTerms: row.matched_terms,
      }));
    },
  };
}
