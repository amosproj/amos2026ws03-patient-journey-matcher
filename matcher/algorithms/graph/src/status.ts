// Status of a statement from cue words (Documentation/design/graph-normalization.md#status):
// whether a fact sentence confirms, suspects or rules out an entity. Status belongs to one
// statement at its time, not to the concept: prostate cancer is suspected in November and
// confirmed in December. Without a cue near the entity the sentence says nothing, and the
// caller falls back.
import cues from "../data/status-cues.json" with { type: "json" };
import type { Terminology } from "./resolve.ts";
import { normalizeName, words } from "./text.ts";
import type { Status } from "./types.ts";

/** What a cue can say; a `pseudo` cue only blocks shorter ones (`no change` is not `no`). */
export const CUE_STATUSES = [
  "asserted",
  "suspected",
  "negated",
  "pseudo",
] as const;

type Cue = {
  words: string[];
  text: string;
  status: (typeof CUE_STATUSES)[number];
  position: "pre" | "post";
  /** Words allowed between cue and name; the file's `window` or `postWindow` when not set. */
  window: number;
};

const CUES: readonly Cue[] = cues.cues.map((cue) => ({
  words: words(cue.text),
  text: cue.text,
  status: cue.status as Cue["status"],
  position: cue.position as Cue["position"],
  window:
    ("window" in cue ? cue.window : undefined) ??
    (cue.position === "pre" ? cues.window : cues.postWindow),
}));
const CLAUSE_BREAKS: ReadonlySet<string> = new Set(
  cues.clauseBreaks.map(normalizeName),
);
const NEGATORS: ReadonlySet<string> = new Set(cues.negators.map(normalizeName));
const ATTRIBUTES: ReadonlyMap<string, Status> = new Map(
  Object.entries(cues.attributes).map(([value, status]) => [
    normalizeName(value),
    status as Status,
  ]),
);

export type StatusCue = {
  status: Exclude<Status, "planned" | "unknown">;
  cue: string;
};

// Family history belongs to the relative even when stored on a patient-diagnosis edge.
const RELATIVE =
  /\b(?:(?:grand)?(?:mother|father|parents?)|sister|brother|daughter|son|aunt|uncle|sibling|(?:gro[ßs]s?)?(?:mutter|vater|eltern)|schwester|bruder|tochter|sohn|tante|onkel)\b/gi;
const FAMILY_HISTORY = /\b(?:family history|familienanamnese)\b/i;

function familyClause(clause: string): boolean {
  if (FAMILY_HISTORY.test(clause)) return true;
  return [...clause.matchAll(RELATIVE)].some((match) => {
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length);
    // A relative can accompany the patient without being the subject of the diagnosis.
    return (
      !/\b(?:accompanied by|in the presence of|in begleitung (?:von|der|des))\s+(?:(?:the|his|her|their|seiner|ihrer)\s+)?$/i.test(
        before,
      ) &&
      !/^\s+(?:accompanied|brought|begleitete)\s+(?:the |her |his |their |den |die )?(?:patient\w*|him|her|ihn|sie)\b/i.test(
        after,
      )
    );
  });
}

export function patientText(text: string): string {
  if (!familyClause(text)) return text;
  const parts = text
    .replace(VERDACHT_AUF, "verdacht auf ")
    .split(
      /[;!?]|\.(?=\s|$)|,?\s+\b(?:but|aber|jedoch)\b\s+|(?:,\s*|\s+(?:and|und)\s+)(?=(?:(?:the|der|die)\s+)?patient\w*\b)/i,
    );
  return parts
    .filter((clause) => clause.trim() && !familyClause(clause))
    .join(". ")
    .trim();
}

const PLANNED =
  /\b(?:plan(?:ned)?|proposed|scheduled|recommended|empfohlen|geplant\w*|vorgesehen)\b/i;
const CANCELLED =
  /\b(?:cancelled|canceled|abgesagt\w*|(?:not|never)\s+(?:(?:yet|previously|ever|been)\s+)*(?:give[n]?|start(?:ed)?|administer(?:ed)?|receive[d]?|undergone|undergo|prescribe[d]?)|(?:nicht|nie)\s+(?:begonnen|verabreicht|erhalten|durchgefuhrt|durchgeführt|verordnet))\b/i;
const PERFORMED =
  /\b(?:administered|received|underwent|given|started|begonnen|verabreicht|durchgeführt|durchgefuhrt)\b/i;

export function treatmentStatus(text: string): Status | undefined {
  if (CANCELLED.test(text)) return "negated";
  // A recommendation can describe the strategy under which treatment is already being given.
  const course = text.replace(
    /\b(?:the )?recommended (?:treatment |therapy )?(?:regimen|strategy)\b/gi,
    "",
  );
  if (PLANNED.test(course)) return "planned";
  if (PERFORMED.test(text)) return "asserted";
  if (/\b(?:prescribed|verordnet|verschrieben)\b/i.test(text)) return "unknown";
  return undefined;
}

