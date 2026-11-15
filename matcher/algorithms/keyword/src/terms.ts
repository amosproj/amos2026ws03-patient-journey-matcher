import type { JourneyEvent } from "@matcher/core";

// journey vocabulary: translations, skip words, negations, generic terms
import german from "../data/german-terms.json" with { type: "json" };

// Map: a plain object also answers "constructor"
const ENGLISH = new Map<string, string>(Object.entries(german.translations));
const SKIP = new Set(german.skip);
const GENERIC = new Set(german.generic);
type Scope = keyof typeof german.negations;
// negation words and phrases with their scope; longest first: "nicht befallen" beats "nicht"
const NEGATIONS = Object.entries(german.negations)
  .flatMap(([scope, entries]) =>
    entries.map((entry) => ({
      scope: scope as Scope,
      words: entry.split(" "),
    })),
  )
  .sort((a, b) => b.words.length - a.words.length);
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
  // per word: the scope of the negation it is part of
  const scopes = words.map((): Scope | undefined => undefined);
  words.forEach((_, at) => {
    if (scopes[at]) return;
    const found = NEGATIONS.find((negation) =>
      negation.words.every((word, offset) => words[at + offset] === word),
    );
    if (found) scopes.fill(found.scope, at, at + found.words.length);
  });
  const searched = (word: string, at: number) =>
    !scopes[at] && /\p{L}/u.test(word) && !SKIP.has(word);
  const negatedNext = new Set<number>();
  const cancelled = new Set<number>();
  scopes.forEach((scope, at) => {
    if (scope !== "next") return;
    // over skipped words: "nicht in die Samenblasen", "nicht sicher ausgeschlossen"
    const target = words.findIndex(
      (word, index) =>
        index > at &&
        scopes[index] !== "next" &&
        (scopes[index] || searched(word, index)),
    );
    if (target === -1) return;
    if (!scopes[target]) {
      negatedNext.add(target);
      return;
    }
    // a negated negation negates nothing
    for (let index = target; scopes[index] === scopes[target]; index++) {
      cancelled.add(index);
    }
  });
  const first = (scope: Scope) =>
    scopes.findIndex((found, at) => found === scope && !cancelled.has(at));
  const negatedFrom = first("clause") === -1 ? first("following") : 0;
  return words.map((word, at) => {
    if (scopes[at]) return { word, term: null };
    if ((negatedFrom !== -1 && at >= negatedFrom) || negatedNext.has(at)) {
      return { word, term: null, negated: true };
    }
    return {
      word,
      term: searched(word, at) ? (ENGLISH.get(word) ?? word) : null,
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
