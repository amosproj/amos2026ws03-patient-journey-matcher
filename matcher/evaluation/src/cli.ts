import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { evaluate } from "./evaluate.ts";
import { loadGrades, mergeGrades } from "./judgments.ts";

// Only the fields the evaluation needs from a match_journey result.
const matchResultSchema = z.object({
  algorithm: z.string(),
  results: z.array(
    z.object({ rank: z.number().int().min(1), source_id: z.string() }),
  ),
});

const [runDir, ...judgmentFiles] = process.argv.slice(2);
if (runDir === undefined) {
  console.error("Usage: pnpm evaluate <run-dir> [judgment-file...]");
  console.error("<run-dir> holds one match_journey result per point.");
  console.error(
    "[judgment-file...] defaults to judgments.json; several are merged,",
  );
  console.error("the first file that grades a source for a point counts.");
  process.exit(2);
}
const cwd = process.env.INIT_CWD ?? process.cwd();
const base = path.resolve(cwd, runDir);

const file = mergeGrades(
  await Promise.all(
    judgmentFiles.length === 0
      ? [loadGrades()]
      : judgmentFiles.map((name) => loadGrades(path.resolve(cwd, name))),
  ),
);
const run = new Map<string, string[]>();
for (const point of file.points) {
  const text = await readFile(
    path.join(base, `${point.id}.json`),
    "utf8",
  ).catch(() => undefined);
  if (text === undefined) continue;
  const result = matchResultSchema.parse(JSON.parse(text));
  run.set(
    point.id,
    result.results.toSorted((a, b) => a.rank - b.rank).map((r) => r.source_id),
  );
}

const report = evaluate(file, run);
const round = (value: number) => Math.round(value * 1000) / 1000;
console.table(
  report.points.map(({ point_id, ...scores }) => ({
    point_id,
    ...Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, round(value)]),
    ),
  })),
);
console.log(
  "Mean:",
  Object.fromEntries(
    Object.entries(report.mean).map(([key, value]) => [key, round(value)]),
  ),
);
if (report.missing.length > 0) {
  console.log("No result file, scored 0:", report.missing.join(", "));
}
for (const [pointId, sourceIds] of report.unjudged) {
  console.log(`Judge next for ${pointId}: ${sourceIds.join(", ")}`);
}
