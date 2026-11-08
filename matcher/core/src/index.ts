// The contracts between the matching approaches and the rest of the matcher: the MCP server and
// the indexer job know approaches only through these interfaces.

/** An event of a patient journey, as the matchers read it; the MCP contract validates it. */
export interface JourneyEvent {
  id: string;
  type: string;
  label: string;
  /** ISO date. */
  date: string;
  parameters?: Record<string, unknown>;
}

/** What every matcher gets for one journey: the event to match and the older events that still matter. */
export interface JourneyState {
  focus: JourneyEvent;
  context: JourneyEvent[];
}

export interface MatchOptions {
  limit: number;
  /** `content_type` values to keep; all if left out. */
  contentTypes?: readonly string[];
}

/** A stored document a matcher found for a journey. */
export interface Hit {
  documentId: string;
  /** From 0 to 1, relative to the best hit of the same list. */
  score: number;
  /** The query terms found in the document, for approaches that match terms. */
  matchedTerms?: string[];
}

/** Ranks the documents an approach indexed for a journey. */
export interface Matcher {
  /** The best hits for the journey, best first. */
  match(state: JourneyState, options: MatchOptions): Promise<Hit[]>;
}

/** Brings an approach's index up to date with `documents`; run by the indexer job after each crawl. */
export interface Indexer {
  /** Indexes the new and changed documents; `log` gets progress lines. */
  index(log: (line: string) => void): Promise<void>;
}

/**
 * A matching approach as a plug-in (keyword #8, AI summary #9, graph #10): its index and the
 * matcher that reads it. Approaches are interchangeable; `match_journey` picks one by name.
 */
export interface Approach {
  /** Its `algorithm` value in `match_journey`. */
  readonly name: string;
  readonly indexer: Indexer;
  readonly matcher: Matcher;
}

export { type Ranking, reciprocalRankFusion } from "./fusion.ts";
