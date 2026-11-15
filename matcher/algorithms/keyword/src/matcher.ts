import {
  type Hit,
  type JourneyEvent,
  type Matcher,
  type MatchOptions,
  RANK_CONSTANT,
  reciprocalRankFusion,
} from "@matcher/core";
import type { Queryable } from "@matcher/db";
import { eventTerms, eventWords, isGeneric } from "./terms.ts";

// ranking constants; `tuning` sets others within min..max (debug UI)
const SETTINGS = {
  // BM25 counts repeated query terms: this alone puts focus hits first; 12 and 20 ranked best (#58)
  focusWeight: { value: 12, min: 1, max: 20, whole: true },
  // weightiest first; none ranked worse, 20 no better (#58)
  contextTerms: { value: 10, min: 0, max: 100, whole: true },
  // half or twice the weight ranked as well (#58)
  fullTextWeight: { value: 1, min: 0, max: 10, whole: false },
  // per index: scoring a full text outside the BM25 index scan costs milliseconds
  candidates: { value: 100, min: 1, max: 1000, whole: true },
  rankConstant: { value: RANK_CONSTANT, min: 1, max: 1000, whole: false },
};
type Setting = keyof typeof SETTINGS;

const FILTERS = `(d.expires_at IS NULL OR d.expires_at > now())
  AND ($2::text[] IS NULL OR d.content_type = ANY ($2::text[]))`;
// pg_textsearch's BM25 score, negated: best first
const METADATA_BM25 = `k.content <@> to_bm25query($1, 'keyword.documents_content_idx')`;
const FULL_TEXT_BM25 = `f.terms <@> to_bm25query($1, 'keyword.full_texts_terms_idx')`;
// `candidates`: whole number checked by `settings`; `scored`: trace only, ~2 ms per full text
const metadataRanking = (candidates: number, scored: boolean) => `
  SELECT k.document_id AS id${scored ? `, ${METADATA_BM25} AS score` : ""}
  FROM keyword.documents AS k
  JOIN public.documents AS d ON d.id = k.document_id
  WHERE ${FILTERS}
  ORDER BY ${METADATA_BM25}
  LIMIT ${candidates}`;
