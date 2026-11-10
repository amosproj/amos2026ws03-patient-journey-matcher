/** Rank fusion's constant from its paper: higher values flatten the lead of the top ranks. */
export const RANK_CONSTANT = 60;

export interface Ranking {
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
