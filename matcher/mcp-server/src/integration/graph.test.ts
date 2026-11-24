import { readFileSync } from "node:fs";
import { testDatabaseUrl } from "@matcher/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import graph from "./fixtures/olaparib/graph.json" with { type: "json" };
import timeline from "./fixtures/olaparib/timeline.json" with { type: "json" };
import { createHarness, type Harness } from "./harness.ts";

const databaseUrl = testDatabaseUrl();
const pubtatorPath = "/research/pubtator3-api/publications/export/biocjson";
const drug = { type: "Chemical", identifier: "MESH:C531550", name: "olaparib" };
const breast = {
  type: "Disease",
  identifier: "MESH:D001943",
  name: "Breast Neoplasms",
};
const lung = {
  type: "Disease",
  identifier: "MESH:D008175",
  name: "Lung Neoplasms",
};
const paperIds = ["pubmed:101", "pubmed:102"];
const abstract = "We studied olaparib, Breast Neoplasms and Lung Neoplasms.";

// Both exports name all three concepts in their abstract. Only the relation's object differs.
const papers = [breast, lung].map((role2, index) => ({
  id: String(101 + index),
  passages: [
    {
      infons: { type: "abstract" },
      text: abstract,
      annotations: [drug, breast, lung].map((infons) => ({
        infons,
        text: infons.name,
      })),
    },
  ],
  relations: [
    {
      id: "R1",
      infons: {
        type: "Negative_Correlation",
        role1: drug,
        role2,
        score: "0.99",
      },
    },
  ],
}));

function request(format: string, indication?: "breast" | "lung") {
  if (format === "graph") {
    const edges = [...graph.edges];
    if (indication)
      edges.push({
        uuid: "indication",
        name: "TREATED_BY",
        source_node_uuid: indication,
        target_node_uuid: "rx",
        valid_at: "2026-02-09",
        fact: "Olaparib started.",
      });
    return { graph: { ...graph, edges }, algorithm: "graph" };
  }
  const events = timeline.events.map((event) =>
    indication && event.id === "therapy"
      ? {
          ...event,
          parameters: {
            ...event.parameters,
            indication: `${indication} cancer`,
          },
        }
      : event,
  );
  return { journey: { ...timeline, events }, algorithm: "graph" };
}

describe.skipIf(!databaseUrl)("graph match_journey over HTTP", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(databaseUrl as string);
    await h.db.pool.query(
      `INSERT INTO documents (id, source, native_id, content_type, title, summary, canonical_url, retrieved_at)
       SELECT 'pubmed:' || id, 'pubmed', id, 'journal_article', 'Olaparib', $1, 'https://example.org/' || id, now()
       FROM unnest(ARRAY['101','102']) id`,
      [abstract],
    );
    h.providers.routes.set(pubtatorPath, [
      { type: "application/json", body: JSON.stringify({ PubTator3: papers }) },
    ]);
    await h.index();
  });
  afterAll(async () => h?.close());

  test.each([
    ["graph", "graph"],
    ["journey", "timeline"],
  ])(
    "%s ranks the Breast sample's documented treatment first",
    async (argument, filename) => {
      const file = new URL(
        `../../../../patientdata/Breast/${filename}.json`,
        import.meta.url,
      );
      const answer = await h.match({
        [argument]: JSON.parse(readFileSync(file, "utf8")),
        algorithm: "graph",
      });
      expect(answer.results.map((hit) => hit.source_id)).toEqual(paperIds);
      expect(answer.results[0].explanation).toContain(
        "documented treatment indication",
      );
    },
  );

  test.each(["graph", "timeline"])(
    "%s reverses the order only with the documented indication",
    async (format) => {
      for (const indication of ["breast", "lung"] as const) {
        const args = request(format, indication);
        const answer = await h.match(args);
        const ids =
          indication === "breast" ? paperIds : [...paperIds].reverse();
        expect(answer).toMatchObject({
          degraded: false,
          algorithm: "graph",
          focus_event_id: format === "graph" ? "2026-02-09" : "therapy",
          results: [
            {
              rank: 1,
              source_id: ids[0],
              explanation: expect.stringContaining(
                "documented treatment indication",
              ),
            },
            { rank: 2, source_id: ids[1] },
          ],
        });
        expect(answer.results[0].score).toBe(1);
        expect(answer.results[1].score).toBeLessThan(1);
        expect(await h.match(args)).toEqual(answer);
        expect(
          (
            await h.match({
              ...args,
              limit: 1,
              content_types: ["journal_article"],
            })
          ).results,
        ).toEqual(answer.results.slice(0, 1));
      }
      const unknown = await h.match(request(format));
      expect(unknown.results.map(({ source_id }) => source_id)).toEqual(
        paperIds,
      );
      expect(unknown.results[0].score).toBe(unknown.results[1].score);
      for (const [i, hit] of unknown.results.entries()) {
        expect(hit.explanation).toContain(
          `in this paper (olaparib → ${[breast.name, lung.name][i]})`,
        );
        expect(hit.explanation).toContain(
          "Patient indication is undocumented.",
        );
        expect(hit.explanation).not.toContain(
          "documented treatment indication",
        );
      }
    },
  );

  test.each(["graph", "timeline"])(
    "%s returns the same complete answer before and after appending therapy",
    async (format) => {
      const as_of = "2026-01-10";
      const args = request(format, "lung");
      const old =
        format === "graph"
          ? {
              graph: {
                ...graph,
                nodes: graph.nodes.slice(0, 3),
                edges: graph.edges.slice(0, 2),
                as_of,
              },
            }
          : {
              journey: {
                ...timeline,
                events: timeline.events.slice(0, 2),
                as_of,
              },
            };
      const historic = await h.match({ ...old, algorithm: "graph" });
      expect(historic.focus_event_id).toBe(format === "graph" ? as_of : "dx2");
      expect(historic.results).toHaveLength(2);
      const complete =
        format === "graph"
          ? { graph: { ...args.graph, as_of } }
          : { journey: { ...args.journey, as_of } };
      expect(await h.match({ ...complete, algorithm: "graph" })).toEqual(
        historic,
      );
    },
  );

  test("distinguishes a valid empty graph search from missing edge endpoints", async () => {
    const args = request("graph");
    const invalid = await h.client.callTool({
      name: "match_journey",
      arguments: {
        algorithm: "graph",
        graph: {
          ...graph,
          edges: [
            {
              ...graph.edges[0],
              source_node_uuid: "absent1",
              target_node_uuid: "absent2",
            },
          ],
        },
      },
    });
    expect(invalid.isError).toBe(true);
    for (const end of ["source_node_uuid", "target_node_uuid"])
      expect(JSON.stringify(invalid.content)).toContain(`graph.edges.0.${end}`);
    const unrelated = {
      ...graph,
      nodes: [graph.nodes[0], { ...graph.nodes[1], name: "Crohn disease" }],
      edges: [{ ...graph.edges[0], fact: "Crohn disease confirmed." }],
    };
    expect(
      await h.match({ graph: unrelated, algorithm: "graph" }),
    ).toMatchObject({
      degraded: false,
      results: [],
      focus_event_id: "2026-01-10",
    });
    expect(await h.match({ ...args, content_types: ["video"] })).toMatchObject({
      algorithm: "graph",
      degraded: false,
      results: [],
    });
  });
});
