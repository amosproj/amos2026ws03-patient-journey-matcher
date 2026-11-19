import type { DocumentRow } from "./documents.ts";

/** Unknown metadata remains matchable; the source language can describe a different text. */
export function englishMetadata(document: Pick<DocumentRow, "extra">): boolean {
  const language = document.extra.metadata_language;
  return (
    typeof language !== "string" ||
    language === "" ||
    /^en(?:-|$)/i.test(language)
  );
}

/** The same rule in SQL, for a document `d`: true if its metadata is known not to be English. */
export const NON_ENGLISH_METADATA = `jsonb_typeof(d.extra->'metadata_language') = 'string'
  AND d.extra->>'metadata_language' <> ''
  AND d.extra->>'metadata_language' !~* '^en(-|$)'`;
