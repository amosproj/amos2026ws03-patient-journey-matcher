import type { JourneyEvent } from "@matcher/core";

// journey vocabulary: translations, skip words, negations, generic terms
import german from "../data/german-terms.json" with { type: "json" };

// Map: a plain object also answers "constructor"
const ENGLISH = new Map<string, string>(Object.entries(german.translations));
const SKIP = new Set(german.skip);
const GENERIC = new Set(german.generic);
// negates the rest of the clause: "keine Fernmetastasen"
const NEGATES_FOLLOWING = new Set(german.negations.following);
// negates the whole clause: "Lymphknoten unauffällig"
const NEGATES_CLAUSE = new Set(german.negations.clause);
// negates the next word only: "nicht nachweisbar"
const NEGATES_NEXT = new Set(german.negations.next);
// not the comma of "87,7" or the point of "11.25"
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

/** The words of an event, in order: label, text parameters, names of true flags. */
export function eventWords(event: TermSource): EventWord[] {
  const texts = [event.label];
  for (const [key, value] of Object.entries(event.parameters ?? {})) {
    // specialties at a tumor board are no finding
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
  const afterNext = (index: number) => NEGATES_NEXT.has(words[index - 1] ?? "");
  // "nicht ausgeschlossen": a negation word after one of NEGATES_NEXT is cancelled
  const negates = (list: Set<string>) => (word: string, index: number) =>
    list.has(word) && !afterNext(index);
  const negatedFrom = words.some(negates(NEGATES_CLAUSE))
    ? 0
    : words.findIndex(negates(NEGATES_FOLLOWING));
  return words.map((word, index) => {
    const negation =
      NEGATES_CLAUSE.has(word) ||
      NEGATES_FOLLOWING.has(word) ||
      NEGATES_NEXT.has(word);
    const negated =
      (negatedFrom !== -1 && index >= negatedFrom) || afterNext(index);
    if (negated && !negation) return { word, term: null, negated: true };
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

/** Too general to say much about a patient, e.g. "initial". */
export function isGeneric(term: string): boolean {
  return GENERIC.has(term);
}
