import { readFileSync } from "node:fs";
import type { Matcher } from "@matcher/core";
import type { DocumentStore } from "@matcher/db";
import { expect, test, vi } from "vitest";
import { matchJourneyInputSchema } from "./contract.ts";
import { graphJourney, patientGraphSchema } from "./graph.ts";
import { journeyState } from "./journey.ts";
import { createMatchService } from "./match.ts";

function node(uuid: string, name: string, type: string) {
  return { uuid, name, labels: ["Entity", type] };
}

function edge(
  uuid: string,
  [source, target]: [string, string],
  valid_at: string | null,
  invalid_at: string | null = null,
) {
  return {
    uuid,
    name: "RELATES_TO",
    fact: `Fact ${uuid}.`,
    source_node_uuid: source,
    target_node_uuid: target,
    valid_at,
    invalid_at,
  };
}

// A small part of a generated graph: a diagnosis, a PSA value that a newer one replaces, a
// fact without a date and a fact about the clinic.
const graph = {
  nodes: [
    node("patient", "Patient-5", "Patient"),
    node("cancer", "C61 Prostatakarzinom", "Diagnosis"),
    node("psa", "PSA", "LabTest"),
    node("surgery", "radical prostatectomy", "Procedure"),
    node("clinic", "Klinikum Berlin", "Provider"),
  ],
  edges: [
    edge("e1", ["patient", "cancer"], "2026-12-08T00:00:00"),
    edge(
      "e2",
      ["patient", "psa"],
      "2026-12-08T00:00:00",
      "2027-01-22T00:00:00",
    ),
    edge("e3", ["patient", "surgery"], "2027-01-22T00:00:00+00:00"),
    edge("e4", ["patient", "psa"], "2027-01-22T00:00:00+00:00"),
    edge("e5", ["psa", "cancer"], null),
    edge("e6", ["surgery", "clinic"], "2027-01-22T00:00:00+00:00"),
  ],
};

function read(input: unknown) {
  return patientGraphSchema.parse(input);
}

function issues(input: unknown) {
  return patientGraphSchema
    .safeParse(input)
    .error?.issues.map(({ path, message }) => ({ path, message }));
}

/** The graph with only this edge, from the patient to the diagnosis at this time. */
function at(valid_at: string) {
  return { ...graph, edges: [edge("e1", ["patient", "cancer"], valid_at)] };
}

test("reads Graphiti's nodes and edges and drops other fields", () => {
  const { nodes, edges } = read({
    ...graph,
    nodes: graph.nodes.map((entry) => ({ ...entry, group_id: "Patient-5" })),
  });

  expect(nodes[0]).toEqual(graph.nodes[0]);
  expect(edges[1]).toMatchObject({
    valid_at: "2026-12-08",
    invalid_at: "2027-01-22",
  });
  expect(edges[4]?.valid_at).toBeNull();
});

test.each([
  ["2027-01-22", "2027-01-22"],
  ["2027-01-22T00:00:00", "2027-01-22"],
  ["2027-01-22T23:46:15.185935", "2027-01-22"],
  ["2027-01-22T00:00:00Z", "2027-01-22"],
  ["2027-01-22T00:30:00+02:00", "2027-01-22"],
])("keeps the written day of the time %s", (time, day) => {
  expect(read(at(time)).edges[0]?.valid_at).toBe(day);
});

test.each(["December 8, 2026", "2027-01-22garbage", "2027-01-22T99:99:99", ""])(
  "rejects the time %j",
  (time) => {
    expect(issues(at(time))?.[0]?.path).toEqual(["edges", 0, "valid_at"]);
  },
);

test("rejects an edge that points to a node outside the graph", () => {
  const edges = [edge("e1", ["patient", "missing"], "2026-12-08")];

  expect(issues({ ...graph, edges })).toEqual([
    {
      path: ["edges", 0, "target_node_uuid"],
      message: "The edge points to a node that is not in the graph.",
    },
  ]);
});

test.each([
  ["no", graph.nodes.slice(1)],
  ["a second", [...graph.nodes, node("other", "Patient-6", "Patient")]],
])("rejects a graph with %s Patient node", (_, nodes) => {
  const edges = [edge("e5", ["psa", "cancer"], "2026-12-08")];

  expect(issues({ nodes, edges })).toEqual([
    {
      path: ["nodes"],
      message: "The graph must have exactly one Patient node.",
    },
  ]);
});

