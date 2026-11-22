import type { JourneyEvent, JourneyState } from "@matcher/core";
import { normalizePatientGraph } from "./patient.ts";
import { icdCodesFor, resolve, resolveIcd } from "./resolve.ts";
import { statusFromText } from "./status.ts";
import { normalizeName } from "./text.ts";
import type { Status, Triple } from "./types.ts";

export interface GraphQuery {
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

type DatedStatus = { validAt?: string; invalidAt?: string; status: Status };

function latest<T extends DatedStatus>(
  statements: T[],
  keyOf: (statement: T) => string,
  cutoff: string,
): T[] {
  const selected = new Map<string, T>();
  for (const statement of statements) {
    const { validAt, invalidAt } = statement;
    if (!validAt || validAt > cutoff || (invalidAt && invalidAt <= cutoff))
      continue;
    const key = keyOf(statement);
    const old = selected.get(key);
    if (
      !old ||
      validAt > (old.validAt ?? "") ||
      (validAt === old.validAt &&
        STATUS_ORDER[statement.status] > STATUS_ORDER[old.status])
    ) {
      selected.set(key, statement);
    }
  }
  return [...selected.values()];
}

function timelineConditions(events: JourneyEvent[]) {
  const diagnoses = new Map<string, { since: string; names: Set<string> }>();
  const notes: { date: string; text: string; diagnosis?: string }[] = [];
  for (const event of events) {
    const type = normalizeName(event.type);
    if (type === "family history") continue;
    const diagnosis = event.parameters?.diagnosis;
    const code = event.parameters?.icd_code;
    const names = typeof diagnosis === "string" ? [diagnosis] : [];
    if (["diagnosis", "pathology", "progression"].includes(type))
      names.push(event.label);
    const concept =
      resolve({ names, icdCode: code })?.concept ??
      names.map(resolveIcd).find(Boolean);
    if (concept?.type === "disease") {
      const known = diagnoses.get(concept.id) ?? {
        since: event.date,
        names: new Set([
          concept.name,
          ...concept.names,
          ...icdCodesFor(concept.id),
        ]),
      };
      if (event.date < known.since) known.since = event.date;
      for (const name of [code, ...names]) {
        if (typeof name === "string" && resolveIcd(name)?.id === concept.id)
          known.names.add(name);
      }
      diagnoses.set(concept.id, known);
    }
    const text =
      typeof diagnosis === "string"
        ? `${diagnosis}. ${event.label}`
        : event.label;
    notes.push({ date: event.date, text, diagnosis: concept?.id });
  }
  // Same-day evidence is evaluated together, regardless of the order of the events.
  const statements: (DatedStatus & { entity: string })[] = [];
  for (const [entity, { since, names }] of diagnoses) {
    const aliases = [...names];
    for (const note of notes) {
      if (note.date < since) continue;
      const status = statusFromText(note.text, aliases)?.status;
      if (status || note.diagnosis === entity)
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
  const query: GraphQuery = {
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
    for (const fact of latest(conditions, (fact) => fact.entity, focus.date)) {
      if (fact.status !== "negated")
        query.diagnoses.set(fact.entity, weight(fact.validAt, fact.status));
    }
    return query;
  }

  const cutoff = graph.as_of ?? focus.date;
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
    if (relation.predicate === "related") continue;
    query.relations.set(
      tripleKey(relation),
      weight(relation.validAt, relation.status),
    );
  }
  return query;
}
