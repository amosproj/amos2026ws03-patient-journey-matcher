import { readdirSync, readFileSync } from "node:fs";
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
  expect(edges[1]).toEqual({
    uuid: "e2",
    source_node_uuid: "patient",
    target_node_uuid: "psa",
    valid_at: "2026-12-08",
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

test("does not reject a graph for the edge fields it does not read", () => {
  const edges = [
    // Graphiti takes both times from the LLM and does not check their order.
    edge("e1", ["patient", "cancer"], "2027-02-01", "2027-01-01"),
    // No `name` and no `fact`, and an `invalid_at` that is not a time.
    {
      uuid: "e2",
      source_node_uuid: "patient",
      target_node_uuid: "psa",
      valid_at: "2027-02-01",
      invalid_at: "next week",
    },
  ];

  expect(graphJourney(read({ ...graph, edges })).events).toMatchObject([
    { id: "2027-02-01", label: "C61 Prostatakarzinom, PSA" },
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
  const journey = graphJourney(read({ ...graph, as_of: "2026-12-31" }));

  expect(journey.as_of).toBe("2026-12-31");
  expect(journeyState(journey).focus.id).toBe("2026-12-08");
});

test("makes no event from a fact that names only the patient", () => {
  const edges = [
    ...graph.edges,
    edge("e7", ["patient", "patient"], "2027-03-01"),
  ];

  expect(graphJourney(read({ ...graph, edges })).events).toHaveLength(2);
});

test("match_journey takes a graph and matches its journey", async () => {
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
    matchJourneyInputSchema.parse({ graph }),
  );

  expect(result).toMatchObject({
    focus_event_id: "2027-01-22",
    degraded: false,
  });
  expect(match.mock.calls[0]?.[0].context.map(({ id }) => id)).toEqual([
    "2026-12-08",
  ]);
});

test("gives no event for a graph without a dated fact", () => {
  const edges = [edge("e5", ["psa", "cancer"], null)];

  expect(graphJourney(read({ ...graph, edges })).events).toEqual([]);
});

test("match_journey rejects a graph with facts on more than 500 days, like a journey", () => {
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

  const request = (count: number) =>
    matchJourneyInputSchema.safeParse({ graph: days(count) });

  expect(request(500).data?.journey.events).toHaveLength(500);
  expect(request(501).success).toBe(false);
});

const patientdata = new URL("../../../patientdata/", import.meta.url);
const patients = readdirSync(patientdata).filter((name) =>
  name.startsWith("Patient-"),
);

// Days of a timeline for which the graph has no medical fact. The laboratory report of
// Patient-19 of that day only added that the patient was at the laboratory: its PSA value
// was already in the graph, from the referral letter three days before.
const daysWithoutFact: Record<string, string[]> = {
  "Patient-19": ["2026-11-09"],
};

test("has the 20 generated patients", () => {
  expect(patients).toHaveLength(20);
});

test.each(patients)(
  "reads the generated graph of %s, which holds every PDF and the days of its timeline",
  (patient) => {
    const folder = new URL(`${patient}/`, patientdata);
    const file = (name: string) =>
      JSON.parse(readFileSync(new URL(name, folder), "utf8"));
    const pdfs = readdirSync(folder).filter((name) => name.endsWith(".pdf"));
    const generated = file("graph.json");
    const timeline = file("timeline.json");
    const days = new Set<string>(
      timeline.events.map((event: { date: string }) => event.date),
    );
    for (const day of daysWithoutFact[patient] ?? []) {
      days.delete(day);
    }

    const journey = graphJourney(read(generated));

    expect(journey.patient_id).toBe(timeline.patient_id);
    expect(generated.documents.toSorted()).toEqual(pdfs.toSorted());
    expect(journey.events.map((event) => event.date)).toEqual([...days].sort());
  },
);
