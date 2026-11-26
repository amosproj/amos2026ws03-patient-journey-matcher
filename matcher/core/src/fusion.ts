import type { Hit, Matcher } from "./contracts.ts";

/** Rank fusion's constant from its paper: higher values flatten the lead of the top ranks. */
export const RANK_CONSTANT = 60;

interface Ranking {
  /** Rank per document, from 1; documents left out get nothing from this ranking. */
  ranks: ReadonlyMap<string, number>;
  weight: number;
}

/**
 * Reciprocal rank fusion (Cormack et al., SIGIR 2009): merges rankings whose scores cannot be
 * compared, such as two indexes or two approaches. Each ranking adds
 * weight / (rankConstant + rank).
 */
export function reciprocalRankFusion(
  rankings: readonly Ranking[],
  rankConstant = RANK_CONSTANT,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const { ranks, weight } of rankings) {
    for (const [id, rank] of ranks) {
      fused.set(id, (fused.get(id) ?? 0) + weight / (rankConstant + rank));
    }
  }
  return fused;
}

// Hits of each part that count; the offline comparison of graph and keyword fused 30 of each.
const FUSION_DEPTH = 30;

/**
 * A matcher that merges the rankings of other matchers by reciprocal rank fusion, with equal
 * weights. A part that fails is left out and reported to `partFailed`; only when all fail does it
 * fail.
 */
export function createFusedMatcher(
  parts: readonly { name: string; matcher: Matcher }[],
): Matcher {
  return {
    async match(state, options) {
      const { limit, trace, partFailed } = options;
      const depth = Math.max(limit, FUSION_DEPTH);
      const answers = await Promise.allSettled(
        parts.map(({ name, matcher }) =>
          matcher.match(state, {
            ...options,
            limit: depth,
            trace: trace && ((step, data) => trace(`${name}.${step}`, data)),
          }),
        ),
      );
      const failed = answers.flatMap((answer, index) =>
        answer.status === "rejected"
          ? [{ ...parts[index], error: answer.reason }]
          : [],
      );
      if (failed.length === parts.length) throw failed[0]?.error;
      for (const { name, error } of failed) partFailed?.(name, error);
      const rankings = answers.map((answer, index) => ({
        name: parts[index].name,
        hits: answer.status === "fulfilled" ? answer.value : [],
      }));
      const fused = [
        ...reciprocalRankFusion(
          rankings.map(({ hits }) => ({
            ranks: new Map(
              hits.map((hit, index) => [hit.documentId, index + 1]),
            ),
            weight: 1,
          })),
        ),
      ]
        .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))
        .slice(0, limit);
      const ranks = (documentId: string) =>
        Object.fromEntries(
          rankings.flatMap(({ name, hits }) => {
            const index = hits.findIndex(
              (hit) => hit.documentId === documentId,
            );
            return index < 0 ? [] : [[name, index + 1]];
          }),
        );
      trace?.("fusion", {
        rankConstant: RANK_CONSTANT,
        depth,
        parts: rankings.map(({ name, hits }) => ({
          name,
          hits: hits.length,
          failed: failed.some((part) => part.name === name),
        })),
        fused: fused.map(([documentId, score]) => ({
          documentId,
          score,
          ranks: ranks(documentId),
        })),
      });
      const best = fused[0]?.[1] ?? 1;
      return fused.map(([documentId, score]) => {
        const found = rankings.flatMap(({ hits }) =>
          hits.filter((hit) => hit.documentId === documentId),
        );
        const terms = [
          ...new Set(found.flatMap((hit) => hit.matchedTerms ?? [])),
        ];
        return {
          documentId,
          score: score / best,
          ...(terms.length > 0 && { matchedTerms: terms }),
          explanation: found.find((hit) => hit.explanation)?.explanation,
        } satisfies Hit;
      });
    },
  };
}
