// The relation tables (Documentation/graph-normalization.md §4.3): one per source, as data, so
// that a new type is a new row. A row matches the source type and the types of both ends.
import patient from "../data/patient-relations.json" with { type: "json" };
import pubtator from "../data/pubtator-relations.json" with { type: "json" };
import type { FactKind, Predicate, Status } from "./types.ts";

export type Row = {
  type: string;
  subject?: string;
  object?: string;
  predicate?: Predicate;
  fact?: FactKind;
  flip?: boolean;
  status?: Status;
  drop?: string;
};

export type Mapping =
  | { kind: "relation"; predicate: Predicate; flip: boolean }
  | { kind: "fact"; fact: FactKind; status?: Status }
  | { kind: "drop"; reason: string };

/** The first row whose type matches and whose `subject` and `object`, where given, match too. */
export function findRow(
  rows: readonly Row[],
  type: string,
  subject: string,
  object: string,
): Row | undefined {
  return rows.find(
    (row) =>
      row.type === type &&
      (row.subject === undefined || row.subject === subject) &&
      (row.object === undefined || row.object === object),
  );
}

function mapping(row: Row): Mapping {
  if (row.drop !== undefined) return { kind: "drop", reason: row.drop };
  if (row.fact !== undefined)
    return { kind: "fact", fact: row.fact, status: row.status };
  if (row.predicate !== undefined) {
    return {
      kind: "relation",
      predicate: row.predicate,
      flip: row.flip === true,
    };
  }
  throw new Error(
    `The row for ${row.type} has neither drop, fact nor predicate.`,
  );
}

const PATIENT_ROWS = patient.rows as Row[];
const PUBTATOR_ROWS = pubtator.rows as Row[];

export const DROPPED_PATIENT_LABELS: ReadonlySet<string> = new Set(
  patient.droppedLabels,
);
export const DROPPED_PUBTATOR_TYPES: ReadonlySet<string> = new Set(
  pubtator.droppedTypes,
);

/**
 * A patient edge by its type and the labels of its two nodes. An unknown edge from the patient
 * is dropped: a patient fact needs a row. An unknown edge between two findings is `related`.
 */
export function mapPatientEdge(
  type: string,
  subject: string,
  object: string,
): Mapping {
  const row = findRow(PATIENT_ROWS, type, subject, object);
  if (row !== undefined) return mapping(row);
  if (subject === "Patient" || object === "Patient") {
    return { kind: "drop", reason: "no row for this patient edge" };
  }
  return { kind: "relation", predicate: "related", flip: false };
}

/** A PubTator3 relation by its type and the types of its two roles; unknown ones are `related`. */
export function mapPubTatorRelation(
  type: string,
  subject: string,
  object: string,
): Extract<Mapping, { kind: "relation" }> {
  const row = findRow(PUBTATOR_ROWS, type, subject, object);
  const found = row === undefined ? undefined : mapping(row);
  if (found?.kind === "relation") return found;
  return { kind: "relation", predicate: "related", flip: false };
}
