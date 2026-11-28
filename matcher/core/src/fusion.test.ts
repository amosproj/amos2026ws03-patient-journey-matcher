import { expect, test, vi } from "vitest";
import type { Hit, JourneyState } from "./contracts.ts";
import { createFusedMatcher, reciprocalRankFusion } from "./fusion.ts";

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

test("uses another rank constant when given one", () => {
  const fused = reciprocalRankFusion(
    [{ ranks: new Map([["a", 1]]), weight: 2 }],
    10,
  );

  expect(fused.get("a")).toBeCloseTo(2 / 11);
});

const state: JourneyState = {
  focus: { id: "e1", type: "lab_test", label: "PSA", date: "2026-01-10" },
  context: [],
};
const part = (name: string, hits: Hit[] | Error) => ({
  name,
  matcher: {
    match: vi.fn(async () => {
      if (hits instanceof Error) throw hits;
      return hits;
    }),
  },
});

test("fuses the parts' rankings: a paper both rank comes first, terms merge, the trace has the ranks", async () => {
  const graph = part("graph", [
    { documentId: "a", score: 1, explanation: "Matches the diagnosis." },
    { documentId: "b", score: 0.5 },
  ]);
  const keyword = part("keyword", [
    { documentId: "b", score: 1, matchedTerms: ["psa"] },
    { documentId: "c", score: 0.9, matchedTerms: ["psa"] },
  ]);
  const steps: [string, unknown][] = [];
  const hits = await createFusedMatcher([graph, keyword]).match(state, {
    limit: 2,
    trace: (step, data) => steps.push([step, data]),
  });
  expect(hits).toEqual([
    {
      documentId: "b",
      score: 1,
      matchedTerms: ["psa"],
      explanation: undefined,
    },
    {
      documentId: "a",
      score: 1 / 61 / (1 / 62 + 1 / 61),
      explanation: "Matches the diagnosis.",
    },
  ]);
  // Each part ranks at least 30 for the fusion.
  expect(graph.matcher.match.mock.calls[0]).toMatchObject([
    state,
    { limit: 30 },
  ]);
  expect(steps.at(-1)).toEqual([
    "fusion",
    expect.objectContaining({
      fused: [
        expect.objectContaining({
          documentId: "b",
          ranks: { graph: 2, keyword: 1 },
        }),
        expect.objectContaining({ documentId: "a", ranks: { graph: 1 } }),
      ],
    }),
  ]);
});

test("answers without a failed part and reports it; fails only when every part fails", async () => {
  const partFailed = vi.fn();
  const down = new Error("down");
  const hits = await createFusedMatcher([
    part("graph", down),
    part("keyword", [{ documentId: "c", score: 1 }]),
  ]).match(state, { limit: 5, partFailed });
  expect(hits.map((hit) => hit.documentId)).toEqual(["c"]);
  expect(partFailed).toHaveBeenCalledWith("graph", down);
  await expect(
    createFusedMatcher([
      part("graph", down),
      part("keyword", new Error("also down")),
    ]).match(state, { limit: 5, partFailed }),
  ).rejects.toBe(down);
  expect(partFailed).toHaveBeenCalledTimes(1);
});
