import { expect, test } from "vitest";
import { reciprocalRankFusion } from "./fusion.ts";

test("adds each ranking's weight over 60 plus the rank of a document", () => {
  const fused = reciprocalRankFusion([
    {
      ranks: new Map([
        ["a", 1],
        ["b", 2],
      ]),
      weight: 1,
    },
    {
      ranks: new Map([
        ["b", 1],
        ["c", 2],
      ]),
      weight: 0.5,
    },
  ]);

  expect(fused.get("a")).toBeCloseTo(1 / 61);
  expect(fused.get("b")).toBeCloseTo(1 / 62 + 0.5 / 61);
  expect(fused.get("c")).toBeCloseTo(0.5 / 62);
});
