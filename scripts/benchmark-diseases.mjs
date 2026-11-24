// Run and pool local MCP calls. Reproduction commands are in research/matching-evaluation.md.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadGrades,
  mergeGrades,
} from "../matcher/evaluation/src/judgments.ts";
import { ndcgAt } from "../matcher/evaluation/src/metrics.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const write = (file, data) =>
  writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
const evaluation = path.join(root, "matcher/evaluation");
const stored = await json(path.join(evaluation, "keyword-llm-judgments.json"));
const points = Object.entries(stored.points).map(([id, { as_of }]) => ({
  id,
  as_of,
  group: "prostate",
  patient: `Patient-${id.split("-")[1]}`,
  diagnosis: "mesh:D011471",
}));
const cases = await json(path.join(evaluation, "disease-cases.json"));
for (const [patient, info] of Object.entries(cases)) {
  const journey = await json(
    path.join(root, "patientdata", patient, "timeline.json"),
  );
  for (const event of journey.events)
    points.push({
      patient,
      group: patient,
      id: `${patient}-${event.id}`,
      as_of: event.date,
      ...info,
    });
}
const [command, directory, ...args] = process.argv.slice(2);
if (!directory)
  throw Error(
    "Expected run|score OUT [CHECKOUT graph|keyword LABEL development|prostate|holdout|regression|all]",
  );

