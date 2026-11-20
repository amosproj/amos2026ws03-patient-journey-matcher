// Status of a statement from cue words (Documentation/graph-normalization.md §4.5): whether a
// fact sentence confirms, suspects or rules out an entity. Status belongs to one statement at
// its time, not to the concept: prostate cancer is suspected in November and confirmed in
// December. Without a cue near the entity the sentence says nothing, and the caller falls back.
import cues from "../data/status-cues.json" with { type: "json" };
import { normalizeName, words } from "./text.ts";
import type { Status } from "./types.ts";

type Cue = {
  words: string[];
  text: string;
  status: Exclude<Status, "planned" | "unknown"> | "pseudo";
  position: "pre" | "post";
};

const CUES: Cue[] = cues.cues.map((cue) => ({
  words: words(cue.text),
  text: cue.text,
  status: cue.status as Cue["status"],
  position: cue.position as Cue["position"],
}));
const CLAUSE_BREAKS = new Set(cues.clauseBreaks);
const ATTRIBUTES: Record<string, string | undefined> = cues.attributes;

export type StatusCue = {
  status: Exclude<Status, "planned" | "unknown">;
  cue: string;
};

// "V. a." and "Vd. a." (Verdacht auf) would end a sentence at their dots.
const VERDACHT_AUF = /\bv\s*d?\s*\.\s*a\s*\./gi;

/** Sentences, then clauses: split at `;`, `!`, `?`, a dot before a space and words like "but". */
function clauses(text: string): string[][] {
  const result: string[][] = [];
  for (const sentence of text
    .replace(VERDACHT_AUF, " verdacht auf ")
    .split(/[.;!?](?=\s|$)/)) {
    let clause: string[] = [];
    for (const word of words(sentence)) {
      if (CLAUSE_BREAKS.has(word)) {
        result.push(clause);
        clause = [];
      } else {
        clause.push(word);
      }
    }
    result.push(clause);
  }
  return result.filter((clause) => clause.length > 0);
}

type Span = { start: number; end: number };

function occurrences(
  clause: readonly string[],
  phrase: readonly string[],
): Span[] {
  const spans: Span[] = [];
  if (phrase.length === 0) return spans;
  for (let start = 0; start + phrase.length <= clause.length; start++) {
    if (phrase.every((word, offset) => clause[start + offset] === word)) {
      spans.push({ start, end: start + phrase.length });
    }
  }
  return spans;
}

/**
 * The status that the cue nearest to one of `names` gives it, or `undefined`. A `pre` cue
 * counts when it ends at most `window` words before the name, a `post` cue when it starts at
 * most `postWindow` words after it. A name that is not in the text gets no status: a cue is never
 * applied to a whole sentence.
 */
export function statusFromText(
  text: string,
  names: readonly string[],
): StatusCue | undefined {
  const phrases = [...new Set(names.map(normalizeName))]
    .filter((name) => name !== "")
    .map((name) => name.split(" "));
  let best: { distance: number; length: number; cue: Cue } | undefined;
  for (const clause of clauses(text)) {
    const found = CUES.flatMap((cue) =>
      occurrences(clause, cue.words).map((span) => ({ ...span, cue })),
    );
    // Of two overlapping cues the longer wins, so "cannot be ruled out" is not "ruled out".
    const kept = found.filter(
      (one) =>
        !found.some(
          (other) =>
            other !== one &&
            other.start < one.end &&
            one.start < other.end &&
            other.end - other.start > one.end - one.start,
        ),
    );
    for (const name of phrases.flatMap((phrase) =>
      occurrences(clause, phrase),
    )) {
      for (const match of kept) {
        if (match.cue.status === "pseudo") continue;
        if (match.start < name.end && name.start < match.end) continue;
        const distance =
          match.cue.position === "pre"
            ? name.start - match.end
            : match.start - name.end;
        const window =
          match.cue.position === "pre" ? cues.window : cues.postWindow;
        if (distance < 0 || distance > window) continue;
        const length = match.end - match.start;
        if (
          best === undefined ||
          distance < best.distance ||
          (distance === best.distance && length > best.length)
        ) {
          best = { distance, length, cue: match.cue };
        }
      }
    }
  }
  if (best === undefined) return undefined;
  return { status: best.cue.status as StatusCue["status"], cue: best.cue.text };
}

/** The status a node attribute such as `Diagnosis.status = "active"` stands for, if any. */
export function statusFromAttribute(value: unknown): Status | undefined {
  if (typeof value !== "string") return undefined;
  return ATTRIBUTES[normalizeName(value)] as Status | undefined;
}
