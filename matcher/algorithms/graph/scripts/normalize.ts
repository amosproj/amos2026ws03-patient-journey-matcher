// Prints the normalized form of a patient graph or of PubTator3 annotations, to see what the
// graph approach gets from them and which names are not resolved yet:
//   pnpm --dir matcher --filter @matcher/graph normalize patientdata/Patient-5/graph.json
//   pnpm --dir matcher --filter @matcher/graph normalize \
//     matcher/algorithms/graph/fixtures/pubtator/32343890.json [--min-score 0.5]
// Paths are from where the command is typed. --json prints the whole NormalizedGraph instead.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type NormalizedGraph,
  normalizePatientGraph,
  normalizePubTatorDocument,
  pubTatorDocuments,
} from "../src/index.ts";

const USAGE =
  "Usage: normalize <graph.json | pubtator.json> [--min-score <0-1>] [--json]";
function usage(message?: string): never {
  console.error(message === undefined ? USAGE : `${message}\n${USAGE}`);
  process.exit(2);
}

// The file may stand before or after the options: `--min-score 0.5 file.json` works too.
function parseOptions() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: { "min-score": { type: "string" }, json: { type: "boolean" } },
    });
  } catch (error) {
    return usage((error as Error).message);
  }
}
const parsed = parseOptions();
const [file] = parsed.positionals;
const minScore = Number(parsed.values["min-score"] ?? 0);
if (
  file === undefined ||
  parsed.positionals.length > 1 ||
  !Number.isFinite(minScore) ||
  minScore < 0 ||
  minScore > 1
) {
  usage();
}

// pnpm runs scripts in the package folder; a path is meant from where the command was typed.
const json = JSON.parse(
  readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), file), "utf8"),
);
const graphs: [string, NormalizedGraph][] =
  typeof json === "object" && json !== null && "nodes" in json
    ? [[file, normalizePatientGraph(json)]]
    : pubTatorDocuments(json).map((document) => {
        const { pmid, id } = (document ?? {}) as {
          pmid?: unknown;
          id?: unknown;
        };
        const graph = normalizePubTatorDocument(document, { minScore });
        return [`PMID ${String(pmid ?? id ?? "?")}`, graph];
      });

// No process.exit after printing: on a pipe, stdout is written asynchronously and would be cut.
if (parsed.values.json === true) {
  console.log(
    JSON.stringify(
      graphs.map(([, graph]) => graph),
      null,
      1,
    ),
  );
} else {
  printSummary();
}

/** One line per distinct value, most frequent first. */
function count<T>(items: readonly T[], by: (item: T) => string): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = by(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `  ${n} ${key}`)
    .join("\n");
}

function printSummary(): void {
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
        count(
          graph.facts,
          (fact) => `${fact.kind} ${name.get(fact.entity)} (${fact.status})`,
        ),
      );
    }
    console.log(`\nRelations: ${graph.relations.length}`);
    console.log(
      count(
        graph.relations,
        (relation) =>
          `${name.get(relation.subject)} ${relation.predicate} ${name.get(relation.object)} (${relation.status}${relation.score === undefined ? "" : `, ${relation.score}`})`,
      ),
    );
    if (graph.skipped.length > 0) {
      console.log(`\nLeft out: ${graph.skipped.length}`);
      console.log(count(graph.skipped, ({ reason }) => reason));
    }
  }
}
