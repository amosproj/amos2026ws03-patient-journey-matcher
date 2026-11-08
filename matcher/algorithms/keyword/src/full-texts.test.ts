import { expect, test } from "vitest";
import { keywords } from "./full-texts.ts";

test("keeps medical words and abbreviations, also when named once, without basic words or numbers", () => {
  const text =
    "The biopsy showed a Gleason 7 cancer, and the PSA was 4.2 before prostatectomy and 0.1 after.";

  expect(keywords(text)).toEqual([
    "biopsy",
    "cancer",
    "gleason",
    "prostatectomy",
    "psa",
  ]);
});

test("keeps the words of journey terms, in singular and plural", () => {
  expect(keywords("Follow the guidelines if the PSA rises.")).toEqual([
    "follow",
    "guidelines",
    "psa",
    "rises",
  ]);
});

test("reads no keywords from a text in another language", () => {
  const text =
    "Die Patienten mit Prostatakarzinom erhielten eine Strahlentherapie.";

  expect(keywords(text)).toBeUndefined();
});
