import { type ContentType, type DocumentRow, publishedDate } from "@matcher/db";
import type { SourceReference } from "./contract.ts";

// Until #7 replaces `source_type` with `content_type` (Documentation/sources/README.md §4).
const SOURCE_TYPES = {
  journal_article: "paper",
  conference_paper: "paper",
  poster: "paper",
  presentation: "paper",
  report: "paper",
  book: "paper",
  preprint: "preprint",
  video: "video",
  podcast_episode: "podcast",
} as const satisfies Record<ContentType, SourceReference["source_type"]>;

/** The metadata and link of a stored document, as the tool results show them. */
export function toSourceReference(document: DocumentRow): SourceReference {
  return {
    source_id: document.id,
    // A few records have no title, but every result needs one.
    title: document.title.trim() === "" ? "Untitled" : document.title,
    source: document.source,
    source_type: SOURCE_TYPES[document.content_type],
    url: document.canonical_url,
    published_date: publishedDate(document),
    authors: document.authors.map((author) => author.name),
    licence: document.licence ?? undefined,
  };
}
