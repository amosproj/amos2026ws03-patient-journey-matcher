import type { Indexer } from "@matcher/core";
import {
  type DocumentRow,
  indexChangedDocuments,
  type Queryable,
} from "@matcher/db";
import { ZodError } from "zod";
import { normalizePubTatorDocument, pubTatorDocuments } from "./pubtator.ts";
import { ensureGraphSchema, type Paper } from "./schema.ts";

const EXPORT =
  "https://www.ncbi.nlm.nih.gov/research/pubtator3-api/publications/export/biocjson";
// One export request holds at most this many papers.
const PAPERS_PER_REQUEST = 50;

/** `get` of the shared downloader, which retries and keeps the pace of the host. */
export type Get = (
  url: string,
) => Promise<{ status: number; body?: Uint8Array }>;

/** Keep only entities with shared IDs and the relations between them. */
export function paperFromAnnotations(input: unknown): Paper {
  const graph = normalizePubTatorDocument(input);
  const entities: Paper["entities"] = Object.create(null);
  for (const { id, name, names, type, inTitle } of graph.entities) {
    if (id !== null)
      entities[id] = {
        name: names[0] ?? name,
        type,
        inTitle,
        ...(names.length > 1 && { names }),
      };
  }
  const relations = graph.relations.filter(
    ({ subject, object }) =>
      Object.hasOwn(entities, subject) && Object.hasOwn(entities, object),
  );
  return { entities, relations };
}

async function fetchPapers(
  pmids: string[],
  get: Get,
  log: (line: string) => void,
): Promise<Map<string, Paper>> {
  const papers = new Map<string, Paper>();
  const { status, body } = await get(`${EXPORT}?pmids=${pmids.join(",")}`);
  // PubTator3 answers 400 when it knows none of the PMIDs.
  if (status === 400 || status === 404) return papers;
  // The downloader omits the body of a successful response that exceeds its byte limit.
  if (status === 413 || (status >= 200 && status < 300 && !body)) {
    if (pmids.length === 1) {
      log(`PubTator3 export too large for PMID ${pmids[0]}`);
      return papers;
    }
    const middle = Math.ceil(pmids.length / 2);
    const left = await fetchPapers(pmids.slice(0, middle), get, log);
    const right = await fetchPapers(pmids.slice(middle), get, log);
    return new Map([...left, ...right]);
  }
  if (status < 200 || status >= 300 || !body) {
    throw new Error(`PubTator3 export failed (HTTP ${status})`);
  }
  const json: unknown = JSON.parse(new TextDecoder().decode(body));
  for (const doc of pubTatorDocuments(json)) {
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

export function createGraphIndexer(db: Queryable, get: Get): Indexer {
  return {
    async index(log) {
      await ensureGraphSchema(db);
      let withEntities = 0;
      let withRelations = 0;
      let pubmed = 0;
      let retries = 0;
      const summary = () =>
        `PubTator3: ${pubmed} PubMed papers checked, ${withEntities} with entities, ${withRelations} with relations, ${retries} scheduled for retry`;
      const progress = setInterval(() => log(summary()), 60_000);
      /** Asks PubTator3 about the PubMed papers among `documents` and stores a row for each one. */
      const indexPapers = async (documents: DocumentRow[]) => {
        const pmids = documents
          .filter(
            (doc) => doc.source === "pubmed" && /^\d+$/.test(doc.native_id),
          )
          .map((doc) => doc.native_id);
        let papers = new Map<string, Paper>();
        if (pmids.length) {
          papers = await fetchPapers(pmids, get, log);
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
        // Replace each paper's entities and relations together; a paper to ask for again keeps
        // its last ones. A document that changed during the export is not written and comes
        // back, one deleted meanwhile stays deleted, and a finished row of the same version stays.
        // The MeSH headings come from the stored document, so they never wait for PubTator3.
        await db.query(
          `INSERT INTO graph.documents AS previous
          (document_id, document_changed_at, entities, relations, retry_at, mesh)
          SELECT d.id, r.changed, r.entities, r.relations,
                 CASE WHEN r.retry THEN now() + interval '2 days' ELSE 'infinity'::timestamptz END,
                 graph.mesh_flags(d.source, d.subjects)
          FROM jsonb_to_recordset($1::jsonb) AS r(id text, changed timestamptz, entities jsonb, relations jsonb, retry boolean)
          JOIN public.documents d ON d.id = r.id AND date_trunc('milliseconds', d.changed_at) <= r.changed
          ON CONFLICT (document_id) DO UPDATE SET
            document_changed_at = EXCLUDED.document_changed_at,
            retry_at = EXCLUDED.retry_at,
            entities = CASE WHEN EXCLUDED.retry_at = 'infinity' THEN EXCLUDED.entities ELSE previous.entities END,
            relations = CASE WHEN EXCLUDED.retry_at = 'infinity' THEN EXCLUDED.relations ELSE previous.relations END,
            mesh = EXCLUDED.mesh
          WHERE previous.document_changed_at <> EXCLUDED.document_changed_at
             OR previous.retry_at <> 'infinity'::timestamptz`,
          [JSON.stringify(rows)],
        );
      };
      try {
        await indexChangedDocuments(
          db,
          "graph.indexed_documents",
          async (documents) => {
            for (let i = 0; i < documents.length; i += PAPERS_PER_REQUEST) {
              await indexPapers(documents.slice(i, i + PAPERS_PER_REQUEST));
            }
          },
        );
        // Include removed papers as well as new or changed annotations. Readers can keep
        // using the previous list until the complete refresh becomes visible.
        await db.query(
          "REFRESH MATERIALIZED VIEW CONCURRENTLY graph.corpus_terms",
        );
      } finally {
        clearInterval(progress);
      }
      log(summary());
    },
  };
}
