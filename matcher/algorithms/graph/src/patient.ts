// Patient graph → NormalizedGraph (Documentation/graph-normalization.md §1 and §4). Reads the
// graph.json of the SS26 pipeline in Graphiti's field names, like the journey reader in
// mcp-server/src/graph.ts, but keeps what that reader drops: the fact sentences, `invalid_at`
// and the node attributes. It is also more lenient: a node or edge it cannot read is skipped
// and reported, not a reason to reject the graph.
import { z } from "zod";
import { DROPPED_PATIENT_LABELS, mapPatientEdge } from "./relations.ts";
import { conceptOf, curated, type Dictionary, resolve } from "./resolve.ts";
import { statusFromAttribute, statusFromText } from "./status.ts";
import { normalizeName, withoutLeadingCode } from "./text.ts";
import {
  type EntityType,
  type NormalizedEntity,
  type NormalizedGraph,
  type NormalizedRelation,
  type PatientFact,
  type Skipped,
  type Status,
  SYMMETRIC,
} from "./types.ts";

// The graph must have both lists; each node and edge is read on its own, see `readEach`.
const graphSchema = z.object({
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
});

const nodeSchema = z.object({
  uuid: z.string().min(1),
  name: z.string(),
  labels: z.array(z.string()),
  attributes: z.record(z.string(), z.unknown()).nullish(),
});

const edgeSchema = z.object({
  uuid: z.string().min(1),
  name: z.string(),
  source_node_uuid: z.string(),
  target_node_uuid: z.string(),
  fact: z.string().nullish(),
  valid_at: z.unknown().optional(),
  invalid_at: z.unknown().optional(),
});

type Node = z.output<typeof nodeSchema>;

/** The type of a node by its label, when no concept gives one. */
const LABEL_TYPES: ReadonlyMap<string, EntityType> = new Map([
  ["Diagnosis", "disease"],
  ["Symptom", "disease"],
  ["Allergy", "disease"],
  ["Medication", "chemical"],
  ["Procedure", "procedure"],
  ["TreatmentPlan", "procedure"],
  ["LabTest", "finding"],
  ["TumorMarker", "finding"],
  ["PathologyResult", "finding"],
  ["ImagingResult", "finding"],
]);

/** The items `schema` can read; each other one is reported in `skipped` with the reason. */
function readEach<T>(
  items: readonly unknown[],
  schema: z.ZodType<T>,
  what: "node" | "edge",
  skipped: Skipped[],
): T[] {
  const read: T[] = [];
  for (const [index, item] of items.entries()) {
    const result = schema.safeParse(item);
    if (result.success) {
      read.push(result.data);
      continue;
    }
    const uuid = (item as { uuid?: unknown } | null)?.uuid;
    // A failed parse has at least one issue; the first names the field.
    const [issue] = result.error.issues;
    skipped.push({
      ref: typeof uuid === "string" && uuid !== "" ? uuid : `${what} ${index}`,
      type: what,
      reason: `not readable: ${issue.path.join(".") || what} ${issue.message}`,
    });
  }
  return read;
}

const MONTHS = [
  ["january", "januar"],
  ["february", "februar"],
  ["march", "marz"],
  ["april"],
  ["may", "mai"],
  ["june", "juni"],
  ["july", "juli"],
  ["august"],
  ["september"],
  ["october", "oktober"],
  ["november"],
  ["december", "dezember"],
];

