import { z } from "zod";
import { type MatchJourneyInput, patientJourneySchema } from "./contract.ts";

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
    const known = new Set<string>();
    nodes.forEach(({ uuid }, index) => {
      if (known.has(uuid)) {
        context.addIssue({
          code: "custom",
          path: ["nodes", index, "uuid"],
          message: "Another node has the same uuid.",
        });
      }
      known.add(uuid);
    });
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
 * Left out are facts without a date, facts about a provider (who treated the patient and where
 * does not help to find literature) and facts that a newer one replaced on or before `as_of`,
 * or at any time without `as_of`. The fact sentences stay in the graph: the keyword matcher
 * reads event texts as German journey words and would turn the English "as" into a search term.
 *
 * Throws like the contract does for a journey: without an event, with more than 500, or with
 * an `as_of` before the first one.
 */
export function graphJourney(
  { nodes, edges }: PatientGraph,
  as_of?: string,
): MatchJourneyInput["journey"] {
  // The schema ensures the Patient node and that both ends of an edge are in the graph.
  const patient = nodes.find(isPatient) as Node;
  const byUuid = new Map(nodes.map((node) => [node.uuid, node]));
  const days = new Map<string, Set<string>>();
  for (const edge of edges) {
    const { valid_at, invalid_at } = edge;
    const ends = [edge.source_node_uuid, edge.target_node_uuid].map(
      (uuid) => byUuid.get(uuid) as Node,
    );
    const replaced =
      invalid_at != null && (as_of === undefined || invalid_at <= as_of);
    const aboutProvider = ends.some(({ labels }) =>
      labels.includes("Provider"),
    );
    if (valid_at == null || replaced || aboutProvider) continue;

    for (const node of ends) {
      if (node === patient) continue;
      const names = days.get(valid_at) ?? new Set<string>();
      days.set(valid_at, names.add(node.name));
    }
  }
  return patientJourneySchema.parse({
    patient_id: patient.name,
    as_of,
    events: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, names]) => ({
        id: date,
        type: "facts",
        label: [...names].join(", "),
        date,
      })),
  });
}
