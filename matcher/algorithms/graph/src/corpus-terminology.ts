import type { Queryable } from "@matcher/db";
import {
  type Concept,
  createTerminology,
  type Terminology,
} from "./resolve.ts";
import { CONCEPT_NAMES } from "./schema.ts";

const cache = new WeakMap<
  Queryable,
  { expires: number; terms: Promise<Terminology> }
>();

async function readTerms(db: Queryable): Promise<Terminology> {
  const result = await db
    .query<Concept>("SELECT * FROM graph.concept_names ORDER BY id, type")
    .catch((error: unknown) => {
      // An existing index can still serve queries until its next index run builds the view.
      if (
        !(error instanceof Error && "code" in error && error.code === "42P01")
      )
        throw error;
      return db.query<Concept>(`${CONCEPT_NAMES} ORDER BY id, type`);
    });
  return createTerminology(result.rows);
}

/** A completed index run becomes visible in a running server within five minutes. */
export function loadCorpusTerminology(db: Queryable): Promise<Terminology> {
  const current = cache.get(db);
  if (current && current.expires > Date.now()) return current.terms;
  const terms = readTerms(db);
  cache.set(db, { expires: Date.now() + 300_000, terms });
  terms.catch(() => {
    if (cache.get(db)?.terms === terms) cache.delete(db);
  });
  return terms;
}
