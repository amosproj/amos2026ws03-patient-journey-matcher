// The shared representation of the patient graph and the PubTator3 annotations of a paper, see
// Documentation/graph-normalization.md §3. Both adapters return a NormalizedGraph, so the graph
// matcher compares the two sides on the same IDs and predicates.

/** What an entity is. `procedure`, `finding` and `device` occur only on the patient side. */
export type EntityType =
  | "disease"
  | "chemical"
  | "gene"
  | "variant"
  | "procedure"
  | "finding"
  | "device";

/** How a patient entity got its ID; `null` when it has none. PubTator3 entities: `"pubtator"`. */
export type ResolvedBy = "icd" | "curated" | "pubtator" | null;

/** Relations between two entities. The symmetric ones have no direction, see `SYMMETRIC`. */
export type Predicate =
  | "treats"
  | "causes"
  | "improves_outcome"
  | "worsens_outcome"
  | "indicates"
  | "associated_with"
  | "positive_correlation"
  | "negative_correlation"
  | "cotreated_with"
  | "compared_with"
  | "interacts_with"
  | "related";

export const SYMMETRIC: ReadonlySet<Predicate> = new Set([
  "associated_with",
  "cotreated_with",
  "compared_with",
  "interacts_with",
]);

/** What a patient fact says about the patient. Not compared with paper triples one to one. */
export type FactKind = "has_condition" | "receives" | "has_finding";

export type Status =
  | "asserted"
  | "suspected"
  | "negated"
  | "planned"
  | "unknown";

export type NormalizedEntity = {
  /** Unique within one graph; the ID, or the normalized name when there is none. Never compared across graphs. */
  key: string;
  /** Shared concept ID (`mesh:D011471`, `ncbigene:675`), or `null`: then it takes no part in triple matching. */
  id: string | null;
  type: EntityType;
  /** Display name: the preferred name of the concept, else the first name seen. */
  name: string;
  /** All names it was written with, as written. */
  names: string[];
  resolvedBy: ResolvedBy;
  /** Patient node labels (`Medication`) or PubTator3 types (`Chemical`) it came with. */
  labels: string[];
  /** Patient node `uuid`s, or `<pmid>` for PubTator3. */
  sources: string[];
};

export type Origin = {
  source: "patient" | "pubtator";
  /** Patient edge `uuid`, or `<pmid>:<relation id>`. */
  ref: string;
  /** The type in the source, e.g. `TREATED_BY` or `Negative_Correlation`. */
  type: string;
};

type Statement = {
  status: Status;
  /** The cue word that set the status, e.g. `suspected`. */
  cue?: string;
  /** The fact sentence of a patient edge. */
  text?: string;
  /** PubTator3 confidence, 0 to 1. */
  score?: number;
  validAt?: string;
  invalidAt?: string;
  origin: Origin;
};

export type NormalizedRelation = Statement & {
  subject: string;
  predicate: Predicate;
  object: string;
};

export type PatientFact = Statement & {
  kind: FactKind;
  entity: string;
};

export type Skipped = { ref: string; type: string; reason: string };

export type NormalizedGraph = {
  entities: NormalizedEntity[];
  /** Entity-relation-entity triples; `subject` and `object` are entity keys. */
  relations: NormalizedRelation[];
  /** Patient side only: what the patient has, gets or undergoes. */
  facts: PatientFact[];
  /** What was left out and why, for the coverage report and the debug UI. */
  skipped: Skipped[];
};
