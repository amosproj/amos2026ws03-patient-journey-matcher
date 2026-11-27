import { expect, test } from "vitest";
import { nameIndex, phraseLookup } from "./names.ts";

test("names under 4 characters and names of two IDs are left out", () => {
  const index = nameIndex(
    [
      { id: "a", names: ["PSA", "Tumor"] },
      { id: "b", names: ["tumor", "Krebs"] },
    ],
    (entry) => entry.names,
  );
  expect([...index.keys()]).toEqual(["tumor", "krebs"]);
  expect(index.get("tumor")).toBeNull();
  expect(index.get("krebs")?.id).toBe("b");
});

test("the longest name wins and takes its words", () => {
  const find = phraseLookup(
    new Map([
      ["herz", 1],
      ["herz insuffizienz", 2],
      ["insuffizienz", 3],
    ]),
  );
  expect(find(["chronische", "herz", "insuffizienz"])).toEqual([
    { value: 2, start: 1, end: 3 },
  ]);
  expect(find(["herz", "insuffizienz"], (value) => value !== 2)).toEqual([
    { value: 1, start: 0, end: 1 },
    { value: 3, start: 1, end: 2 },
  ]);
});
