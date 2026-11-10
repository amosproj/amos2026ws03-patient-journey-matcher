import { expect, test } from "vitest";
import { evaluate } from "./evaluate.ts";
import { type JudgmentFile, loadJudgments } from "./judgments.ts";

const point = {
  journey: "Patient-5",
  as_of: "2028-12-25",
  focus_event_id: "e15",
  focus: "Biochemical recurrence",
  context: [],
};

const file: JudgmentFile = {
  version: 1,
  points: [
    {
      ...point,
      id: "one",
      judgments: [
        { source_id: "pubmed:1", grade: 3 },
        { source_id: "pubmed:2", grade: 0 },
      ],
    },
    { ...point, id: "two", judgments: [{ source_id: "pubmed:3", grade: 2 }] },
  ],
};

test("a point without results scores 0 and is listed as missing", () => {
  const report = evaluate(file, new Map([["one", ["pubmed:1"]]]));
  expect(report.points[1]).toMatchObject({ point_id: "two", ndcg_10: 0 });
  expect(report.mean.ndcg_10).toBe(0.5);
  expect(report.missing).toEqual(["two"]);
});

test("unjudged results in the top 10 are listed for the next round", () => {
  const report = evaluate(
    file,
    new Map([
      ["one", ["pubmed:9", "pubmed:1"]],
      ["two", ["pubmed:3"]],
    ]),
  );
  expect(report.unjudged).toEqual(new Map([["one", ["pubmed:9"]]]));
});

test("judgments.json is valid and has no duplicates", async () => {
  const { points } = await loadJudgments();
  expect(new Set(points.map(({ id }) => id)).size).toBe(points.length);
  for (const { judgments } of points) {
    const ids = judgments.map(({ source_id }) => source_id);
    expect(new Set(ids).size).toBe(ids.length);
  }
});
