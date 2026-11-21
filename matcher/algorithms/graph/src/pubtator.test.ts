import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { normalizePubTatorDocument, pubTatorDocuments } from "./pubtator.ts";

function fixture(pmid: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../fixtures/pubtator/${pmid}.json`, import.meta.url),
      "utf8",
    ),
  );
}

const triples = (pmid: string, minScore?: number) =>
  normalizePubTatorDocument(fixture(pmid), { minScore }).relations.map(
    ({ subject, predicate, object }) => `${subject} ${predicate} ${object}`,
  );

test("olaparib in prostate cancer: treat, cause, outcomes, cotreatment and comparison", () => {
  expect(triples("32343890").sort()).toEqual(
    [
      "mesh:C531550 treats mesh:D011471",
      "mesh:C089740 treats mesh:D011471",
      "mesh:C540278 treats mesh:D011471",
      // `treat Death` is not a disease to match: olaparib lowers mortality.
      "mesh:C531550 improves_outcome mesh:D003643",
      // Positive correlations with a disease are side effects, not treatments.
      "mesh:C531550 causes mesh:D000740",
      "mesh:C531550 causes mesh:D010146",
      "mesh:C531550 causes mesh:D009325",
      "mesh:C531550 negative_correlation ncbigene:142",
      "mesh:D011471 associated_with ncbigene:142",
      // Symmetric: the two ends sorted, whatever their order in the paper.
      "mesh:C089740 cotreated_with mesh:C531550",
      "mesh:C089740 compared_with mesh:C540278",
      "mesh:C531550 compared_with mesh:C540278",
    ].sort(),
  );
});

test("relations below the score are left out and reported", () => {
  const graph = normalizePubTatorDocument(fixture("32343890"), {
    minScore: 0.5,
  });
  expect(graph.relations.map(({ predicate }) => predicate)).not.toContain(
    "cotreated_with",
  );
  expect(graph.skipped.filter(({ ref }) => ref.includes(":"))).toEqual([
    {
      ref: "32343890:R5",
      type: "Cotreatment",
      reason: "score 0.4297 below 0.5",
    },
    {
      ref: "32343890:R11",
      type: "Comparison",
      reason: "score 0.3812 below 0.5",
    },
  ]);
});

test("entities: MeSH and NCBI Gene IDs, the mention texts as names, no species", () => {
  const { entities } = normalizePubTatorDocument(fixture("32343890"));
  expect(entities.find(({ id }) => id === "mesh:D011471")).toMatchObject({
    type: "disease",
    name: "Prostatic Neoplasms",
    resolvedBy: "pubtator",
    labels: ["Disease"],
    sources: ["32343890"],
  });
  expect(entities.find(({ id }) => id === "ncbigene:675")).toMatchObject({
    type: "gene",
    name: "BRCA2",
  });
  expect(entities.some(({ labels }) => labels.includes("Species"))).toBe(false);
});

test("an annotation of two genes is two entities", () => {
  const ids = normalizePubTatorDocument(fixture("30345884")).entities.map(
    ({ id }) => id,
  );
  expect(ids).toContain("ncbigene:672");
  expect(ids).toContain("ncbigene:675");
  expect(ids).not.toContain("ncbigene:672;675");
});

test("the same drug for another disease gives no triple with prostate cancer", () => {
  expect(triples("30345884")).toContain("mesh:C531550 treats mesh:D010051");
  expect(
    triples("30345884").some((triple) => triple.endsWith("mesh:D011471")),
  ).toBe(false);
});

test("PubTator3 gaps the matcher has to live with", () => {
  const { entities } = normalizePubTatorDocument(fixture("35923949"));
  // The paper is about leuprorelin, but PubTator3 does not annotate it.
  expect(entities.some(({ id }) => id === "mesh:D016729")).toBe(false);
  // "PSA" is annotated as NPEPPS (9520), not KLK3 (354).
  expect(entities.find(({ names }) => names.includes("PSA"))?.id).toBe(
    "ncbigene:9520",
  );
});

test("reads an export, a list and a single document", () => {
  const one = fixture("35923949");
  expect(pubTatorDocuments({ PubTator3: [one] })).toEqual([one]);
  expect(pubTatorDocuments([one])).toEqual([one]);
  expect(pubTatorDocuments(one)).toEqual([one]);
});

test("an entity without an identifier has no ID and keeps its name", () => {
  const { entities } = normalizePubTatorDocument({
    id: "1",
    passages: [
      {
        annotations: [
          {
            infons: { type: "Disease", identifier: "-", name: null },
            text: "odd disease",
          },
        ],
      },
    ],
  });
  expect(entities).toEqual([
    {
      key: "name:odd disease",
      id: null,
      type: "disease",
      name: "odd disease",
      names: ["odd disease"],
      resolvedBy: null,
      labels: ["Disease"],
      sources: ["1"],
    },
  ]);
});

// Regressions of the review of #80.
const document = (relations: unknown[], annotations: unknown[] = []) => ({
  id: "1",
  passages: [{ annotations }],
  relations,
});
const relation = (
  id: string,
  type: string,
  role1: unknown,
  role2: unknown,
  score?: string,
) => ({ id, infons: { type, score, role1, role2 } });
const gene = (identifier: string) => ({ type: "Gene", identifier, name: "g" });

test("roles with several IDs pair up each with each, never an ID with itself", () => {
  const graph = normalizePubTatorDocument(
    document([
      relation("R1", "Association", gene("672;675"), gene("672;675"), "0.9"),
      relation("R2", "Association", gene("672"), gene("672"), "0.9"),
    ]),
  );
  expect(
    graph.relations.map(({ subject, object }) => `${subject} ${object}`),
  ).toEqual(["ncbigene:672 ncbigene:675"]);
  expect(graph.skipped).toEqual([
    {
      ref: "1:R2",
      type: "Association",
      reason: "both ends are the same entity",
    },
  ]);
});

test("scores: equal to minScore is kept, none at all is kept, duplicates keep the highest", () => {
  const disease = { type: "Disease", identifier: "MESH:D011471", name: "d" };
  const graph = normalizePubTatorDocument(
    document([
      relation("R1", "Association", gene("1"), disease, "0.5"),
      relation("R2", "Association", gene("2"), disease),
      relation("R3", "Association", gene("1"), disease, "0.8"),
      relation("R4", "Association", gene("3"), disease, "0.49"),
    ]),
    { minScore: 0.5 },
  );
  // associated_with is symmetric, so the ends are sorted: the MeSH ID comes first.
  expect(
    graph.relations.map(({ subject, object, score }) => [
      subject,
      object,
      score,
    ]),
  ).toEqual([
    ["mesh:D011471", "ncbigene:1", 0.8],
    ["mesh:D011471", "ncbigene:2", undefined],
  ]);
  expect(graph.skipped.map(({ ref }) => ref)).toEqual(["1:R4"]);
});

test("annotations of a type that is not read are counted in skipped", () => {
  const graph = normalizePubTatorDocument(
    document(
      [],
      [
        { infons: { type: "Species", identifier: "9606" }, text: "men" },
        { infons: { type: "Species", identifier: "9606" }, text: "patients" },
        { infons: { type: "Chromosome", identifier: "17" }, text: "17q" },
      ],
    ),
  );
  expect(graph.entities).toEqual([]);
  expect(graph.skipped).toEqual([
    { ref: "1", type: "Species", reason: "2 Species annotations left out" },
    {
      ref: "1",
      type: "Chromosome",
      reason: "1 Chromosome annotation of a type not read",
    },
  ]);
});

test("dbSNP IDs are lowercase, so RS123 and rs123 are one", () => {
  const graph = normalizePubTatorDocument(
    document(
      [],
      [
        { infons: { type: "SNP", identifier: "RS123" }, text: "a" },
        { infons: { type: "SNP", identifier: "rs123" }, text: "b" },
      ],
    ),
  );
  expect(graph.entities.map(({ id }) => id)).toEqual(["dbsnp:rs123"]);
});

test("an annotation without ID whose name has nothing left is no entity", () => {
  const graph = normalizePubTatorDocument(
    document(
      [],
      [
        { infons: { type: "Disease", identifier: "-" }, text: "(C61)" },
        { infons: { type: "Disease", identifier: "-" }, text: "–" },
        { infons: { type: "Disease", identifier: "-" }, text: "tumour" },
      ],
    ),
  );
  expect(graph.entities.map(({ key }) => key)).toEqual(["name:tumour"]);
});
