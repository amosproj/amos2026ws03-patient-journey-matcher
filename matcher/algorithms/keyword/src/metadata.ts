import {
  indexChangedDocuments,
  metadataText,
  type Queryable,
} from "@matcher/db";
import { englishMetadata, NON_ENGLISH_METADATA } from "./language.ts";
import { createSchema } from "./schema.ts";

/** Indexes title, abstract and subjects of the new and changed documents; returns how many. */
export async function indexMetadata(db: Queryable): Promise<number> {
  await createSchema(db);
  await db.query(`UPDATE keyword.documents k SET content = '' FROM documents d
    WHERE k.document_id = d.id AND k.content <> '' AND ${NON_ENGLISH_METADATA}`);
  return indexChangedDocuments(db, "keyword.documents", async (documents) => {
    await db.query(
      `INSERT INTO keyword.documents (document_id, document_changed_at, content)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[])
       ON CONFLICT (document_id) DO UPDATE
       SET document_changed_at = EXCLUDED.document_changed_at, content = EXCLUDED.content`,
      [
        documents.map((document) => document.id),
        documents.map((document) => document.changed_at),
        documents.map((document) =>
          englishMetadata(document) ? metadataText(document) : "",
        ),
      ],
    );
  });
}
