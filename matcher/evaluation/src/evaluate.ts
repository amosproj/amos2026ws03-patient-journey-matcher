import type { JudgmentFile } from "./judgments.ts";
import { judgedAt, ndcgAt, offTargetAt, precisionAt } from "./metrics.ts";

// Ranked source_ids per evaluation point id, from one algorithm.
export type Run = ReadonlyMap<string, readonly string[]>;

export type PointScore = {
  point_id: string;
  ndcg_10: number;
  precision_5: number;
  off_target_10: number;
  judged_10: number;
};

// A point without results scores 0, so every algorithm is compared on all points.
export function evaluate(file: JudgmentFile, run: Run) {
  const unjudged = new Map<string, string[]>();
  const points: PointScore[] = file.points.map((point) => {
    const ranked = run.get(point.id) ?? [];
    const grades = new Map(
      point.judgments.map(({ source_id, grade }) => [source_id, grade]),
    );
    const open = ranked.slice(0, 10).filter((id) => !grades.has(id));
    if (open.length > 0) unjudged.set(point.id, open);
    return {
      point_id: point.id,
      ndcg_10: ndcgAt(10, ranked, grades),
      precision_5: precisionAt(5, ranked, grades),
      off_target_10: offTargetAt(10, ranked, grades),
      judged_10: judgedAt(10, ranked, grades),
    };
  });
  const mean = (key: Exclude<keyof PointScore, "point_id">) =>
    points.reduce((sum, point) => sum + point[key], 0) / points.length;
  return {
    points,
    mean: {
      ndcg_10: mean("ndcg_10"),
      precision_5: mean("precision_5"),
      off_target_10: mean("off_target_10"),
      judged_10: mean("judged_10"),
    },
    missing: file.points.filter(({ id }) => !run.has(id)).map(({ id }) => id),
    unjudged,
  };
}