/** Conjoined drug names can share a verb. A new sentence or a contrast starts a new action. */
export function treatmentClauses(text: string) {
  return text
    .split(/[;!?]|\.(?=\s|$)|\b(?:but|however|aber|jedoch)\b/i)
    .flatMap((sentence) => {
      const parts = sentence.split(/,\s*|\b(?:and|und)\b/i);
      const statuses = parts.map(treatmentStatus);
      let shared = statuses.findLast((status) => status !== undefined);
      for (let i = parts.length - 1; i >= 0; i--) {
        shared = statuses[i] ?? shared;
        statuses[i] = shared;
      }
      return parts.map((text, i) => ({ text, status: statuses[i] }));
    });
}

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
 * counts when it ends at most its window of words before the name, a `post` cue when it starts
 * at most its window after it (`window` and `postWindow` of the file, unless the cue sets
 * one). A name that is not in the text gets no status: a cue is never applied to a whole
 * sentence.
 */
export function statusFromText(
  text: string,
  names: readonly string[],
  otherMentions: readonly string[] = [],
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
    // A pseudo cue says nothing, and neither does a cue after a negation ("could not be ruled
    // out", "has not been confirmed"); both still block the shorter cues inside them.
    const effective = kept.filter(
      ({ cue, start }) =>
        cue.status !== "pseudo" &&
        !clause
          .slice(Math.max(0, start - cues.negatorWindow), start)
          .some((word) => NEGATORS.has(word)),
    );
    const otherSpans = otherMentions.flatMap((other) =>
      occurrences(clause, words(other)),
    );
    for (const name of phrases.flatMap((phrase) =>
      occurrences(clause, phrase),
    )) {
      if (
        otherSpans.some(
          (span) => span.start <= name.start && span.end >= name.end,
        )
      )
        continue;
      const near = effective.flatMap((match) => {
        if (match.start < name.end && name.start < match.end) return [];
        const distance =
          match.cue.position === "pre"
            ? name.start - match.end
            : match.start - name.end;
        return distance < 0 || distance > match.cue.window
          ? []
          : [{ distance, length: match.end - match.start, cue: match.cue }];
      });
      // "The suspected X was confirmed": a confirmation after the name ends the suspicion
      // before it, though "suspected" stands nearer.
      const confirmed = near.some(
        ({ cue }) => cue.status === "asserted" && cue.position === "post",
      );
      for (const one of near) {
        if (
          confirmed &&
          one.cue.status === "suspected" &&
          one.cue.position === "pre"
        )
          continue;
        if (
          best === undefined ||
          one.distance < best.distance ||
          (one.distance === best.distance && one.length > best.length)
        ) {
          best = one;
        }
      }
    }
  }
  if (best === undefined) return undefined;
  return { status: best.cue.status as StatusCue["status"], cue: best.cue.text };
}

/** Keep the cue on the disease phrase that the terminology actually matched. */
export function diseaseMentions(text: string, terminology: Terminology) {
  return text
    .replace(VERDACHT_AUF, "verdacht auf ")
    .split(/[;!?]|\.(?=\s|$)|\b(?:but|however|aber|jedoch)\b/i)
    .flatMap((clause) => {
      const hits = terminology.findDiseases(clause);
      return hits.map((hit) => ({
        ...hit,
        status: statusFromText(
          clause,
          [hit.mention],
          hits
            .filter((other) => other.concept.id !== hit.concept.id)
            .map((other) => other.mention),
        )?.status,
      }));
    });
}

/** Read a treatment action about this edge's subject, including a shared verb in a list. */
export function graphTreatmentStatus(
  text: string,
  names: string[],
  terminology: Terminology,
) {
  const clauses = treatmentClauses(text);
  const aliases = names.map(normalizeName).filter(Boolean);
  const named = clauses.filter((clause) => {
    const words = ` ${normalizeName(clause.text)} `;
    return aliases.some((name) => words.includes(` ${name} `));
  });
  if (named.length) {
    for (const clause of named.reverse()) {
      const cue = statusFromText(clause.text, names)?.status;
      if (cue === "negated" || cue === "suspected") return cue;
      if (clause.status) return clause.status;
    }
    return;
  }
  if (
    clauses.some((clause) =>
      terminology
        .findConcepts(clause.text)
        .some(
          (concept) =>
            concept.type === "chemical" || concept.type === "procedure",
        ),
    )
  )
    return;
  const actions = new Set(clauses.flatMap((clause) => clause.status ?? []));
  if (actions.size === 1) return [...actions][0];
}

/** The status a node attribute such as `Diagnosis.status = "active"` stands for, if any. */
export function statusFromAttribute(value: unknown): Status | undefined {
  if (typeof value !== "string") return undefined;
  return ATTRIBUTES.get(normalizeName(value));
}
