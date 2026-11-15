import type { JourneyEvent } from "@matcher/core";

// The words of the journeys: English translations, words to skip, negations and generic terms.
import german from "../data/german-terms.json" with { type: "json" };

// A Map, not the object: a plain object also answers "constructor".
const ENGLISH = new Map<string, string>(Object.entries(german.translations));
const SKIP = new Set(german.skip);
const GENERIC = new Set(german.generic);
// A finding after one of these is absent, up to the end of its clause: "keine Fernmetastasen".
const NEGATES_FOLLOWING = new Set(german.negations.following);
// With one of these, the whole clause is: "Lymphknoten unauffällig".
const NEGATES_CLAUSE = new Set(german.negations.clause);
// Not the comma of "87,7" or the point of "11.25".
const CLAUSE_END = /[;:()]|[,.]\s|\s[–—-]\s/;

/** The words of the English terms, e.g. "radical" and "prostatectomy". */
export const ENGLISH_WORDS = [...ENGLISH.values()].flatMap((term) =>
  term.split(" "),
);

/** A word of an event and the search term it becomes; `null` for skipped words and numbers. */
export interface EventWord {
  word: string;
  term: string | null;
  /** Left out as part of a negated finding. */
  negated?: true;
}

type TermSource = Pick<JourneyEvent, "label" | "parameters">;

/**
 * The words of an event, in order: its label, text parameters and the names of true flags. Not
 * who took part: the specialties at a tumor board are no finding, and "Strahlentherapie" searched
 * radiotherapy at a decision for surgery (#58).
 */
export function eventWords(event: TermSource): EventWord[] {
  const texts = [event.label];
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    if (key === "participants") continue;
    if (value === true) texts.push(key);
    for (const item of [value].flat()) {
      if (typeof item === "string") texts.push(item);
    }
  }
  return texts
    .flatMap((text) =>
      text.replaceAll("_", " ").toLowerCase().split(CLAUSE_END),
    )
    .flatMap(clauseWords);
}

function clauseWords(clause: string): EventWord[] {
  const words = clause.match(/[\p{L}\p{N}]+/gu) ?? [];
  const negatedFrom = words.some((word) => NEGATES_CLAUSE.has(word))
    ? 0
    : words.findIndex((word) => NEGATES_FOLLOWING.has(word));
  return words.map((word, index) => {
    const negation = NEGATES_CLAUSE.has(word) || NEGATES_FOLLOWING.has(word);
    if (negatedFrom !== -1 && index >= negatedFrom && !negation) {
      return { word, term: null, negated: true };
    }
    return {
      word,
      term:
        /\p{L}/u.test(word) && !SKIP.has(word) && !negation
          ? (ENGLISH.get(word) ?? word)
          : null,
    };
  });
}

/** The English search terms of an event, each once. */
export function eventTerms(event: TermSource): string[] {
  return [...new Set(eventWords(event).flatMap(({ term }) => term ?? []))];
}

/** Whether a search term is too general to say much about a patient, e.g. "initial". */
export function isGeneric(term: string): boolean {
  return GENERIC.has(term);
}
