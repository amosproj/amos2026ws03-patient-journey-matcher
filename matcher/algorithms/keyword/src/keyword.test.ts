import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import type { FullText, Locator } from "@matcher/download";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { indexFullTexts } from "./full-texts.ts";
import { createKeywordMatcher } from "./matcher.ts";
import { indexMetadata } from "./metadata.ts";

const databaseUrl = testDatabaseUrl();
const LONG_AGO = new Date("2000-01-01T00:00:00Z");
const FAR_AHEAD = new Date("2999-01-01T00:00:00Z");

// A database of its own, not a schema per test: the keyword index lives in the fixed schema
// `keyword` and needs the pg_textsearch extension of its database.
describe.skipIf(!databaseUrl)("with PostgreSQL", () => {
  let pool: TestDatabase["pool"];

  beforeAll(async () => {
    const database = await createTestDatabase(databaseUrl as string);
    pool = database.pool;
    return () => database.drop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE documents CASCADE");
  });

  /** A journey event with this label. */
  function event(label: string) {
    return { id: label, type: "followup", label, date: "2026-01-01" };
  }

  /** Stores a document as the crawler would, with the columns the index reads. */
  async function insert(
    id: string,
    title: string,
    fields: {
      content_type?: string;
      summary?: string;
      expires_at?: Date;
      full_text?: string[];
    } = {},
  ) {
    const [source, nativeId] = id.split(":");
    await pool.query(
      `INSERT INTO documents (id, source, native_id, content_type, title, summary, subjects,
                              canonical_url, retrieved_at, expires_at, full_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9, $10)`,
      [
        id,
        source,
        nativeId,
        fields.content_type ?? "journal_article",
        title,
        fields.summary ?? null,
        JSON.stringify([
          { scheme: "mesh", label: "Humans", id: null, major: false },
        ]),
        `https://example.org/${id}`,
        fields.expires_at ?? null,
        JSON.stringify(
          (fields.full_text ?? []).map((url) => ({
            kind: "file",
            url,
            media_type: "application/xml",
            size: null,
          })),
        ),
      ],
    );
  }

  /** A downloader that answers by URL: the text read, or a failed download. */
  function fakeDownloader(texts: Record<string, string | Error>) {
    return {
      fullText: vi.fn(
        async (locators: readonly Locator[]): Promise<FullText> => {
          const url = locators[0]?.url;
          const text = url === undefined ? undefined : texts[url];
          if (text === undefined) {
            return { status: "skipped", text: "", detail: "no full text" };
          }
          if (text instanceof Error) {
            return { status: "failed", text: "", url, detail: text.message };
          }
          return { status: "ok", text, url, mediaType: "application/xml" };
        },
      ),
    };
  }

  test("indexes full texts as word counts and downloads failed ones again", async () => {
    await insert("pubmed:1", "Olaparib in prostate cancer", {
      full_text: ["https://example.org/1.xml"],
    });
    await insert("pubmed:2", "Heart failure");
    await insert("pubmed:3", "Radiotherapy", {
      full_text: ["https://example.org/3.xml"],
    });
    const downloader = fakeDownloader({
      "https://example.org/1.xml": "Olaparib, olaparib and PSA.",
      "https://example.org/3.xml": new Error("HTTP 503"),
    });

    expect(await indexFullTexts(pool, downloader)).toEqual({
      indexed: 1,
      skipped: 1,
      failed: 1,
    });
    const { rows } = await pool.query(
      `SELECT document_id, status, detail, url, media_type, words, terms
       FROM keyword.full_texts ORDER BY document_id`,
    );
    expect(rows).toEqual([
      {
        document_id: "pubmed:1",
        status: "indexed",
        detail: null,
        url: "https://example.org/1.xml",
        media_type: "application/xml",
        words: 4,
        terms: "and olaparib olaparib psa",
      },
      {
        document_id: "pubmed:2",
        status: "skipped",
        detail: "no full text",
        url: null,
        media_type: null,
        words: 0,
        terms: "",
      },
      {
        document_id: "pubmed:3",
        status: "failed",
        detail: "HTTP 503",
        url: "https://example.org/3.xml",
        media_type: null,
        words: 0,
        terms: "",
      },
    ]);

    downloader.fullText.mockClear();
    expect(await indexFullTexts(pool, downloader)).toEqual({
      indexed: 0,
      skipped: 0,
      failed: 1,
    });
    expect(downloader.fullText).toHaveBeenCalledOnce();
  });

  test("ranks with the full texts too and names the terms found there", async () => {
    await insert("pubmed:1", "Prostate cancer care", {
      full_text: ["https://example.org/1.xml"],
    });
    await insert("pubmed:2", "Diabetes care", {
      full_text: ["https://example.org/2.xml"],
    });
    await insert("pubmed:3", "Heart failure care");
    await indexMetadata(pool);
    await indexFullTexts(
      pool,
      fakeDownloader({
        "https://example.org/1.xml": "Olaparib for prostate cancer",
        "https://example.org/2.xml": "Olaparib dosing in diabetes",
      }),
    );

    const hits = await createKeywordMatcher(pool).match(
      { focus: event("Olaparib"), context: [event("Prostatakarzinom")] },
      { limit: 10 },
    );

    expect(hits.map((hit) => hit.documentId)).toEqual(["pubmed:1", "pubmed:2"]);
    expect(hits.map((hit) => hit.matchedTerms)).toEqual([
      ["olaparib", "prostate cancer"],
      ["olaparib"],
    ]);
  });

  test("indexes new and changed documents once", async () => {
    await insert("pubmed:1", "Olaparib in prostate cancer");
    await insert("pubmed:2", "Heart failure in diabetes");

    expect(await indexMetadata(pool)).toBe(2);
    expect(await indexMetadata(pool)).toBe(0);

    await pool.query(
      "UPDATE documents SET summary = 'New abstract', changed_at = now() WHERE id = 'pubmed:1'",
    );
    expect(await indexMetadata(pool)).toBe(1);
  });

  test("ranks the documents that share the most focus terms first", async () => {
    await insert(
      "pubmed:1",
      "Olaparib in metastatic castration-resistant prostate cancer",
    );
    await insert(
      "pubmed:2",
      "Olaparib maintenance in BRCA-mutated breast cancer",
    );
    await insert("pubmed:3", "Heart failure in type 2 diabetes");
    await insert("pubmed:4", "Active surveillance for prostate cancer");
    await indexMetadata(pool);

    const hits = await createKeywordMatcher(pool).match(
      { focus: event("Olaparib"), context: [event("Prostatakarzinom")] },
      { limit: 10 },
    );

    expect(hits.map((hit) => hit.documentId)).toEqual([
      "pubmed:1",
      "pubmed:2",
      "pubmed:4",
    ]);
    expect(hits[0]).toMatchObject({
      score: 1,
      matchedTerms: ["olaparib", "prostate cancer"],
    });
    expect(hits[2]?.matchedTerms).toEqual(["prostate cancer"]);
  });

  test("filters by content type and leaves out expired and deleted documents", async () => {
    await insert("pubmed:1", "Prostate cancer");
    await insert("pubmed:2", "Prostate cancer screening");
    await insert("youtube:a", "Prostate cancer explained", {
      content_type: "video",
      expires_at: FAR_AHEAD,
    });
    await insert("youtube:b", "Prostate cancer treatment", {
      content_type: "video",
      expires_at: FAR_AHEAD,
    });
    await indexMetadata(pool);
    await pool.query("DELETE FROM documents WHERE id = 'pubmed:2'");
    await pool.query(
      "UPDATE documents SET expires_at = $1 WHERE id = 'youtube:b'",
      [LONG_AGO],
    );
    const matcher = createKeywordMatcher(pool);
    const state = { focus: event("Prostata"), context: [] };

    const all = await matcher.match(state, { limit: 10 });
    const videos = await matcher.match(state, {
      limit: 10,
      contentTypes: ["video"],
    });

    expect(all.map((hit) => hit.documentId).sort()).toEqual([
      "pubmed:1",
      "youtube:a",
    ]);
    expect(videos.map((hit) => hit.documentId)).toEqual(["youtube:a"]);
  });

  test("finds nothing for an event without search terms", async () => {
    await insert("pubmed:1", "Prostate cancer");
    await indexMetadata(pool);

    const hits = await createKeywordMatcher(pool).match(
      { focus: event("nach und zur"), context: [] },
      { limit: 10 },
    );

    expect(hits).toEqual([]);
  });
});
