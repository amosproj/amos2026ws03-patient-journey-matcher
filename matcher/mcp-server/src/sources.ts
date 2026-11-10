import { type DocumentRow, publishedDate } from "@matcher/db";
import type { SourceReference } from "./contract.ts";

/** The metadata and link of a stored document, as the tool results show them. */
export function toSourceReference(document: DocumentRow): SourceReference {
  return {
    source_id: document.id,
    // A few records have no title, but every result needs one.
    title: document.title.trim() === "" ? "Untitled" : document.title,
    source: document.source,
    content_type: document.content_type,
    url: document.canonical_url,
    published_date: publishedDate(document),
    authors: document.authors.map((author) => author.name),
    licence: document.licence ?? undefined,
  };
}
