import type { JourneyEvent, JourneyState } from "@matcher/core";
import { normalizePatientGraph } from "./patient.ts";
import { findDiseases, icdCodesFor, resolveIcd } from "./resolve.ts";
import { statusFromText } from "./status.ts";
import { normalizeName } from "./text.ts";
import type { Status, Triple } from "./types.ts";

export interface GraphQuery {
  cutoff: string;
  diagnoses: Map<string, number>;
  treatments: Map<string, number>;
  details: Map<string, number>;
  relations: Map<string, number>;
  conceptOnly: boolean;
}

export function tripleKey({ subject, predicate, object }: Triple): string {
  return JSON.stringify([subject, predicate, object]);
}

const CERTAINTY: Record<Status, number> = {
  asserted: 1,
  unknown: 0.65,
  planned: 0.55,
  suspected: 0.45,
  negated: 0,
};

// Graphiti supplies day precision. On a tie prefer explicit evidence, with a veto for negation.
const STATUS_ORDER: Record<Status, number> = {
  unknown: 0,
  planned: 1,
  suspected: 2,
  asserted: 3,
  negated: 4,
};

const EXPLICIT_STATUSES: ReadonlySet<Status> = new Set([
  "asserted",
  "suspected",
  "negated",
]);

type DatedStatus = { validAt?: string; invalidAt?: string; status: Status };

function latest<T extends DatedStatus>(
  statements: T[],
  keyOf: (statement: T) => string,
  cutoff: string,
): T[] {
  const byKey = new Map<string, T[]>();
  for (const statement of statements) {
    const { validAt, invalidAt } = statement;
    if (!validAt || validAt > cutoff || (invalidAt && invalidAt <= cutoff))
      continue;
    const key = keyOf(statement);
    const list = byKey.get(key) ?? [];
    list.push(statement);
    byKey.set(key, list);
  }
  const result: T[] = [];
  for (const list of byKey.values()) {
    list.sort(
      (a, b) =>
        (a.validAt ?? "").localeCompare(b.validAt ?? "") ||
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
    );
    // An un-cued follow-up (`unknown`) advances the date without erasing an established status.
    let current = list[0];
    for (let i = 1; i < list.length; i++) {
      const next = list[i];
      current =
        next.status === "unknown" && EXPLICIT_STATUSES.has(current.status)
          ? { ...next, status: current.status }
          : next;
    }
    result.push(current);
  }
  return result;
}

function timelineConditions(events: JourneyEvent[]) {
  const diagnoses = new Map<string, { since: string; names: Set<string> }>();
  const notes: { date: string; text: string; diagnoses: Set<string> }[] = [];
  for (const event of events) {
    const type = normalizeName(event.type);
    if (type === "family history") continue;
    const diagnosis = event.parameters?.diagnosis;
    const code = event.parameters?.icd_code;
    const fields = typeof diagnosis === "string" ? [diagnosis] : [];
    if (["diagnosis", "pathology", "progression"].includes(type))
      fields.push(event.label);
    const hits = fields.flatMap(findDiseases);
    const byCode = resolveIcd(code);
    if (byCode?.type === "disease")
      hits.push({ concept: byCode, code: String(code) });
    const eventDiagnoses = new Set<string>();
    for (const { concept, code: matchedCode } of hits) {
      eventDiagnoses.add(concept.id);
      const known = diagnoses.get(concept.id) ?? {
        since: event.date,
        names: new Set([
          concept.name,
          ...concept.names,
          ...icdCodesFor(concept.id),
        ]),
      };
      if (event.date < known.since) known.since = event.date;
      if (matchedCode) known.names.add(matchedCode);
      diagnoses.set(concept.id, known);
    }
    const text =
      typeof diagnosis === "string"
        ? `${diagnosis}. ${event.label}`
        : event.label;
    notes.push({ date: event.date, text, diagnoses: eventDiagnoses });
  }
  // Same-day evidence is evaluated together, regardless of the order of the events.
  const statements: (DatedStatus & { entity: string })[] = [];
  for (const [entity, { since, names }] of diagnoses) {
    const aliases = [...names];
    for (const note of notes) {
      if (note.date < since) continue;
      const status = statusFromText(note.text, aliases)?.status;
      if (status || note.diagnoses.has(entity))
        statements.push({
          entity,
          validAt: note.date,
          status: status ?? "unknown",
        });
    }
  }
  return statements;
}

export function patientQuery({
  focus,
  context,
  graph,
}: JourneyState): GraphQuery {
  const cutoff = graph?.as_of ?? focus.date;
  const query: GraphQuery = {
    cutoff,
    diagnoses: new Map(),
    treatments: new Map(),
    details: new Map(),
    relations: new Map(),
    conceptOnly: graph === undefined,
  };
  const weight = (date: string | undefined, status: Status) =>
    CERTAINTY[status] * (date === focus.date ? 1.2 : 1);

  if (!graph) {
    const conditions = timelineConditions([...context, focus]);
    for (const fact of latest(conditions, (fact) => fact.entity, cutoff)) {
      if (fact.status !== "negated")
        query.diagnoses.set(fact.entity, weight(fact.validAt, fact.status));
    }
    return query;
  }

  // Future-only nodes must not contribute aliases or labels to a historical snapshot.
  const edges = graph.edges.filter(
    (edge) => edge.valid_at && edge.valid_at.slice(0, 10) <= cutoff,
  );
  const ends = new Set(
    edges.flatMap((edge) => [edge.source_node_uuid, edge.target_node_uuid]),
  );
  const normalized = normalizePatientGraph({
    nodes: graph.nodes.filter((node) => ends.has(node.uuid)),
    edges,
  });
  const entities = new Map(
    normalized.entities.map((entity) => [entity.key, entity]),
  );
  for (const fact of latest(
    normalized.facts,
    (f) => `${f.conditionRole ?? f.kind}:${f.entity}`,
    cutoff,
  )) {
    const entity = entities.get(fact.entity);
    if (!entity?.id || fact.status === "negated") continue;
    const w = weight(fact.validAt, fact.status);
    if (fact.conditionRole === "diagnosis" && entity.type === "disease") {
      query.diagnoses.set(entity.id, w);
    } else if (fact.kind === "receives") {
      query.treatments.set(entity.id, w);
    } else {
      query.details.set(
        entity.id,
        Math.max(w, query.details.get(entity.id) ?? 0),
      );
    }
  }
  for (const relation of latest(normalized.relations, tripleKey, cutoff)) {
    // An unspecified relationship on both sides is no evidence that their meanings agree.
    if (
      relation.predicate === "related" ||
      !entities.get(relation.subject)?.id ||
      !entities.get(relation.object)?.id
    )
      continue;
    query.relations.set(
      tripleKey(relation),
      weight(relation.validAt, relation.status),
    );
  }
  return query;
}
