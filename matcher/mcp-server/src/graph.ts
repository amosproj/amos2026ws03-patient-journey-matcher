import type { JourneyEvent } from "@matcher/core";
import { z } from "zod";

// Graphiti writes its times as ISO date-times, with or without a time zone. A journey needs the
// day, as it is written: a time zone does not move it.
const daySchema = z
  .union([z.iso.date(), z.iso.datetime({ local: true, offset: true })])
  .transform((value) => value.slice(0, 10));

const nodeSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  labels: z.array(z.string()),
});

const edgeSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  fact: z.string().min(1),
  source_node_uuid: z.string().min(1),
  target_node_uuid: z.string().min(1),
  valid_at: daySchema.nullish(),
  invalid_at: daySchema.nullish(),
});

// The patient graph of the SS26 pipeline, see "Patient graph" in Documentation/mcp-interface.md.
// Field names are Graphiti's, so its nodes and edges can be read as they are. Unknown fields
// are dropped.
export const patientGraphSchema = z
  .object({
    // The "now" of the patient, like `as_of` of a journey.
    as_of: z.iso.date().optional(),
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(edgeSchema).min(1),
  })
  .superRefine(({ nodes, edges }, context) => {
    if (nodes.filter(isPatient).length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["nodes"],
        message: "The graph must have exactly one Patient node.",
      });
    }
    for (const [list, entries] of [
      ["nodes", nodes],
      ["edges", edges],
    ] as const) {
      const seen = new Set<string>();
      entries.forEach(({ uuid }, index) => {
        if (seen.has(uuid)) {
          context.addIssue({
            code: "custom",
            path: [list, index, "uuid"],
            message: `Another entry of ${list} has the same uuid.`,
          });
        }
        seen.add(uuid);
      });
    }
    const known = new Set(nodes.map(({ uuid }) => uuid));
    edges.forEach((edge, index) => {
      for (const end of ["source_node_uuid", "target_node_uuid"] as const) {
        if (!known.has(edge[end])) {
          context.addIssue({
            code: "custom",
            path: ["edges", index, end],
            message: "The edge points to a node that is not in the graph.",
          });
        }
      }
      const { valid_at, invalid_at } = edge;
      if (valid_at != null && invalid_at != null && invalid_at < valid_at) {
        context.addIssue({
          code: "custom",
          path: ["edges", index, "invalid_at"],
          message: "The fact ends before it starts.",
        });
      }
    });
  });

export type PatientGraph = z.output<typeof patientGraphSchema>;
type Node = PatientGraph["nodes"][number];

function isPatient({ labels }: Node): boolean {
  return labels.includes("Patient");
}

/**
 * The journey of a patient graph, in the format `match_journey` takes: one event per day, named
 * by the nodes of the facts that start on that day.
 *
 * Left out are facts without a date and facts about a provider: who treated the patient and
 * where does not help to find literature. A fact that a newer one replaced (`invalid_at`) stays,
 * because it still happened on its day: Graphiti also marks an operation as replaced when a
 * later report describes it again. The fact sentences stay in the graph: the keyword matcher
 * reads event texts as German journey words and would turn the English "as" into a search term.
 *
 * `as_of` is passed on to the journey, where it picks the most recent event. The journey is not
 * checked here: the contract checks it like one that a client sends, e.g. that it has an event.
 */
export function graphJourney({ as_of, nodes, edges }: PatientGraph): {
  patient_id: string;
  as_of?: string;
  events: JourneyEvent[];
} {
  // The schema ensures the Patient node and that both ends of an edge are in the graph.
  const patient = nodes.find(isPatient) as Node;
  const byUuid = new Map(nodes.map((node) => [node.uuid, node]));
  const days = new Map<string, Set<string>>();
  for (const edge of edges) {
    const { valid_at } = edge;
    const ends = [edge.source_node_uuid, edge.target_node_uuid].map(
      (uuid) => byUuid.get(uuid) as Node,
    );
    const aboutProvider = ends.some(({ labels }) =>
      labels.includes("Provider"),
    );
    if (valid_at == null || aboutProvider) continue;

    for (const node of ends) {
      if (node === patient) continue;
      const names = days.get(valid_at) ?? new Set<string>();
      days.set(valid_at, names.add(node.name));
    }
  }
  return {
    patient_id: patient.name,
    as_of,
    events: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, names]) => ({
        id: date,
        type: "facts",
        // Sorted, so the label does not depend on the order of the edges.
        label: [...names].sort().join(", "),
        date,
      })),
  };
}