if (command === "run") {
  const [checkout, algorithm, label, subset] = args;
  if (subset === "regression") {
    points.length = 0;
    for (let n = 11; n <= 20; n++) {
      const patient = `Patient-${n}`;
      const timeline = await json(
        path.join(root, "patientdata", patient, "timeline.json"),
      );
      const as_of = timeline.events
        .map((event) => event.date)
        .sort()
        .at(-1);
      points.push({
        patient,
        as_of,
        id: patient,
        group: "regression",
        diagnosis: "mesh:D011471",
      });
    }
  }
  if (
    !["graph", "keyword"].includes(algorithm) ||
    !label ||
    !["development", "prostate", "holdout", "all", "regression"].includes(
      subset,
    )
  )
    throw Error(
      "Expected CHECKOUT graph|keyword LABEL development|prostate|holdout|regression|all",
    );
  const matcher = path.resolve(checkout, "matcher");
  const require = createRequire(path.join(matcher, "mcp-server/package.json"));
  const { Client } = require("@modelcontextprotocol/client");
  const { InMemoryTransport } = require("@modelcontextprotocol/server");
  const source = (relative) =>
    import(pathToFileURL(path.join(matcher, relative)));
  const { createApproaches } = await source("approaches/src/registry.ts");
  const { createDocumentStore, createPool } = await source("db/src/index.ts");
  const { createDownloader } = await source("download/src/downloader.ts");
  const { createMatchService } = await source("mcp-server/src/match.ts");
  const { buildServer } = await source("mcp-server/src/server.ts");
  const pool = createPool(process.env.DATABASE_URL || localDatabaseUrl());
  const { matchJourneyInputSchema } = await source(
    "mcp-server/src/contract.ts",
  );
  const service = createMatchService(
    createApproaches({ db: pool, downloader: createDownloader() }),
    createDocumentStore(pool),
  );
  const client = new Client({ name: "benchmark", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(service);
  const records = [];
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    const snapshot = async () =>
      (
        await pool.query(`
      SELECT count(*)::int AS documents,
             md5(string_agg(id || changed_at::text, ',' ORDER BY id)) AS version,
             (SELECT md5(string_agg(md5((document_id, entities, relations, mesh)::text), '' ORDER BY document_id))
                FROM graph.documents) AS graph,
             (SELECT md5(string_agg(md5((document_id, content)::text), '' ORDER BY document_id))
                FROM keyword.documents) AS metadata,
             (SELECT md5(string_agg(md5((document_id, status, terms)::text), '' ORDER BY document_id))
                FROM keyword.full_texts) AS full_texts
        FROM documents
    `)
      ).rows[0];
    const corpus = await snapshot();
    for (const point of points) {
      const split = point.holdout
        ? "holdout"
        : point.group === "prostate"
          ? "prostate"
          : "development";
      if (subset !== "regression" && subset !== "all" && split !== subset)
        continue;
      for (const form of ["graph", "timeline"]) {
        const input = form === "timeline" ? "journey" : form;
        const patient = await json(
          path.join(root, "patientdata", point.patient, `${form}.json`),
        );
        const request = {
          [input]: { ...patient, as_of: point.as_of },
          algorithm,
          limit: 30,
        };
        const times = [];
        let results;
        for (
          let repeat = 0;
          repeat < (split === "prostate" || subset === "regression" ? 1 : 5);
          repeat++
        ) {
          const start = performance.now();
          const reply = await client.callTool({
            name: "match_journey",
            arguments: request,
          });
          times.push(performance.now() - start);
          if (reply.isError || reply.structuredContent?.degraded)
            throw Error(
              `${point.id}: ${JSON.stringify(reply.content).slice(0, 1000)}`,
            );
          results = reply.structuredContent.results;
        }
        let diagnoses;
        if (algorithm === "graph") {
          await service.matchJourney(matchJourneyInputSchema.parse(request), {
            trace(step, data) {
              if (step === "query") diagnoses = Object.keys(data.diagnoses);
            },
          });
          if (!diagnoses)
            throw Error(`Missing graph diagnosis trace for ${point.id}`);
        }
        if (
          subset === "regression" &&
          (!results.length ||
            (diagnoses && !diagnoses.includes(point.diagnosis)))
        )
          throw Error(`Regression at ${point.id}/${form}`);
        const controls =
          point.id.endsWith("-e3") && point.controls
            ? point.controls.map((source_id) => ({
                source_id,
                rank:
                  results.find((hit) => hit.source_id === source_id)?.rank ??
                  null,
              }))
            : undefined;
        records.push({
          id: point.id,
          group: point.group,
          form,
          input_hash: createHash("sha256")
            .update(JSON.stringify(request[input]))
            .digest("hex"),
          times,
          diagnoses,
          controls,
          results: results
            .slice(0, 10)
            .map(({ source_id, title, summary }) => ({
              source_id,
              title,
              summary,
            })),
        });
      }
    }
    if (JSON.stringify(corpus) !== JSON.stringify(await snapshot()))
      throw Error("Corpus changed during run");
    if (!records.length) throw Error("No evaluation points");
    await mkdir(directory, { recursive: true });
    await write(path.join(directory, `${label}-${subset}.json`), {
      label,
      algorithm,
      corpus,
      records,
    });
    console.log(label, subset, corpus, `${records.length} rankings`);
  } finally {
    await client.close();
    await server.close();
    await pool.end();
  }
} else if (command === "score") {
  const files = (await readdir(directory)).filter((f) =>
    /-(prostate|development|holdout|all)\.json$/.test(f),
  );
  if (!files.length) throw Error("No rankings");
  const loaded = await Promise.all(
    ["graph-llm-judgments", "keyword-llm-judgments", "disease-judgments"].map(
      (name) => loadGrades(path.join(evaluation, `${name}.json`)),
    ),
  );
  const grades = new Map(
    mergeGrades(loaded).points.map(({ id, judgments }) => [
      id,
      new Map(judgments.map(({ source_id, grade }) => [source_id, grade])),
    ]),
  );
  const blind = new Map();
  const rows = new Map();
  const snapshots = new Set();
  const inputs = new Map();
  for (const file of files.sort()) {
    const { label, algorithm, records, corpus } = await json(
      path.join(directory, file),
    );
    snapshots.add(JSON.stringify(corpus));
    for (const {
      id,
      group,
      form,
      input_hash,
      times,
      diagnoses,
      results,
    } of records) {
      const inputKey = JSON.stringify([id, form]);
      if (inputs.has(inputKey) && inputs.get(inputKey) !== input_hash)
        throw Error(`Patient input differs across runs for ${inputKey}`);
      inputs.set(inputKey, input_hash);
      const point = points.find((p) => p.id === id);
      if (!point || point.group !== group)
        throw Error(`Unknown evaluation point ${id}`);
      const rowKey = JSON.stringify([group, form, label]);
      const row = rows.get(rowKey) ?? {
        group,
        form,
        label,
        points: new Set(),
        correct: 0,
        graph: algorithm === "graph",
        empty: 0,
        dcg: 0,
        off: 0,
        hits: 0,
        missing: 0,
        relevant: 0,
        times: [],
      };
      if (row.points.has(id))
        throw Error(`Duplicate ranking for ${rowKey}/${id}`);
      row.points.add(id);
      row.times.push(...times);
      row.correct += Number(diagnoses?.includes(point.diagnosis) ?? false);
      row.empty += Number(!results.length);
      row.hits += results.length;
      const judged = grades.get(id) ?? new Map();
      row.relevant += Number(
        results.some((item) => (judged.get(item.source_id) ?? 0) >= 2),
      );
      row.dcg += ndcgAt(
        10,
        results.map((item) => item.source_id),
        judged,
      );
      for (const { source_id, title, summary } of results) {
        row.off += Number(judged.get(source_id) === 0);
        if (judged.has(source_id)) continue;
        row.missing++;
        const key = createHash("sha256")
          .update(`${id}/${source_id}`)
          .digest("hex");
        blind.set(key, {
          id,
          as_of: point.as_of,
          patient: point.patient,
          source_id,
          title,
          summary,
        });
      }
      rows.set(rowKey, row);
    }
  }
  if (snapshots.size !== 1) throw Error("Corpus differs across runs");
  await write(
    path.join(directory, "blind.json"),
    [...blind].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item),
  );
  const summary = [...rows.values()].map((row) => {
    const expected = points.filter((point) => point.group === row.group);
    if (expected.some((point) => !row.points.has(point.id)))
      throw Error(
        "Missing evaluation points for " +
          row.group +
          "/" +
          row.form +
          "/" +
          row.label,
      );
    const sorted = row.times.sort((a, b) => a - b);
    const pct = (p) =>
      Number(sorted[Math.ceil(sorted.length * p) - 1].toFixed(1));
    return {
      group: row.group,
      form: row.form,
      algorithm: row.label,
      points: row.points.size,
      diagnoses: row.graph ? row.correct : null,
      empty: row.empty,
      ndcg10: row.missing ? null : +(row.dcg / row.points.size).toFixed(3),
      relevant: row.missing ? null : row.relevant,
      off: row.off,
      hits: row.hits,
      missing: row.missing,
      p50: pct(0.5),
      p95: pct(0.95),
    };
  });
  await write(path.join(directory, "summary.json"), summary);
  console.table(summary);
} else throw Error("Unknown command");

function localDatabaseUrl() {
  const env = process.env;
  if (!env.POSTGRES_DB || !env.POSTGRES_USER)
    throw Error("Set DATABASE_URL or load the repository .env");
  const url = new URL("postgresql://127.0.0.1");
  url.port = env.POSTGRES_PORT || "5432";
  url.username = env.POSTGRES_USER;
  url.password = env.POSTGRES_PASSWORD;
  url.pathname = env.POSTGRES_DB;
  return url.href;
}
