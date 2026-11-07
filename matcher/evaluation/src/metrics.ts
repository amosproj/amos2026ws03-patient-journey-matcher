// Grades by source_id for one evaluation point. Unjudged results count as 0
// in nDCG and precision, so judgedAt shows how far a score can be trusted.
export type Grades = ReadonlyMap<string, number>;

const gain = (grade: number) => 2 ** grade - 1;

function dcg(grades: readonly number[]) {
  return grades.reduce(
    (sum, grade, index) => sum + gain(grade) / Math.log2(index + 2),
    0,
  );
}

export function ndcgAt(k: number, ranked: readonly string[], grades: Grades) {
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, k));
  if (ideal === 0) return 0;
  return dcg(ranked.slice(0, k).map((id) => grades.get(id) ?? 0)) / ideal;
}

export function precisionAt(
  k: number,
  ranked: readonly string[],
  grades: Grades,
) {
  const relevant = ranked
    .slice(0, k)
    .filter((id) => (grades.get(id) ?? 0) >= 2);
  return relevant.length / k;
}

export function offTargetAt(
  k: number,
  ranked: readonly string[],
  grades: Grades,
) {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((id) => grades.get(id) === 0).length / top.length;
}

export function judgedAt(k: number, ranked: readonly string[], grades: Grades) {
  const top = ranked.slice(0, k);
  if (top.length === 0) return 1;
  return top.filter((id) => grades.has(id)).length / top.length;
}
