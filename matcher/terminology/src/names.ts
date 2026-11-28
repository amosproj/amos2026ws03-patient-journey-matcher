import { normalizeName } from "./text.ts";

/** Normalized names, each to its entry; shorter than 4 characters left out, one of two IDs `null`. */
export function nameIndex<T extends { id: string }>(
  entries: Iterable<T>,
  names: (entry: T) => readonly string[],
): Map<string, T | null> {
  const result = new Map<string, T | null>();
  for (const entry of entries) {
    for (const name of names(entry)) {
      const key = normalizeName(name);
      if (key.length < 4 || !/\p{L}/u.test(key)) continue;
      const known = result.get(key);
      result.set(
        key,
        known === undefined || known?.id === entry.id ? entry : null,
      );
    }
  }
  return result;
}

/** A name found in a list of words: its entry and the words it spans, `end` excluded. */
export type Phrase<T> = { value: T; start: number; end: number };

/** Finds whole names in normalized words, the longest first; each word belongs to one name at most. */
export function phraseLookup<T>(names: ReadonlyMap<string, T>) {
  const grouped = Map.groupBy(
    [...names]
      .map(([name, value]) => ({ value, phrase: name.split(" ") }))
      .sort((a, b) => b.phrase.length - a.phrase.length),
    ({ phrase }) => phrase[0],
  );
  return (
    tokens: readonly string[],
    accept: (value: T) => boolean = () => true,
  ): Phrase<T>[] => {
    const found: Phrase<T>[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const match = grouped
        .get(tokens[i])
        ?.find(
          ({ value, phrase }) =>
            accept(value) &&
            phrase.every((word, offset) => word === tokens[i + offset]),
        );
      if (match) {
        found.push({
          value: match.value,
          start: i,
          end: i + match.phrase.length,
        });
        i += match.phrase.length - 1;
      }
    }
    return found;
  };
}
