import {
  type Hit,
  type Matcher,
  type MatchOptions,
  RANK_CONSTANT,
  reciprocalRankFusion,
} from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { eventTerms, eventWords } from "./terms.ts";

// The ranking constants. `tuning` in the match options sets other values by name, from `min`
// to `max`, for experiments (debug UI, #11).
const SETTINGS = {
  // BM25 counts repeated query terms, so the focus terms go in three times: with two, the
  // many terms of older events outweighed them on the synthetic journeys. To be tuned in #11.
  focusWeight: { value: 3, min: 1, max: 20, whole: true },
  // Full texts count as much as the metadata: on four journeys of #11 this ranked the papers on
  // the current situation higher than half the weight did. To be tuned in #11.
  fullTextWeight: { value: 1, min: 0, max: 10, whole: false },
  // Each index gives its best candidates, in its order; only the BM25 index scan is fast for full
  // texts, as scoring one outside of it costs milliseconds.
  candidates: { value: 100, min: 1, max: 1000, whole: true },
  rankConstant: { value: RANK_CONSTANT, min: 1, max: 1000, whole: false },
};
type Setting = keyof typeof SETTINGS;

const FILTERS = `(d.expires_at IS NULL OR d.expires_at > now())
  AND ($2::text[] IS NULL OR d.content_type = ANY ($2::text[]))`;
// `candidates` is a whole number that `settings` checked.
const metadataRanking = (candidates: number) => `
  SELECT k.document_id AS id FROM keyword.documents AS k
  JOIN public.documents AS d ON d.id = k.document_id
  WHERE ${FILTERS}
  ORDER BY k.content <@> to_bm25query($1, 'keyword.documents_content_idx')
  LIMIT ${candidates}`;
const fullTextRanking = (candidates: number) => `
  SELECT f.document_id AS id FROM keyword.full_texts AS f
  JOIN public.documents AS d ON d.id = f.document_id
  WHERE f.status = 'indexed' AND ${FILTERS}
  ORDER BY f.terms <@> to_bm25query($1, 'keyword.full_texts_terms_idx')
  LIMIT ${candidates}`;
// MATERIALIZED: terms parsed once, not per candidate
const CANDIDATE_DETAILS = `
  WITH terms AS MATERIALIZED (
    SELECT term, plainto_tsquery('english', term) AS query FROM unnest($2::text[]) AS term)
  SELECT k.document_id AS id, f.document_id IS NOT NULL AS has_full_text,
         ARRAY(SELECT term FROM terms WHERE metadata @@ query) AS metadata_terms,
         ARRAY(SELECT term FROM terms WHERE f.lexemes @@ query) AS full_text_terms
  FROM keyword.documents AS k
  LEFT JOIN keyword.full_texts AS f ON f.document_id = k.document_id AND f.status = 'indexed'
  CROSS JOIN LATERAL to_tsvector('english', k.content) AS metadata
  WHERE k.document_id = ANY ($1::text[])`;

/**
 * BM25 on the words a document shares with the journey, in its metadata and its full text; the
 * two rankings merged by rank fusion. Trace steps: `settings`, `terms`, `rankings`, `candidates`.
 */
export function createKeywordMatcher(db: Queryable): Matcher {
  return {
    async match(
      { focus, context },
      { limit, contentTypes, tuning, trace },
    ): Promise<Hit[]> {
      const { focusWeight, fullTextWeight, candidates, rankConstant } =
        settings(tuning, trace);
      const focusTerms = eventTerms(focus);
      const contextTerms = [...new Set(context.flatMap(eventTerms))];
      const terms = [...new Set([...focusTerms, ...contextTerms])];
      // The focus terms repeated: their weight (see SETTINGS).
      const text = [
        ...Array.from({ length: focusWeight }, () => focusTerms).flat(),
        ...contextTerms,
      ].join(" ");
      trace?.("terms", {
        focus: focusTerms,
        context: contextTerms,
        query: text,
        events: [focus, ...context].map((event) => ({
          id: event.id,
          words: eventWords(event),
        })),
      });
      if (terms.length === 0) return [];
      const parameters = [text, contentTypes ?? null];
      const [metadata, fullTexts] = await Promise.all([
        ranks(db, metadataRanking(candidates), parameters),
        ranks(db, fullTextRanking(candidates), parameters),
      ]);
      trace?.("rankings", {
        metadata: [...metadata.keys()],
        fullTexts: [...fullTexts.keys()],
      });
      const ids = [...new Set([...metadata.keys(), ...fullTexts.keys()])];
      if (ids.length === 0) return [];
      const { rows } = await db.query<{
        id: string;
        has_full_text: boolean;
        metadata_terms: string[];
        full_text_terms: string[];
      }>(CANDIDATE_DETAILS, [ids, terms]);
      const details = rows.map((row) => ({
        ...row,
        matchedTerms: terms.filter(
          (term) =>
            row.metadata_terms.includes(term) ||
            row.full_text_terms.includes(term),
        ),
      }));
      // Every hit shows a term it matched. This also drops the documents without any, which an
      // index scores 0 when Postgres scores every row instead of using its index (small tables).
      const matched = details.filter((row) => row.matchedTerms.length > 0);
      // Without a full text, the metadata rank stands in for it: no penalty for lacking one.
      const fullTextRanks = new Map<string, number>();
      for (const row of matched) {
        const rank = row.has_full_text
          ? fullTexts.get(row.id)
          : metadata.get(row.id);
        if (rank !== undefined) fullTextRanks.set(row.id, rank);
      }
      const fused = reciprocalRankFusion(
        [
          { ranks: metadata, weight: 1 },
          { ranks: fullTextRanks, weight: fullTextWeight },
        ],
        rankConstant,
      );
      const ranked = matched
        .map((row) => ({ ...row, score: fused.get(row.id) ?? 0 }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      trace?.(
        "candidates",
        // The ranked ones, best first, then those dropped for matching no term.
        [...ranked, ...details.filter((row) => !matched.includes(row))].map(
          (row) => ({
            id: row.id,
            hasFullText: row.has_full_text,
            metadataRank: metadata.get(row.id) ?? null,
            fullTextRank: fullTexts.get(row.id) ?? null,
            metadataTerms: row.metadata_terms,
            fullTextTerms: row.full_text_terms,
            score: "score" in row ? row.score : null,
          }),
        ),
      );
      // A full-text weight of 0 can leave every score at 0.
      const best = ranked[0]?.score || 1;
      return ranked.slice(0, limit).map((row) => ({
        documentId: row.id,
        score: row.score / best,
        matchedTerms: row.matchedTerms,
      }));
    },
  };
}

/** The ranking constants with the values of `tuning`; traces them and refuses values out of range. */
function settings(
  tuning: MatchOptions["tuning"] = {},
  trace: MatchOptions["trace"],
): Record<Setting, number> {
  const names = Object.keys(SETTINGS) as Setting[];
  const values = Object.fromEntries(
    names.map((name) => [name, tuning[name] ?? SETTINGS[name].value]),
  ) as Record<Setting, number>;
  trace?.(
    "settings",
    names.map((name) => ({
      name,
      ...SETTINGS[name],
      default: SETTINGS[name].value,
      value: values[name],
    })),
  );
  for (const name of names) {
    const { min, max, whole } = SETTINGS[name];
    const value = values[name];
    if (
      !(value >= min && value <= max && (!whole || Number.isInteger(value)))
    ) {
      throw new RangeError(
        `${name} must be a ${whole ? "whole " : ""}number from ${min} to ${max}, not ${value}`,
      );
    }
  }
  return values;
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
