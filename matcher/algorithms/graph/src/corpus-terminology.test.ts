import type { Queryable } from "@matcher/db";
import { afterEach, expect, test, vi } from "vitest";
import { loadCorpusTerminology } from "./corpus-terminology.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

test("an expired dictionary serves requests until the next one is loaded, also after a failed load", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const names = (name: string) => ({
    rows: [{ id: "mesh:C000001", type: "chemical", name, names: [name] }],
  });
  let loadNext: (value: unknown) => void = () => {};
  const query = vi
    .fn()
    .mockResolvedValueOnce(names("first name"))
    .mockRejectedValueOnce(new Error("down"))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        loadNext = resolve;
      }),
    );
  const db = { query } as unknown as Queryable;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const first = await loadCorpusTerminology(db);
  now.mockReturnValue(300_001);
  expect(await loadCorpusTerminology(db)).toBe(first);
  await settle();
  expect(await loadCorpusTerminology(db)).toBe(first);
  expect(await loadCorpusTerminology(db)).toBe(first);
  // The failed load and one pending: no load per request.
  expect(query).toHaveBeenCalledTimes(3);
  loadNext(names("second name"));
  await settle();
  expect(await loadCorpusTerminology(db)).not.toBe(first);
});
