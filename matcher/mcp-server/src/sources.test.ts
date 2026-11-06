import type { DocumentRow } from "@matcher/db";
import { expect, test } from "vitest";
import { sourceReferenceSchema } from "./contract.ts";
import { toSourceReference } from "./sources.ts";

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
    source_type: "paper",
    url: "https://pubmed.ncbi.nlm.nih.gov/42745507/",
    published_date: "2026-09",
    authors: ["A. Author", "B. Author"],
    licence: "CC-BY",
  });
  expect(sourceReferenceSchema.parse(reference)).toEqual(reference);
});

test.each([
  ["journal_article", "paper"],
  ["conference_paper", "paper"],
  ["poster", "paper"],
  ["presentation", "paper"],
  ["report", "paper"],
  ["book", "paper"],
  ["preprint", "preprint"],
  ["video", "video"],
  ["podcast_episode", "podcast"],
] as const)(
  "shows content type %s as source type %s",
  (contentType, sourceType) => {
    const reference = toSourceReference(
      document({ content_type: contentType }),
    );

    expect(reference.source_type).toBe(sourceType);
  },
);

test("leaves out the date and licence a document does not have", () => {
  const reference = toSourceReference(
    document({
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
    source_type: "paper",
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