/** `YYYY-MM-DD`, or `undefined` for a day that does not exist (`2026-02-31`). */
function day(year: string, month: number, date: string): string | undefined {
  const value = `${year}-${String(month).padStart(2, "0")}-${date.padStart(2, "0")}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

/**
 * The day of a date as written: ISO (`2026-12-08`, also with a time), `December 8, 2026` or
 * `8. Dezember 2026`. Graphiti takes `date_confirmed` from an LLM, so both forms occur.
 */
export function parseDay(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (iso !== null) return day(iso[1], Number(iso[2]), iso[3]);
  const text = normalizeName(value);
  const monthOf = (name: string) =>
    MONTHS.findIndex((names) => names.includes(name)) + 1;
  const english = /^([a-z]+) (\d{1,2}) (\d{4})$/.exec(text);
  if (english !== null && monthOf(english[1]) > 0) {
    return day(english[3], monthOf(english[1]), english[2]);
  }
  const german = /^(\d{1,2}) ([a-z]+) (\d{4})$/.exec(text);
  if (german !== null && monthOf(german[2]) > 0) {
    return day(german[3], monthOf(german[2]), german[1]);
  }
  return undefined;
}

function labelOf(node: Node): string {
  return node.labels.find((label) => label !== "Entity") ?? "Entity";
}

/**
 * The status a node attribute gives a statement: only from the day the diagnosis was
 * confirmed. Graphiti rewrites a node with every document, so `status: active` describes the
 * end of the record, not the suspicion of the first weeks.
 */
function statusFromNode(
  node: Node,
  validAt: string | undefined,
): Status | undefined {
  const status = statusFromAttribute(node.attributes?.status);
  const confirmed = parseDay(node.attributes?.date_confirmed);
  if (status === undefined || confirmed === undefined || validAt === undefined)
    return undefined;
  return validAt >= confirmed ? status : undefined;
}

export function normalizePatientGraph(
  input: unknown,
  { dictionaries = [curated] }: { dictionaries?: readonly Dictionary[] } = {},
): NormalizedGraph {
  const graph = graphSchema.parse(input);
  const skipped: Skipped[] = [];
  const graphNodes = readEach(graph.nodes, nodeSchema, "node", skipped);
  const graphEdges = readEach(graph.edges, edgeSchema, "edge", skipped);
  const nodes = new Map(graphNodes.map((node) => [node.uuid, node]));
  const entities = new Map<string, NormalizedEntity>();
  const keyOf = new Map<string, string>();

  for (const node of nodes.values()) {
    const label = labelOf(node);
    if (label === "Patient" || DROPPED_PATIENT_LABELS.has(label)) continue;
    const resolution = resolve(
      { names: [node.name], icdCode: node.attributes?.icd_code },
      dictionaries,
    );
    const concept = resolution?.concept;
    // Unresolved nodes merge only by their normalized name, without a leading code
    // (`C61 X` is `X`), which never leaves this graph. A name with nothing left (`(C61)`, `–`)
    // merges with nothing.
    const normalized = normalizeName(node.name);
    const key =
      concept?.id ??
      (normalized === ""
        ? `node:${node.uuid}`
        : `name:${withoutLeadingCode(normalized) ?? normalized}`);
    keyOf.set(node.uuid, key);
    const known = entities.get(key);
    if (known !== undefined) {
      known.names = [...new Set([...known.names, node.name])];
      known.labels = [...new Set([...known.labels, label])];
      known.sources.push(node.uuid);
      continue;
    }
    entities.set(key, {
      key,
      id: concept?.id ?? null,
      // The concept decides: a catheter labelled Medication is a device, PSA a gene.
      type: concept?.type ?? LABEL_TYPES.get(label) ?? "finding",
      name: concept?.name ?? node.name,
      names: [node.name],
      resolvedBy: resolution?.resolvedBy ?? null,
      labels: [label],
      sources: [node.uuid],
    });
  }

  // The names to find an entity by in a fact sentence: as written, also without a leading
  // code (`C61 Prostatakarzinom` is found as `Prostatakarzinom`), and those of its concept.
  function namesOf(key: string): string[] {
    const entity = entities.get(key);
    const concept = entity?.id == null ? undefined : conceptOf(entity.id);
    const names = entity?.names ?? [];
    return [
      ...names,
      ...names.flatMap((name) => withoutLeadingCode(normalizeName(name)) ?? []),
      ...(concept === undefined ? [] : [concept.name, ...concept.names]),
    ];
  }

  const relations: NormalizedRelation[] = [];
  const facts: PatientFact[] = [];
  // Entities confirmed by an edge between two of their own nodes: the earliest day, and the
  // edge type, which becomes the cue.
  const confirmed = new Map<string, { from: string; cue: string }>();

  for (const edge of graphEdges) {
    const skip = (reason: string) =>
      skipped.push({ ref: edge.uuid, type: edge.name, reason });
    const source = nodes.get(edge.source_node_uuid);
    const target = nodes.get(edge.target_node_uuid);
    if (source === undefined || target === undefined) {
      skip("points to a node that is not in the graph");
      continue;
    }
    const [sourceLabel, targetLabel] = [labelOf(source), labelOf(target)];
    const dropped = [sourceLabel, targetLabel].find((label) =>
      DROPPED_PATIENT_LABELS.has(label),
    );
    if (dropped !== undefined) {
      skip(`${dropped} nodes are left out`);
      continue;
    }
    const mapping = mapPatientEdge(edge.name, sourceLabel, targetLabel);
    if (mapping.kind === "drop") {
      skip(mapping.reason);
      continue;
    }

    const validAt = parseDay(edge.valid_at);
    const invalidAt = parseDay(edge.invalid_at);
    // The status is about the target: the diagnosis of HAS_DIAGNOSIS and of INDICATES alike.
    // TREATED_BY points from the diagnosis to the drug, so its row reads it about the source.
    const aboutSource =
      mapping.kind === "relation" && mapping.about === "source";
    const about = aboutSource ? source : target;
    const aboutKey = keyOf.get(about.uuid);
    const cue =
      edge.fact == null || aboutKey === undefined
        ? undefined
        : statusFromText(edge.fact, namesOf(aboutKey));
    const statement = {
      status:
        cue?.status ??
        (mapping.kind === "fact" ? mapping.status : undefined) ??
        statusFromNode(about, validAt) ??
        "unknown",
      cue: cue?.cue,
      text: edge.fact ?? undefined,
      validAt,
      invalidAt,
      origin: { source: "patient" as const, ref: edge.uuid, type: edge.name },
    };

    if (mapping.kind === "fact") {
      const other =
        sourceLabel === "Patient"
          ? target
          : targetLabel === "Patient"
            ? source
            : undefined;
      const entity = other === undefined ? undefined : keyOf.get(other.uuid);
      if (entity === undefined) {
        skip("a patient fact needs the patient at one end");
        continue;
      }
      facts.push({ ...statement, kind: mapping.fact, entity });
      continue;
    }

    const [first, second] = [keyOf.get(source.uuid), keyOf.get(target.uuid)];
    if (first === undefined || second === undefined) {
      skip(
        "a relation between two entities may not start or end at the patient",
      );
      continue;
    }
    if (first === second) {
      const confirms = mapping.confirms === true && validAt !== undefined;
      if (confirms) {
        const known = confirmed.get(first);
        if (known === undefined || validAt < known.from)
          confirmed.set(first, { from: validAt, cue: edge.name });
      }
      skip(
        `both ends are the same entity${confirms ? `; confirms it from ${validAt}` : ""}`,
      );
      continue;
    }
    let [subject, object] = mapping.flip ? [second, first] : [first, second];
    if (SYMMETRIC.has(mapping.predicate) && object < subject)
      [subject, object] = [object, subject];
    relations.push({
      ...statement,
      subject,
      predicate: mapping.predicate,
      object,
    });
  }

  // A pathology result of the diagnosis itself confirms it: from that day, a condition that
  // nothing else gave a status is asserted. Cues and attributes are never overridden.
  for (const fact of facts) {
    if (fact.kind !== "has_condition" || fact.status !== "unknown") continue;
    const by = confirmed.get(fact.entity);
    if (
      by !== undefined &&
      fact.validAt !== undefined &&
      fact.validAt >= by.from
    ) {
      fact.status = "asserted";
      fact.cue = by.cue;
    }
  }

  return { entities: [...entities.values()], relations, facts, skipped };
}
