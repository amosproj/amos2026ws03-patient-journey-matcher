import { setTimeout as sleep } from "node:timers/promises";
import type { Indexer } from "@matcher/core";
import { indexChangedDocuments, type Queryable } from "@matcher/db";
import { ZodError } from "zod";
import { normalizePubTatorDocument, pubTatorDocuments } from "./pubtator.ts";
import { ensureGraphSchema, type Paper } from "./schema.ts";

const EXPORT =
  "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/publications/export/biocjson";
const USER_AGENT =
  "patient-journey-matcher/0.1 (+https://github.com/amosproj/amos2026ws03-patient-journey-matcher)";
const ATTEMPTS = 3;
type RequestExport = (url: string, init?: RequestInit) => Promise<Response>;
type Wait = (ms: number) => Promise<void>;

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, Math.min(60_000, ms));
  }
  return 1_000 * 2 ** (attempt - 1);
}

/** Keep only entities with shared IDs and the relations between them. */
export function paperFromAnnotations(input: unknown): Paper {
  const graph = normalizePubTatorDocument(input);
  const entities: Paper["entities"] = Object.create(null);
  for (const { id, name, names, type, inTitle } of graph.entities) {
    if (id !== null) entities[id] = { name: names[0] ?? name, type, inTitle };
  }
  const relations = graph.relations.filter(
    ({ subject, object }) =>
      Object.hasOwn(entities, subject) && Object.hasOwn(entities, object),
  );
  return { entities, relations };
}

async function fetchPapers(
  pmids: string[],
  request: RequestExport,
  log: (line: string) => void,
  wait: Wait,
): Promise<Map<string, Paper>> {
  const papers = new Map<string, Paper>();
  const url = `${EXPORT}?pmids=${pmids.join(",")}`;
  let response: Response | undefined;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await request(url, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt >= ATTEMPTS) throw error;
      const delay = retryDelayMs(undefined, attempt);
      log(
        `PubTator3 request failed (attempt ${attempt}/${ATTEMPTS}), retrying in ${Math.round(delay / 1_000)} s`,
      );
      await wait(delay);
      continue;
    }
    if (response.status === 404) return papers;
    if (response.ok) break;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= ATTEMPTS)
      throw new Error(`PubTator3 export failed (HTTP ${response.status})`);
    const delay = retryDelayMs(response, attempt);
    log(
      `PubTator3 returned HTTP ${response.status} (attempt ${attempt}/${ATTEMPTS}), retrying in ${Math.round(delay / 1_000)} s`,
    );
    await wait(delay);
  }
  for (const doc of pubTatorDocuments(await response.json())) {
    const { id, pmid } = (doc ?? {}) as { id?: unknown; pmid?: unknown };
    const identifier = pmid ?? id;
    if (typeof identifier !== "string" && typeof identifier !== "number") {
      log("PubTator3 returned a document without a PMID");
      continue;
    }
    const key = String(identifier);
    if (!pmids.includes(key)) {
      log(`Ignoring unexpected PMID ${key} in PubTator3 export`);
      continue;
    }
    try {
      papers.set(key, paperFromAnnotations(doc));
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      log(
        `Invalid PubTator3 annotations for PMID ${key}: ${error.issues[0].path.join(".")}`,
      );
    }
  }
  return papers;
}

export function createGraphIndexer(
  db: Queryable,
  request: RequestExport = fetch,
  wait: Wait = sleep,
): Indexer {
  return {
    async index(log) {
      await ensureGraphSchema(db);
      let nextRequest = 0;
      let withEntities = 0;
      let withRelations = 0;
      let pubmed = 0;
      let retries = 0;
      const summary = () =>
        `PubTator3: ${pubmed} PubMed papers checked, ${withEntities} with entities, ${withRelations} with relations, ${retries} scheduled for retry`;
      const progress = setInterval(() => log(summary()), 60_000);
      try {
        await indexChangedDocuments(
          db,
          "graph.indexed_documents",
          async (documents) => {
            const pmids = documents
              .filter(
                (doc) => doc.source === "pubmed" && /^\d+$/.test(doc.native_id),
              )
              .map((doc) => doc.native_id);
            let papers = new Map<string, Paper>();
            if (pmids.length) {
              await wait(Math.max(0, nextRequest - Date.now()));
              nextRequest = Date.now() + 1_000;
              papers = await fetchPapers(pmids, request, log, wait);
              pubmed += pmids.length;
              retries += pmids.length - papers.size;
            }
            const rows = documents.map((doc) => {
              const paper =
                doc.source === "pubmed" ? papers.get(doc.native_id) : undefined;
              if (paper && Object.keys(paper.entities).length) withEntities++;
              if (paper?.relations.length) withRelations++;
              return {
                id: doc.id,
                changed: doc.changed_at,
                entities: paper?.entities ?? {},
                relations: paper?.relations ?? [],
                retry:
                  doc.source === "pubmed" &&
                  pmids.includes(doc.native_id) &&
                  !paper,
              };
            });
            // Replace each paper's entities and relations together. A slower run cannot overwrite
            // a newer version, and a document deleted during the export stays deleted.
            await db.query(
              `INSERT INTO graph.documents AS previous
          (document_id, document_changed_at, entities, relations, retry_at)
          SELECT d.id, r.changed, r.entities, r.relations,
                 CASE WHEN r.retry THEN now() + interval '7 days' ELSE 'infinity'::timestamptz END
          FROM jsonb_to_recordset($1::jsonb) AS r(id text, changed timestamptz, entities jsonb, relations jsonb, retry boolean)
          JOIN public.documents d ON d.id = r.id AND date_trunc('milliseconds', d.changed_at) <= r.changed
          ON CONFLICT (document_id) DO UPDATE SET
            document_changed_at = EXCLUDED.document_changed_at,
            retry_at = EXCLUDED.retry_at,
            entities = CASE WHEN EXCLUDED.retry_at = 'infinity' THEN EXCLUDED.entities ELSE previous.entities END,
            relations = CASE WHEN EXCLUDED.retry_at = 'infinity' THEN EXCLUDED.relations ELSE previous.relations END
          WHERE previous.document_changed_at < EXCLUDED.document_changed_at
             OR (previous.document_changed_at = EXCLUDED.document_changed_at AND previous.retry_at IS DISTINCT FROM 'infinity'::timestamptz)`,
              [JSON.stringify(rows)],
            );
          },
          50,
        );
      } finally {
        clearInterval(progress);
      }
      log(summary());
    },
  };
}
