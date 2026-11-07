import { expect, test } from "vitest";
import { judgedAt, ndcgAt, offTargetAt, precisionAt } from "./metrics.ts";

const grades = new Map([
  ["a", 3],
  ["b", 2],
  ["c", 0],
]);

test("nDCG is 1 for the ideal order", () => {
  expect(ndcgAt(10, ["a", "b", "c"], grades)).toBe(1);
});

test("nDCG drops when the best source is ranked last", () => {
  const dcg = 0 + 3 / Math.log2(3) + 7 / Math.log2(4);
  const ideal = 7 + 3 / Math.log2(3);
  expect(ndcgAt(10, ["c", "b", "a"], grades)).toBeCloseTo(dcg / ideal);
});

test("unjudged sources count as 0", () => {
  expect(ndcgAt(10, ["x", "a", "b"], grades)).toBeLessThan(1);
  expect(judgedAt(10, ["x", "a", "b"], grades)).toBeCloseTo(2 / 3);
});

test("precision divides by k, so short lists score lower", () => {
  expect(precisionAt(5, ["a", "b"], grades)).toBe(0.4);
});

test("off target counts only sources judged 0", () => {
  expect(offTargetAt(10, ["c", "x", "a", "b"], grades)).toBe(0.25);
  expect(offTargetAt(10, [], grades)).toBe(0);
});
