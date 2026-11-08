import {
  createDocumentStore,
  type DocumentRow,
  type Queryable,
} from "@matcher/db";
import { createSchema } from "./schema.ts";

const BATCH_SIZE = 500;

/** Indexes the metadata of the new and changed documents; returns how many. */
export async function indexMetadata(db: Queryable): Promise<number> {
  await createSchema(db);
  const store = createDocumentStore(db);
  let indexed = 0;
  for (;;) {
    const documents = await store.documentsToIndex(
      "keyword.documents",
      BATCH_SIZE,
    );
    if (documents.length === 0) return indexed;
    await db.query(
      `INSERT INTO keyword.documents (document_id, document_changed_at, content)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::text[])
       ON CONFLICT (document_id) DO UPDATE
       SET document_changed_at = EXCLUDED.document_changed_at, content = EXCLUDED.content`,
      [
        documents.map((document) => document.id),
        documents.map((document) => document.changed_at),
        documents.map(indexedText),
      ],
    );
    indexed += documents.length;
  }
}

/** Title, abstract or description, and subject labels (MeSH for PubMed). */
function indexedText(document: DocumentRow): string {
  const subjects = document.subjects.map((subject) => subject.label);
  return [document.title, document.summary ?? "", ...subjects].join("\n");
}
