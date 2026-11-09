import type { Hit, Matcher } from "@matcher/core";
import type { DocumentRow, DocumentStore } from "@matcher/db";
import { expect, test, vi } from "vitest";
import { createMatchService } from "./match.ts";

const RETRIEVED = new Date("2026-11-01T12:00:00Z");

function document(id: string): DocumentRow {
  return {
    id,
    source: "pubmed",
    native_id: id.split(":")[1] ?? id,
    version: null,
    content_type: "journal_article",
    publication_types: [],
    title: `Title of ${id}`,
    authors: [],
    venue: null,
    summary: null,
    language: "en",
    subjects: [],
    published_at: null,
    published_precision: null,
    source_updated_at: null,
    duration_seconds: null,
    canonical_url: `https://example.org/${id}`,
    doi: null,
    external_ids: {},
    licence: null,
    full_text: [],
    found_by: [],
    retrieved_at: RETRIEVED,
    expires_at: null,
    extra: {},
    created_at: RETRIEVED,
    changed_at: RETRIEVED,
  };
}

/** A store that has the documents with these IDs. */
function store(ids: string[]): DocumentStore {
  return {
    getDocuments: async (asked) =>
      asked.filter((id) => ids.includes(id)).map(document),
    getDocument: async (id) => (ids.includes(id) ? document(id) : undefined),
    documentsToIndex: async () => [],
    countToIndex: async () => 0,
  };
}

/** The keyword approach, its matcher answering with these hits. */
function keyword(hits: Hit[] | Error) {
  return {
    name: "keyword",
    matcher: {
      match: vi.fn<Matcher["match"]>(async () => {
        if (hits instanceof Error) throw hits;
        return hits;
      }),
    },
  };
}

const journey = {
  patient_id: "Patient-1",
  events: [
    { id: "e1", type: "lab_test", label: "PSA", date: "2026-01-10" },
    { id: "e2", type: "followup", label: "Nachsorge", date: "2026-03-01" },
  ],
};

test("answers with the stored documents of the matcher's hits, in its order", async () => {
  const approach = keyword([
    { documentId: "pubmed:2", score: 1, matchedTerms: ["psa"] },
    { documentId: "pubmed:9", score: 0.8 },
    { documentId: "pubmed:1", score: 0.5 },
  ]);
  const service = createMatchService(
    [approach],
    store(["pubmed:1", "pubmed:2"]),
  );

  const result = await service.matchJourney({
    journey,
    algorithm: "keyword",
    limit: 10,
    content_types: ["journal_article"],
  });

  expect(approach.matcher.match).toHaveBeenCalledWith(
    { focus: journey.events[1], context: [journey.events[0]] },
    { limit: 10, contentTypes: ["journal_article"] },
  );
  expect(result).toMatchObject({
    algorithm: "keyword",
    focus_event_id: "e2",
    degraded: false,
    results: [
      { rank: 1, source_id: "pubmed:2", score: 1, matched_terms: ["psa"] },
      { rank: 2, source_id: "pubmed:1", score: 0.5 },
    ],
  });
});

test("answers degraded when the matcher fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const service = createMatchService(
    [keyword(new Error("relation does not exist"))],
    store([]),
  );

  const result = await service.matchJourney({
    journey,
    algorithm: "keyword",
    limit: 10,
  });

  expect(result).toEqual({
    algorithm: "keyword",
    focus_event_id: "e2",
    results: [],
    degraded: true,
    degraded_reason: "The keyword index could not be searched.",
  });
});

test("refuses an algorithm without a matcher", async () => {
  const service = createMatchService([keyword([])], store([]));

  await expect(
    service.matchJourney({ journey, algorithm: "graph", limit: 10 }),
  ).rejects.toMatchObject({ code: "NOT_AVAILABLE" });
});
