import { type DocumentRow, publishedDate } from "@matcher/db";
import {
  downloadSchema,
  type SourceDownloads,
  type SourceReference,
  sourceReferenceSchema,
} from "./contract.ts";

// A few Zenodo descriptions are whole papers of up to 40,000 characters.
const MAX_SUMMARY = 5000;
// One Zenodo record has 1,383 files, the slices of a CT scan; all others have 9 or fewer.
const MAX_DOWNLOADS = 20;

/** The start of a summary that is too long, ending in "…". */
function cut(summary: string): string {
  if (summary.length <= MAX_SUMMARY) return summary;
  // Not through the middle of a character of two code units, e.g. an emoji.
  const start = summary
    .slice(0, MAX_SUMMARY - 1)
    .replace(/[\uD800-\uDBFF]$/, "");
  return `${start}…`;
}

/** The metadata and link of a stored document, as the tool results show them. */
export function toSourceReference(document: DocumentRow): SourceReference {
  return {
    source_id: document.id,
    // A few records have no title, but every result needs one.
    title: document.title.trim() === "" ? "Untitled" : document.title,
    source: document.source,
    content_type: document.content_type,
    url: document.canonical_url,
    summary: document.summary === null ? undefined : cut(document.summary),
    // The crawler stores a thumbnail for YouTube videos only. Checked, because a value that is
    // not a web link would fail the whole answer.
    image_url: sourceReferenceSchema.shape.image_url.safeParse(
      document.extra.thumbnail,
    ).data,
    published_date: publishedDate(document),
    authors: document.authors.map((author) => author.name),
    licence: document.licence ?? undefined,
  };
}

/** A stored document for `get_source`: its reference and its files at the origin, as stored. */
export function toSourceDownloads(document: DocumentRow): SourceDownloads {
  return {
    ...toSourceReference(document),
    // The crawler does not check locators, and one bad entry would fail the whole answer.
    downloads: document.full_text
      .flatMap(({ url, kind, media_type, size }) => {
        const download = downloadSchema.safeParse({
          url,
          kind,
          media_type: media_type ?? undefined,
          size: size ?? undefined,
        });
        return download.success ? [download.data] : [];
      })
      .slice(0, MAX_DOWNLOADS),
  };
}
