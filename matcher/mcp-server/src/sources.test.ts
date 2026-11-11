import type { DocumentRow } from "@matcher/db";
import { expect, test } from "vitest";
import { sourceDownloadsSchema, sourceReferenceSchema } from "./contract.ts";
import { toSourceDownloads, toSourceReference } from "./sources.ts";

const RETRIEVED = new Date("2026-11-01T12:00:00Z");

function document(fields: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: "pubmed:42745507",
    source: "pubmed",
    native_id: "42745507",
    version: "42745507@1",
    content_type: "journal_article",
    publication_types: ["Review"],
    title: "Salvage radiotherapy after radical prostatectomy",
    authors: [
      { name: "A. Author", orcid: null, affiliation: null },
      { name: "B. Author", orcid: null, affiliation: "Erlangen" },
    ],
    venue: "J Urol",
    summary: "Background: text",
    language: "en",
    subjects: [],
    published_at: "2026-09-01",
    published_precision: "month",
    source_updated_at: null,
    duration_seconds: null,
    canonical_url: "https://pubmed.ncbi.nlm.nih.gov/42745507/",
    doi: "10.1000/x",
    external_ids: {},
    licence: "CC-BY",
    full_text: [],
    found_by: [{ topic: "prostate_cancer", query: "prostate cancer" }],
    retrieved_at: RETRIEVED,
    expires_at: null,
    extra: {},
    created_at: RETRIEVED,
    changed_at: RETRIEVED,
    ...fields,
  };
}

test("shows a stored document with the fields of a tool result", () => {
  const reference = toSourceReference(document());

  expect(reference).toEqual({
    source_id: "pubmed:42745507",
    title: "Salvage radiotherapy after radical prostatectomy",
    source: "pubmed",
    content_type: "journal_article",
    url: "https://pubmed.ncbi.nlm.nih.gov/42745507/",
    summary: "Background: text",
    published_date: "2026-09",
    authors: ["A. Author", "B. Author"],
    licence: "CC-BY",
  });
  expect(sourceReferenceSchema.parse(reference)).toEqual(reference);
});

test("leaves out the summary, date and licence a document does not have", () => {
  const reference = toSourceReference(
    document({
      summary: null,
      published_at: null,
      published_precision: null,
      licence: null,
      authors: [],
    }),
  );

  expect(JSON.parse(JSON.stringify(reference))).toEqual({
    source_id: "pubmed:42745507",
    title: "Salvage radiotherapy after radical prostatectomy",
    source: "pubmed",
    content_type: "journal_article",
    url: "https://pubmed.ncbi.nlm.nih.gov/42745507/",
    authors: [],
  });
  expect(sourceReferenceSchema.safeParse(reference).success).toBe(true);
});

test.each(["", "  "])("gives a document without a title one (%j)", (title) => {
  const reference = toSourceReference(document({ title }));

  expect(reference.title).toBe("Untitled");
  expect(sourceReferenceSchema.safeParse(reference).success).toBe(true);
});

test("shows the thumbnail of a video as its picture", () => {
  const thumbnail = "https://i.ytimg.com/vi/abc/mqdefault.jpg";

  const reference = toSourceReference(document({ extra: { thumbnail } }));

  expect(reference.image_url).toBe(thumbnail);
  expect(sourceReferenceSchema.safeParse(reference).success).toBe(true);
});

test.each(["not a url", 42])(
  "leaves out a thumbnail that is not a URL (%j)",
  (thumbnail) => {
    const reference = toSourceReference(document({ extra: { thumbnail } }));

    expect(reference.image_url).toBeUndefined();
  },
);

const HTML = {
  kind: "html",
  url: "https://arxiv.org/html/2007.05098v1",
  media_type: "text/html",
  size: null,
  checksum: null,
  language: null,
};
const PDF = {
  kind: "pdf",
  url: "https://arxiv.org/pdf/2007.05098v1",
  media_type: "application/pdf",
  size: 2_400_000,
  checksum: "md5:a632426766c58a1f20a6cc2f9b1a5190",
  language: "en",
};

test("lists the files of a document as download links, in the stored order", () => {
  const stored = document({ full_text: [HTML, PDF] });

  const source = toSourceDownloads(stored);

  expect(JSON.parse(JSON.stringify(source))).toEqual({
    ...toSourceReference(stored),
    downloads: [
      { url: HTML.url, kind: "html", media_type: "text/html" },
      {
        url: PDF.url,
        kind: "pdf",
        media_type: "application/pdf",
        size: 2_400_000,
      },
    ],
  });
  expect(sourceDownloadsSchema.safeParse(source).success).toBe(true);
});

test("answers a document without files with an empty list", () => {
  expect(toSourceDownloads(document()).downloads).toEqual([]);
});

test("leaves out a file whose link is not a URL", () => {
  const source = toSourceDownloads(
    document({ full_text: [{ ...HTML, url: "episode 12.vtt" }, PDF] }),
  );

  expect(source.downloads.map(({ url }) => url)).toEqual([PDF.url]);
});
