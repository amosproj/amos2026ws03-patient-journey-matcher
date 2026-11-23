import { performance } from "node:perf_hooks";
import type { Approach } from "@matcher/core";
import {
  indexChangedDocuments,
  metadataText,
  type Queryable,
} from "@matcher/db";
import {
  configuration,
  createEncoder,
  type Encoder,
  indexTable,
  type Model,
  queryText,
} from "./encoder.ts";

export type { Model } from "./encoder.ts";
export {
  configuration,
  createEncoder,
  indexTable,
  parseModel,
  queryText,
} from "./encoder.ts";

export class SemanticNotReady extends Error {
  readonly code = "NOT_AVAILABLE";
}

export function createSemanticApproach({
  db,
  model,
  indexModels = [model],
  encoder = createEncoder(),
}: {
  db: Queryable;
  model: Model;
  indexModels?: readonly Model[];
  encoder?: Encoder;
}): Approach {
  const table = indexTable(model);
  return {
    name: "ai_summary",
    indexer: {
      async index(log) {
        for (const indexedModel of indexModels) {
          const model = indexedModel;
          const table = indexTable(model);
          await db.query(`
          SELECT pg_advisory_xact_lock(hashtext('ai_summary_schema'));
          CREATE SCHEMA IF NOT EXISTS ai_summary;
          CREATE TABLE IF NOT EXISTS ai_summary.ready (
            index_table text PRIMARY KEY
          );
          CREATE TABLE IF NOT EXISTS ${table} (
            document_id text PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
            document_changed_at timestamptz NOT NULL,
            embedding vector(1024)
          );
        `);
          let processed = 0;
          log(`${model}: indexing metadata`);
          const count = await indexChangedDocuments(
            db,
            table,
            async (documents) => {
              const texts = documents.map(metadataText);
              const inputs = texts.filter((text) => text.trim().length > 0);
              const vectors = inputs.length
                ? await encoder.encode(model, "document", inputs)
                : [];
              let position = 0;
              const values = texts.map((text) =>
                text.trim() ? JSON.stringify(vectors[position++]) : null,
              );
              // One statement commits a batch atomically. Concurrent runs cannot overwrite newer rows.
              await db.query(
                `
            INSERT INTO ${table} (document_id, document_changed_at, embedding)
            SELECT batch.id, changed, vector::vector FROM
              unnest($1::text[], $2::timestamptz[], $3::text[]) AS batch(id, changed, vector)
            JOIN public.documents AS d ON d.id = batch.id
            ON CONFLICT (document_id) DO UPDATE SET
              document_changed_at = excluded.document_changed_at,
              embedding = excluded.embedding
            WHERE ${table.split(".")[1]}.document_changed_at <= excluded.document_changed_at
          `,
                [
                  documents.map((d) => d.id),
                  documents.map((d) => d.changed_at),
                  values,
                ],
              );
              processed += documents.length;
              if (processed % 64 === 0)
                log(`${model}: ${processed} records processed`);
            },
            4,
          );
          await db.query(
            "INSERT INTO ai_summary.ready VALUES ($1) ON CONFLICT DO NOTHING",
            [table],
          );
          log(`${model}: ${count} new or changed metadata records indexed`);
        }
      },
    },
    matcher: {
      async match(state, options) {
        const ready = await db.query<{ ready: boolean }>(`
          SELECT to_regclass('ai_summary.ready') IS NOT NULL AS ready
        `);
        if (!ready.rows[0]?.ready)
          throw new SemanticNotReady(
            "Run make index-ai to build the semantic indexes.",
          );
        const indexed = await db.query(
          "SELECT 1 FROM ai_summary.ready WHERE index_table = $1",
          [table],
        );
        if (!indexed.rows.length)
          throw new SemanticNotReady(
            "Run make index-ai to build the semantic indexes.",
          );
        const started = performance.now();
        const [vector] = await encoder.encode(model, "query", [
          queryText(state),
        ]);
        const encoded = performance.now();
        const result = await db.query<{
          document_id: string;
          similarity: number;
        }>(
          `
          SELECT i.document_id, 1 - (i.embedding <=> $1::vector) AS similarity
          FROM ${table} AS i JOIN public.documents AS d ON d.id = i.document_id
          WHERE i.embedding IS NOT NULL
            AND i.document_changed_at >= date_trunc('milliseconds', d.changed_at)
            AND (d.expires_at IS NULL OR d.expires_at > now())
            AND ($2::text[] IS NULL OR d.content_type = ANY($2))
            AND (i.embedding <=> $1::vector) < 1
          ORDER BY i.embedding <=> $1::vector, i.document_id
          LIMIT $3
        `,
          [JSON.stringify(vector), options.contentTypes ?? null, options.limit],
        );
        options.trace?.("semantic", {
          ...configuration(model),
          encoder_ms: encoded - started,
          search_ms: performance.now() - encoded,
          hits: result.rows.length,
        });
        const best = result.rows[0]?.similarity ?? 1;
        return result.rows.map((row) => ({
          documentId: row.document_id,
          score: Math.min(1, Math.max(0, row.similarity / best)),
        }));
      },
    },
  };
}
