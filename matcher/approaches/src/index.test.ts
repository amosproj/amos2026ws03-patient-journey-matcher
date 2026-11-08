import type { Approach } from "@matcher/core";
import { expect, test } from "vitest";
import { selectApproaches } from "./index.ts";

function approach(name: string): Approach {
  return {
    name,
    indexer: { index: async () => {} },
    matcher: { match: async () => [] },
  };
}

const approaches = ["keyword", "ai_summary", "graph"].map(approach);

test("selects the named approaches in the order of the list", () => {
  const names = selectApproaches(approaches, ["graph", "keyword"]).map(
    ({ name }) => name,
  );

  expect(names).toEqual(["keyword", "graph"]);
});

test("selects all approaches for no names", () => {
  expect(selectApproaches(approaches, [])).toEqual(approaches);
});

test("refuses an unknown name and lists the known ones", () => {
  expect(() => selectApproaches(approaches, ["bm25"])).toThrow(
    "Unknown approach bm25; choose from keyword, ai_summary, graph",
  );
});