const fullTextRanking = (candidates: number, scored: boolean) => `
  SELECT f.document_id AS id${scored ? `, ${FULL_TEXT_BM25} AS score` : ""}
  FROM keyword.full_texts AS f
  JOIN public.documents AS d ON d.id = f.document_id
  WHERE f.status = 'indexed' AND ${FILTERS}
  ORDER BY ${FULL_TEXT_BM25}
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

/** BM25 on metadata and full texts, merged by rank fusion. Traces `settings`, `terms`, `rankings`, `candidates`. */
export function createKeywordMatcher(db: Queryable): Matcher {
  return {
    async match(
      { focus, context },
      { limit, contentTypes, tuning, trace },
    ): Promise<Hit[]> {
      const {
        focusWeight,
        fullTextWeight,
        candidates,
        rankConstant,
        ...limits
      } = settings(tuning, trace);
      const focusTerms = eventTerms(focus).filter((term) => !isGeneric(term));
      // generic terms: once, focus only ("initial", "follow up")
      const genericTerms = eventTerms(focus).filter(isGeneric);
      const contextTerms = weightiestTerms(context, focusTerms).slice(
        0,
        limits.contextTerms,
      );
      const terms = [...focusTerms, ...genericTerms, ...contextTerms];
      // repeated focus terms = their weight
      const text = [
        ...Array.from({ length: focusWeight }, () => focusTerms).flat(),
        ...genericTerms,
        ...contextTerms,
      ].join(" ");
      trace?.("terms", {
        focus: focusTerms,
        generic: genericTerms,
        context: contextTerms,
        query: text,
        events: [focus, ...context].map((event) => ({
          id: event.id,
          words: eventWords(event),
        })),
      });
      // generic terms alone say nothing about the patient
      if (focusTerms.length + contextTerms.length === 0) return [];
      const parameters = [text, contentTypes ?? null];
      const scored = trace !== undefined;
      const [
        { ranks: metadata, bm25: metadataBm25 },
        { ranks: fullTexts, bm25: fullTextBm25 },
      ] = await Promise.all([
        ranks(db, metadataRanking(candidates, scored), parameters),
        ranks(db, fullTextRanking(candidates, scored), parameters),
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
      // a hit needs a medical term; also drops the 0-score rows of a scan without the index
      const matched = details.filter((row) =>
        row.matchedTerms.some((term) => !isGeneric(term)),
      );
      // an index counts only where it finds a term
      const byId = new Map(details.map((row) => [row.id, row]));
      const withTerms = (
        ranks: Map<string, number>,
        terms: "metadata_terms" | "full_text_terms",
      ) => new Map([...ranks].filter(([id]) => byId.get(id)?.[terms].length));
      const metadataRanks = withTerms(metadata, "metadata_terms");
      const rankings = [
        { ranks: metadataRanks, weight: 1 },
        {
          // no full text: the metadata rank stands in, else these rank below all that have one (#58)
          ranks: new Map([
            ...withTerms(fullTexts, "full_text_terms"),
            ...[...metadataRanks].filter(
              ([id]) => !byId.get(id)?.has_full_text,
            ),
          ]),
          weight: fullTextWeight,
        },
      ];
      // no title rule: it buried the metadata index's best hit in 39 of 129 calls (#58)
      const fused = reciprocalRankFusion(rankings, rankConstant);
      const ranked = matched
        .map((row) => ({ ...row, score: fused.get(row.id) ?? 0 }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      if (trace) {
        // what each ranking adds to `score`
        const [metadataScores, fullTextScores] = rankings.map((ranking) =>
          reciprocalRankFusion([ranking], rankConstant),
        );
        trace(
          "candidates",
          // ranked first, then those dropped for matching no term
          [...ranked, ...details.filter((row) => !matched.includes(row))].map(
            (row) => {
              const score = "score" in row ? row.score : null;
              return {
                id: row.id,
                hasFullText: row.has_full_text,
                metadataRank: metadata.get(row.id) ?? null,
                fullTextRank: fullTexts.get(row.id) ?? null,
                metadataTerms: row.metadata_terms,
                fullTextTerms: row.full_text_terms,
                metadataBm25: metadataBm25.get(row.id) ?? null,
                fullTextBm25: fullTextBm25.get(row.id) ?? null,
                metadataScore:
                  score === null ? null : (metadataScores?.get(row.id) ?? 0),
                fullTextScore:
                  score === null ? null : (fullTextScores?.get(row.id) ?? 0),
                score,
              };
            },
          ),
        );
      }
      // a full-text weight of 0 leaves every score at 0
      const best = ranked[0]?.score || 1;
      return ranked.slice(0, limit).map((row) => ({
        documentId: row.id,
        score: row.score / best,
        matchedTerms: row.matchedTerms,
      }));
    },
  };
}

/** Medical terms of the older events, without the focus's: named by most events first, then most recent. */
function weightiestTerms(
  context: readonly JourneyEvent[],
  focusTerms: readonly string[],
): string[] {
  // newest first; on one day, the one listed last
  const newestFirst = context
    .toReversed()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const events = new Map<string, number>();
  for (const event of newestFirst) {
    for (const term of eventTerms(event)) {
      if (isGeneric(term) || focusTerms.includes(term)) continue;
      events.set(term, (events.get(term) ?? 0) + 1);
    }
  }
  // stable sort: ties keep the order of the newest events
  return [...events].sort((a, b) => b[1] - a[1]).map(([term]) => term);
}

/** The constants with `tuning` applied; traced, and refused when out of range. */
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

/** The rank of each document a query returns, from 1, and its BM25 score if the query selects it. */
async function ranks(
  db: Queryable,
  sql: string,
  parameters: unknown[],
): Promise<{ ranks: Map<string, number>; bm25: Map<string, number> }> {
  const { rows } = await db.query<{ id: string; score?: number }>(
    sql,
    parameters,
  );
  return {
    ranks: new Map(rows.map(({ id }, index) => [id, index + 1])),
    bm25: new Map(
      rows.flatMap(({ id, score }) =>
        score === undefined ? [] : [[id, -score] as const],
      ),
    ),
  };
}
