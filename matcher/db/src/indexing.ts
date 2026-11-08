import {
  createDocumentStore,
  type DocumentRow,
  type Queryable,
} from "./documents.ts";

/**
 * The loop of every index: passes the documents `indexTable` has not seen or that changed since
 * to `index`, in batches, until none is left; returns how many it passed. `index` must store a
 * row with the `changed_at` it read for each document (see `documentsToIndex`); a batch it
 * left out comes back and stops the loop with an error.
 */
export async function indexChangedDocuments(
  db: Queryable,
  indexTable: string,
  index: (documents: DocumentRow[]) => Promise<void>,
  batchSize = 500,
): Promise<number> {
  const store = createDocumentStore(db);
  const passed = new Set<string>();
  for (;;) {
    const documents = await store.documentsToIndex(indexTable, batchSize);
    if (documents.length === 0) return passed.size;
    // A document changed during the run comes back with a new changed_at, and is passed again.
    const keys = documents.map(
      ({ id, changed_at }) => `${id}@${changed_at.getTime()}`,
    );
    if (keys.every((key) => passed.has(key))) {
      throw new Error(
        `${indexTable} has no row for ${documents.length} document(s) passed to it`,
      );
    }
    await index(documents);
    for (const key of keys) passed.add(key);
  }
}
