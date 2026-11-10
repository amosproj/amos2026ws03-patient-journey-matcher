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

/** A word of an event and the search term it becomes; `null` for skipped words and numbers. */
export interface EventWord {
  word: string;
  term: string | null;
}

type TermSource = Pick<JourneyEvent, "label" | "parameters">;

/** The words of an event, in order: its label, text parameters and the names of true flags. */
export function eventWords(event: TermSource): EventWord[] {
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
  return words.map((word) => ({
    word,
    term:
      /\p{L}/u.test(word) && !SKIP.has(word)
        ? (ENGLISH.get(word) ?? word)
        : null,
  }));
}

/** The English search terms of an event, each once. */
export function eventTerms(event: TermSource): string[] {
  return [...new Set(eventWords(event).flatMap(({ term }) => term ?? []))];
}
