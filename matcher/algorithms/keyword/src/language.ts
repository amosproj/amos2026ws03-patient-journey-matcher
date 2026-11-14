import type { DocumentRow } from "@matcher/db";

/** Unknown metadata remains matchable; the source language can describe a different text. */
export function englishMetadata(document: Pick<DocumentRow, "extra">): boolean {
  const language = document.extra.metadata_language;
  return (
    typeof language !== "string" ||
    language === "" ||
    /^en(?:-|$)/i.test(language)
  );
}

/** Same policy for already stored index rows, including rows built before language filtering. */
export const NON_ENGLISH_METADATA = `jsonb_typeof(d.extra->'metadata_language') = 'string'
  AND d.extra->>'metadata_language' <> ''
  AND d.extra->>'metadata_language' !~* '^en(-|$)'`;
