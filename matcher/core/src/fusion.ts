/** Rank fusion's constant from its paper: higher values flatten the lead of the top ranks. */
const K = 60;

export interface Ranking {
  /** Rank per document, from 1; documents left out get nothing from this ranking. */
  ranks: ReadonlyMap<string, number>;
  weight: number;
}

/**
 * Reciprocal rank fusion (Cormack et al., SIGIR 2009): merges rankings whose scores cannot be
 * compared, such as two indexes or two approaches. Each ranking adds weight / (60 + rank).
 */
export function reciprocalRankFusion(
  rankings: readonly Ranking[],
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const { ranks, weight } of rankings) {
    for (const [id, rank] of ranks) {
      fused.set(id, (fused.get(id) ?? 0) + weight / (K + rank));
    }
  }
  return fused;
}