test("rejects two nodes with the same uuid", () => {
  const nodes = [...graph.nodes, node("cancer", "Olaparib", "Medication")];

  expect(issues({ ...graph, nodes })).toEqual([
    {
      path: ["nodes", 5, "uuid"],
      message: "Another entry of nodes has the same uuid.",
    },
  ]);
});

test("rejects two edges with the same uuid", () => {
  const edges = [...graph.edges, edge("e1", ["patient", "psa"], "2027-03-01")];

  expect(issues({ ...graph, edges })).toEqual([
    {
      path: ["edges", 6, "uuid"],
      message: "Another entry of edges has the same uuid.",
    },
  ]);
});

test("rejects a fact that ends before it starts", () => {
  const edges = [
    edge("e1", ["patient", "cancer"], "2027-02-01", "2027-01-01"),
    edge("e2", ["patient", "psa"], "2027-02-01", "2027-02-01"),
  ];

  expect(issues({ ...graph, edges })).toEqual([
    {
      path: ["edges", 0, "invalid_at"],
      message: "The fact ends before it starts.",
    },
  ]);
});

test("makes one event per day, keeps a replaced fact, leaves out undated and provider facts", () => {
  expect(graphJourney(read(graph))).toEqual({
    patient_id: "Patient-5",
    events: [
      {
        id: "2026-12-08",
        type: "facts",
        label: "C61 Prostatakarzinom, PSA",
        date: "2026-12-08",
      },
      {
        id: "2027-01-22",
        type: "facts",
        label: "PSA, radical prostatectomy",
        date: "2027-01-22",
      },
    ],
  });
});

test("sorts the events by day, whatever the order of the edges", () => {
  const edges = graph.edges.toReversed();

  expect(graphJourney(read({ ...graph, edges })).events).toMatchObject([
    { id: "2026-12-08" },
    { id: "2027-01-22" },
  ]);
});

test("passes as_of on to the journey, where it picks the most recent event", () => {
  const journey = graphJourney(read(graph), "2026-12-31");

  expect(journey.as_of).toBe("2026-12-31");
  expect(journeyState(journey).focus.id).toBe("2026-12-08");
});

test("rejects an as_of before the first fact, like the contract", () => {
  expect(() => graphJourney(read(graph), "2026-01-01")).toThrow(
    "as_of must not be earlier than the first event.",
  );
});

test("makes no event from a fact that names only the patient", () => {
  const edges = [
    ...graph.edges,
    edge("e7", ["patient", "patient"], "2027-03-01"),
  ];

  expect(graphJourney(read({ ...graph, edges })).events).toHaveLength(2);
});

test("gives a journey that match_journey takes", async () => {
  const match = vi.fn<Matcher["match"]>(async () => []);
  const store: DocumentStore = {
    getDocuments: async () => [],
    getDocument: async () => undefined,
    documentsToIndex: async () => [],
    countToIndex: async () => 0,
  };
  const service = createMatchService(
    [{ name: "keyword", matcher: { match } }],
    store,
  );

  const result = await service.matchJourney(
    matchJourneyInputSchema.parse({ journey: graphJourney(read(graph)) }),
  );

  expect(result).toMatchObject({
    focus_event_id: "2027-01-22",
    degraded: false,
  });
  expect(match.mock.calls[0]?.[0].context.map(({ id }) => id)).toEqual([
    "2026-12-08",
  ]);
});

test("rejects a graph without a dated fact, like the contract an empty journey", () => {
  const edges = [edge("e5", ["psa", "cancer"], null)];

  expect(() => graphJourney(read({ ...graph, edges }))).toThrow();
});

test("rejects a graph with facts on more than 500 days", () => {
  const days = (count: number) => ({
    ...graph,
    edges: Array.from({ length: count }, (_, index) =>
      edge(
        `e${index}`,
        ["patient", "cancer"],
        new Date(Date.UTC(2020, 0, 1 + index)).toISOString(),
      ),
    ),
  });

  expect(graphJourney(read(days(500))).events).toHaveLength(500);
  expect(() => graphJourney(read(days(501)))).toThrow();
});

test("reads the generated graph of Patient-5, which ends on the day its timeline ends", () => {
  const folder = new URL("../../../patientdata/Patient-5/", import.meta.url);
  const file = (name: string) =>
    JSON.parse(readFileSync(new URL(name, folder), "utf8"));
  const timeline = file("timeline.json");

  const journey = graphJourney(read(file("graph.json")));

  expect(journey.patient_id).toBe(timeline.patient_id);
  expect(journey.events.at(-1)?.date).toBe(timeline.events.at(-1).date);
});
