// Run against an indexed database with make benchmark-graph [BENCH_SET=sample].
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApproaches } from "../matcher/approaches/src/registry.ts";
import { reciprocalRankFusion } from "../matcher/core/src/fusion.ts";
import { createDocumentStore, createPool } from "../matcher/db/src/index.ts";
import { createDownloader } from "../matcher/download/src/downloader.ts";
import { evaluate } from "../matcher/evaluation/src/evaluate.ts";
import {
  loadGrades,
  mergeGrades,
} from "../matcher/evaluation/src/judgments.ts";
import { matchJourneyInputSchema } from "../matcher/mcp-server/src/contract.ts";
import { createMatchService } from "../matcher/mcp-server/src/match.ts";

const split = process.argv[2] ?? "all";
if (!["sample", "holdout", "all"].includes(split)) {
  throw new Error("BENCH_SET must be sample, holdout or all");
}
const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const file = (name) =>
  path.join(root, "matcher/evaluation", name + "-llm-judgments.json");
const { points } = await readJson(file("keyword"));
const grades = mergeGrades(
  await Promise.all(["graph", "keyword"].map((name) => loadGrades(file(name)))),
);
const selected = grades.points.filter(
  ({ id }) => split === "all" || points[id].set === split,
);
const dir = path.join(root, "out/benchmark/runs");
await mkdir(dir, { recursive: true });
const session = await mkdtemp(path.join(dir, "comparison-"));
const pool = createPool();
const summary = [];
function summarize(algorithm, input, run, times) {
  const { mean, unjudged } = evaluate({ points: selected }, run);
  times.sort((a, b) => a - b);
  const percentile = (p) =>
    times.length ? Math.round(times[Math.ceil(p * times.length) - 1]) : null;
  return {
    algorithm,
    input,
    points: selected.length,
    empty: [...run.values()].filter((hits) => hits.length === 0).length,
    ...Object.fromEntries(
      Object.entries(mean).map(([metric, value]) => [
        metric,
        Number(value.toFixed(3)),
      ]),
    ),
    unjudged: [...unjudged.values()].flat().length,
    p50_ms: percentile(0.5),
    p95_ms: percentile(0.95),
  };
}

try {
  const service = createMatchService(
    createApproaches({ db: pool, downloader: createDownloader() }),
    createDocumentStore(pool),
  );
  for (const input of ["graph", "journey"]) {
    const algorithms = ["graph", "keyword", "rrf"];
    const runs = new Map();
    const times = new Map();
    for (const name of algorithms) {
      runs.set(name, new Map());
      times.set(name, []);
      await mkdir(path.join(session, name + "-" + input));
    }
    for (const { id } of selected) {
      const [, patient] = /^patient-(\d+)-/.exec(id);
      const data = await readJson(
        path.join(
          root,
          "patientdata",
          "Patient-" + patient,
          input === "graph" ? "graph.json" : "timeline.json",
        ),
      );
      const rankings = [];
      const save = async (name, answer) => {
        runs.get(name).set(
          id,
          answer.results.map(({ source_id }) => source_id),
        );
        await writeFile(
          path.join(session, name + "-" + input, id + ".json"),
          JSON.stringify(answer),
        );
      };
      for (const algorithm of ["graph", "keyword"]) {
        const request = matchJourneyInputSchema.parse({
          [input]: { ...data, as_of: points[id].as_of },
          algorithm,
          limit: 30,
        });
        const start = performance.now();
        const answer = await service.matchJourney(request);
        times.get(algorithm).push(performance.now() - start);
        if (answer.degraded)
          throw new Error(
            algorithm +
              "/" +
              input +
              " failed at " +
              id +
              ": " +
              answer.degraded_reason,
          );
        await save(algorithm, answer);
        rankings.push({
          ranks: new Map(
            answer.results.map((hit) => [hit.source_id, hit.rank]),
          ),
          weight: 1,
        });
      }
      // Offline comparator using the same patient input and two fixed depth-30 rankings.
      const fused = [...reciprocalRankFusion(rankings)].sort(
        ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
      );
      await save("rrf", {
        algorithm: "rrf",
        results: fused
          .slice(0, 30)
          .map(([source_id, score], i) => ({ source_id, score, rank: i + 1 })),
      });
    }
    for (const name of algorithms)
      summary.push(summarize(name, input, runs.get(name), times.get(name)));
  }
} finally {
  await pool.end();
}
console.table(summary);
await writeFile(
  path.join(session, "summary.json"),
  JSON.stringify({ split, summary }, null, 2) + "\n",
);
console.log(session);
