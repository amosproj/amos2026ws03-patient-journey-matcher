import type { JourneyEvent } from "@matcher/core";

// German journey words: English translations and words to skip.
import german from "../data/german-terms.json" with { type: "json" };

// A Map, not the object: a plain object also answers "constructor".
const ENGLISH = new Map<string, string>(Object.entries(german.translations));
const SKIP = new Set(german.skip);

/** The words of the English terms, e.g. "radical" and "prostatectomy". */
export const ENGLISH_WORDS = [...ENGLISH.values()].flatMap((term) =>
  term.split(" "),
);

/** The English search terms of an event: its label, text parameters and the names of true flags. */
export function eventTerms(
  event: Pick<JourneyEvent, "label" | "parameters">,
): string[] {
  const texts = [event.label];
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    if (value === true) texts.push(key);
    for (const item of [value].flat()) {
      if (typeof item === "string") texts.push(item);
    }
  }
  const words =
    texts
      .join(" ")
      .replaceAll("_", " ")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = words
    .filter((word) => /\p{L}/u.test(word) && !SKIP.has(word))
    .map((word) => ENGLISH.get(word) ?? word);
  return [...new Set(terms)];
}
