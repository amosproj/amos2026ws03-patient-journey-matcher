// The relation tables (Documentation/design/graph-normalization.md#relations): one per source, as
// data, so that a new type is a new row. A row matches the source type and the types of both
// ends.
import patient from "../data/patient-relations.json" with { type: "json" };
import pubtator from "../data/pubtator-relations.json" with { type: "json" };
import type { FactKind, PatientFact, Predicate, Status } from "./types.ts";

type Row = {
  type: string;
  subject?: string;
  object?: string;
  predicate?: Predicate;
  fact?: FactKind;
  conditionRole?: PatientFact["conditionRole"];
  flip?: boolean;
  status?: Status;
  drop?: string;
  /** Patient side: the status is read about the source node instead of the target. */
  about?: "source";
  /** Patient side: an edge whose ends are one entity confirms that entity's conditions. */
  confirms?: boolean;
};

export type Mapping =
  | {
      kind: "relation";
      predicate: Predicate;
      flip: boolean;
      about?: "source";
      confirms?: boolean;
    }
  | {
      kind: "fact";
      fact: FactKind;
      status?: Status;
      conditionRole?: PatientFact["conditionRole"];
    }
  | { kind: "drop"; reason: string };

/** The first row whose type matches and whose `subject` and `object`, where given, match too. */
function findRow(
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
    return {
      kind: "fact",
      fact: row.fact,
      status: row.status,
      conditionRole: row.conditionRole,
    };
  if (row.predicate !== undefined) {
    return {
      kind: "relation",
      predicate: row.predicate,
      flip: row.flip === true,
      about: row.about,
      confirms: row.confirms,
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
 * A patient edge by its type and the labels of its two nodes. An edge from the patient without
 * a fact row is dropped: a patient fact needs a row, and a relation never has the patient at an
 * end (so the catch-all `RELATES_TO` row does not take it). An unknown edge between two
 * findings is `related`.
 */
export function mapPatientEdge(
  type: string,
  subject: string,
  object: string,
): Mapping {
  const row = findRow(PATIENT_ROWS, type, subject, object);
  const found: Mapping =
    row === undefined
      ? { kind: "relation", predicate: "related", flip: false }
      : mapping(row);
  if (
    found.kind === "relation" &&
    (subject === "Patient" || object === "Patient")
  ) {
    return { kind: "drop", reason: "no row for this patient edge" };
  }
  return found;
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
