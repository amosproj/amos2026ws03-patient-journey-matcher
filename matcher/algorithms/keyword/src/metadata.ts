import {
  indexChangedDocuments,
  metadataText,
  type Queryable,
} from "@matcher/db";
import { createSchema } from "./schema.ts";

/** Indexes title, abstract and subjects of the new and changed documents; returns how many. */
export async function indexMetadata(db: Queryable): Promise<number> {
  await createSchema(db);
  return indexChangedDocuments(db, "keyword.documents", async (documents) => {
    await db.query(
      `INSERT INTO keyword.documents (document_id, document_changed_at, content)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[])
       ON CONFLICT (document_id) DO UPDATE
       SET document_changed_at = EXCLUDED.document_changed_at, content = EXCLUDED.content`,
      [
        documents.map((document) => document.id),
        documents.map((document) => document.changed_at),
        documents.map(metadataText),
      ],
    );
  });
}
