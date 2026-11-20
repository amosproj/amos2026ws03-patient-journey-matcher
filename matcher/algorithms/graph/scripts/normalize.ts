// Prints the normalized form of a patient graph or of PubTator3 annotations, to see what the
// graph approach gets from them and which names are not resolved yet:
//   pnpm --filter @matcher/graph normalize ../../../patientdata/Patient-5/graph.json
//   pnpm --filter @matcher/graph normalize fixtures/pubtator/32343890.json [--min-score 0.5]
// --json prints the whole NormalizedGraph instead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type NormalizedGraph,
  normalizePatientGraph,
  normalizePubTatorDocument,
  pubTatorDocuments,
} from "../src/index.ts";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const scoreAt = args.indexOf("--min-score");
const minScore = scoreAt === -1 ? 0 : Number(args[scoreAt + 1]);
if (file === undefined || Number.isNaN(minScore)) {
  console.error(
    "Usage: normalize <graph.json | pubtator.json> [--min-score <0-1>] [--json]",
  );
  process.exit(2);
}

// pnpm runs scripts in the package folder; a path is meant from where the command was typed.
const json = JSON.parse(
  readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"),
);
const graphs: [string, NormalizedGraph][] =
  typeof json === "object" && json !== null && "nodes" in json
    ? [[file, normalizePatientGraph(json)]]
    : pubTatorDocuments(json).map((document) => {
        const graph = normalizePubTatorDocument(document, { minScore });
        return [`PMID ${graph.entities[0]?.sources[0] ?? "?"}`, graph];
      });

if (args.includes("--json")) {
  console.log(
    JSON.stringify(
      graphs.map(([, graph]) => graph),
      null,
      1,
    ),
  );
  process.exit(0);
}

function count<T>(items: readonly T[], by: (item: T) => string): string {
  // One line per distinct value, most frequent first.
  const counts = new Map<string, number>();
  for (const item of items)
    counts.set(by(item), (counts.get(by(item)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `  ${n} ${key}`)
    .join("\n");
}

for (const [title, graph] of graphs) {
  const resolved = graph.entities.filter(({ id }) => id !== null);
  const name = new Map(
    graph.entities.map((entity) => [entity.key, entity.name]),
  );
  console.log(`\n${title}`);
  console.log(
    `\nEntities: ${resolved.length} of ${graph.entities.length} with an ID`,
  );
  for (const entity of graph.entities) {
    const id = entity.id ?? "(no ID)";
    const by = entity.resolvedBy ?? "-";
    console.log(
      `  ${id.padEnd(18)} ${by.padEnd(8)} ${entity.type.padEnd(9)} ${entity.names.join(" / ")}`,
    );
  }
  if (graph.facts.length > 0) {
    console.log(`\nPatient facts: ${graph.facts.length}`);
    console.log(
      `${count(graph.facts, (fact) => `${fact.kind} ${name.get(fact.entity)} (${fact.status})`)}`,
    );
  }
  console.log(`\nRelations: ${graph.relations.length}`);
  console.log(
    `${count(
      graph.relations,
      (relation) =>
        `${name.get(relation.subject)} ${relation.predicate} ${name.get(relation.object)} (${relation.status}${relation.score === undefined ? "" : `, ${relation.score}`})`,
    )}`,
  );
  if (graph.skipped.length > 0) {
    console.log(`\nLeft out: ${graph.skipped.length}`);
    console.log(`${count(graph.skipped, ({ reason }) => reason)}`);
  }
}
