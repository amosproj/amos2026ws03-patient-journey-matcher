import {
  createTestDatabase,
  type TestDatabase,
  testDatabaseUrl,
} from "@matcher/db/testing";
import type { FullText, Locator } from "@matcher/download";
import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  onTestFinished,
  test,
  vi,
} from "vitest";
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

  test("indexes the keywords of English full texts and downloads failed ones again", async () => {
    await insert("pubmed:1", "Olaparib in prostate cancer", {
      full_text: ["https://example.org/1.xml"],
    });
    await insert("pubmed:2", "Heart failure");
    await insert("pubmed:3", "Radiotherapy", {
      full_text: ["https://example.org/3.xml"],
    });
    await insert("pubmed:4", "Strahlentherapie", {
      full_text: ["https://example.org/4.xml"],
    });
    const downloader = fakeDownloader({
      "https://example.org/1.xml": "Olaparib, olaparib and PSA.",
      "https://example.org/3.xml": new Error("HTTP 503"),
      "https://example.org/4.xml":
        "Die Patienten erhielten eine Strahlentherapie.",
    });
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);

    expect(await indexFullTexts(pool, downloader, log)).toEqual({
      indexed: 1,
      skipped: 2,
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
        words: 3,
        terms: "olaparib olaparib psa",
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
      {
        document_id: "pubmed:4",
        status: "skipped",
        detail: "not English",
        url: "https://example.org/4.xml",
        media_type: "application/xml",
        words: 0,
        terms: "",
      },
    ]);

    downloader.fullText.mockClear();
    expect(await indexFullTexts(pool, downloader, log)).toEqual({
      indexed: 0,
      skipped: 0,
      failed: 1,
    });
    expect(downloader.fullText).toHaveBeenCalledOnce();
    // Each run reads as many as it counted first: all four, then the failed one again.
    expect(lines).toEqual([
      "full texts: 4 to read",
      "full texts: 1 indexed, 2 without text, 1 failed (tried again next run)",
      "full texts: 1 to read",
      "full texts: 0 indexed, 0 without text, 1 failed (tried again next run)",
    ]);
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

  test("logs the full texts to read, every minute how many are read, and counts late ones in", async () => {
    // Only the interval: the database client keeps its own timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    await insert("pubmed:1", "Olaparib");
    // Slow downloads, e.g. arXiv at one request every 15 s, each finished by the test.
    const finish: (() => void)[] = [];
    let started = () => {};
    const nextDownload = () =>
      new Promise<void>((resolve) => {
        started = resolve;
      });
    const downloader = {
      fullText: async (): Promise<FullText> => {
        await new Promise<void>((resolve) => {
          finish.push(resolve);
          started();
        });
        return { status: "failed", text: "", detail: "HTTP 503" };
      },
    };
    const lines: string[] = [];

    let download = nextDownload();
    const indexing = indexFullTexts(pool, downloader, (line) =>
      lines.push(line),
    );
    await download;
    await insert("pubmed:2", "Olaparib dosing"); // a crawl stores one more meanwhile
    vi.advanceTimersByTime(60_000);
    download = nextDownload();
    finish[0]?.();
    await download;
    vi.advanceTimersByTime(60_000);
    finish[1]?.();
    await indexing;
    vi.advanceTimersByTime(60_000);

    expect(lines).toEqual([
      "full texts: 1 to read",
      "full texts: 0 of 1 read",
      "full texts: 1 of 2 read",
      "full texts: 0 indexed, 0 without text, 2 failed (tried again next run)",
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

  test("traces its settings, terms, rankings and candidates", async () => {
    await insert("pubmed:1", "Prostate cancer care", {
      full_text: ["https://example.org/1.xml"],
    });
    await insert("pubmed:2", "Olaparib dosing");
    await insert("pubmed:3", "Heart failure care");
    await indexMetadata(pool);
    await indexFullTexts(
      pool,
      fakeDownloader({
        "https://example.org/1.xml": "Olaparib for prostate cancer",
      }),
    );
    const matcher = createKeywordMatcher(pool);
    const state = {
      focus: event("Olaparib nach 3"),
      context: [event("Prostatakarzinom")],
    };
    const options = { limit: 10, tuning: { focusWeight: 2 } };
    const steps = new Map<string, unknown>();

    const hits = await matcher.match(state, {
      ...options,
      trace: (step, data) => steps.set(step, data),
    });

    expect(hits).toEqual(await matcher.match(state, options));
    expect([...steps.keys()]).toEqual([
      "settings",
      "terms",
      "rankings",
      "candidates",
    ]);
    expect(steps.get("settings")).toContainEqual({
      name: "focusWeight",
      value: 2,
      default: 3,
      min: 1,
      max: 20,
      whole: true,
    });
    expect(steps.get("terms")).toEqual({
      focus: ["olaparib"],
      context: ["prostate cancer"],
      query: "olaparib olaparib prostate cancer",
      events: [
        {
          id: "Olaparib nach 3",
          words: [
            { word: "olaparib", term: "olaparib" },
            { word: "nach", term: null },
            { word: "3", term: null },
          ],
        },
        {
          id: "Prostatakarzinom",
          words: [{ word: "prostatakarzinom", term: "prostate cancer" }],
        },
      ],
    });
    expect(steps.get("rankings")).toMatchObject({ fullTexts: ["pubmed:1"] });
    const candidates = steps.get("candidates") as {
      id: string;
      score: number | null;
    }[];
    expect(candidates.find(({ id }) => id === "pubmed:1")).toMatchObject({
      hasFullText: true,
      fullTextRank: 1,
      metadataTerms: ["prostate cancer"],
      fullTextTerms: ["olaparib", "prostate cancer"],
    });
    // A candidate that matches no term is dropped: it has no score.
    expect(
      candidates.filter(({ score }) => score !== null).map(({ id }) => id),
    ).toEqual(hits.map((hit) => hit.documentId));
  });

  test("ranks by other constants when tuned, and refuses values out of range", async () => {
    // Each leads one index and is second in the other.
    await insert("pubmed:1", "Olaparib", {
      full_text: ["https://example.org/1.xml"],
    });
    await insert("pubmed:2", "Prostate cancer care", {
      full_text: ["https://example.org/2.xml"],
    });
    await indexMetadata(pool);
    await indexFullTexts(
      pool,
      fakeDownloader({
        "https://example.org/1.xml": "Prostate cancer and the kidney",
        "https://example.org/2.xml": "Olaparib and olaparib for the patient",
      }),
    );
    const matcher = createKeywordMatcher(pool);
    const state = {
      focus: event("Olaparib"),
      context: [event("Prostatakarzinom")],
    };
    const ids = async (tuning?: Record<string, number>) =>
      (await matcher.match(state, { limit: 10, tuning })).map(
        (hit) => hit.documentId,
      );

    // A tie, in the order of the IDs.
    expect(await ids()).toEqual(["pubmed:1", "pubmed:2"]);
    expect(await ids({ fullTextWeight: 5 })).toEqual(["pubmed:2", "pubmed:1"]);
    await expect(ids({ candidates: 0 })).rejects.toThrow(
      "candidates must be a whole number from 1 to 1000, not 0",
    );
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
