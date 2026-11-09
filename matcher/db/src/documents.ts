import type { QueryResult, QueryResultRow } from "pg";

// Mirrors db/init/02-documents.sql. Column meanings: Documentation/sources/README.md §2,
// read rules: Documentation/storage.md.

export type SourceName = "pubmed" | "arxiv" | "zenodo" | "youtube" | "podcast";

export type ContentType =
  | "journal_article"
  | "preprint"
  | "conference_paper"
  | "poster"
  | "presentation"
  | "report"
  | "book"
  | "video"
  | "podcast_episode";

export type PublishedPrecision = "year" | "month" | "day";

export interface Author {
  name: string;
  orcid: string | null;
  affiliation: string | null;
}

export interface Subject {
  scheme: string;
  label: string;
  id: string | null;
  major: boolean | null;
}

export interface FullTextLocator {
  kind: string;
  url: string;
  media_type: string | null;
  size: number | null;
  checksum: string | null;
  language: string | null;
}

export type FoundBy =
  | { topic: string | null; query: string }
  | { cited_by: string };

/** One row of `documents`. */
export interface DocumentRow {
  id: string;
  source: SourceName;
  native_id: string;
  version: string | null;
  content_type: ContentType;
  publication_types: string[];
  title: string;
  authors: Author[];
  venue: string | null;
  summary: string | null;
  language: string | null;
  subjects: Subject[];
  /** `YYYY-MM-DD`, known to `published_precision`; see `publishedDate`. */
  published_at: string | null;
  published_precision: PublishedPrecision | null;
  source_updated_at: Date | null;
  duration_seconds: number | null;
  canonical_url: string;
  doi: string | null;
  external_ids: Record<string, string>;
  licence: string | null;
  full_text: FullTextLocator[];
  found_by: FoundBy[];
  retrieved_at: Date;
  expires_at: Date | null;
  extra: Record<string, unknown>;
  created_at: Date;
  changed_at: Date;
}

/** What the store needs of a pg `Pool`, `PoolClient` or `Client`. */
export interface Queryable {
  query<Row extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

/** Reads `documents`, which only the crawler writes. Expired rows count as gone. */
export interface DocumentStore {
  /** The document, or `undefined` if it is not stored. */
  getDocument(id: string): Promise<DocumentRow | undefined>;
  /** The stored documents among `ids`, in the order of `ids`; unknown IDs are left out. */
  getDocuments(ids: readonly string[]): Promise<DocumentRow[]>;
  /**
   * Documents that an index has not seen or that changed since, oldest change first.
   * `indexTable` has one row per indexed document: `document_id` and the
   * `document_changed_at` it indexed.
   */
  documentsToIndex(indexTable: string, limit?: number): Promise<DocumentRow[]>;
  /** How many documents `documentsToIndex` would return without a limit. */
  countToIndex(indexTable: string): Promise<number>;
}

const COLUMNS = [
  "id",
  "source",
  "native_id",
  "version",
  "content_type",
  "publication_types",
  "title",
  "authors",
  "venue",
  "summary",
  "language",
  "subjects",
  "published_at",
  "published_precision",
  "source_updated_at",
  "duration_seconds",
  "canonical_url",
  "doi",
  "external_ids",
  "licence",
  "full_text",
  "found_by",
  "retrieved_at",
  "expires_at",
  "extra",
  "created_at",
  "changed_at",
] as const satisfies readonly (keyof DocumentRow)[];

// As text: pg would turn a `date` into a JavaScript Date at local midnight.
const SELECT_DOCUMENT = COLUMNS.map((column) =>
  column === "published_at"
    ? "d.published_at::text AS published_at"
    : `d.${column}`,
).join(", ");

// The next store run deletes rows past `expires_at`; until then they must not be used.
const NOT_EXPIRED = "(d.expires_at IS NULL OR d.expires_at > now())";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** `table` or `schema.table`, quoted; anything else is refused, as it ends up in SQL. */
function tableName(name: string): string {
  const parts = name.split(".");
  if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part))) {
    throw new Error(`Not a plain lower-case table name: ${name}`);
  }
  return parts.map((part) => `"${part}"`).join(".");
}

export function createDocumentStore(db: Queryable): DocumentStore {
  async function getDocuments(ids: readonly string[]): Promise<DocumentRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query<DocumentRow>(
      `SELECT ${SELECT_DOCUMENT}
       FROM documents AS d
       WHERE d.id = ANY($1::text[]) AND ${NOT_EXPIRED}
       ORDER BY array_position($1::text[], d.id)`,
      [ids],
    );
    return rows;
  }

  return {
    getDocuments,

    async getDocument(id) {
      const [document] = await getDocuments([id]);
      return document;
    },

    async documentsToIndex(indexTable, limit) {
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
        throw new RangeError(
          `limit must be a positive whole number, not ${limit}`,
        );
      }
      const { rows } = await db.query<DocumentRow>(
        `SELECT ${SELECT_DOCUMENT} ${toIndex(indexTable)} ORDER BY d.changed_at, d.id LIMIT $1`,
        [limit ?? null],
      );
      return rows;
    },

    async countToIndex(indexTable) {
      const { rows } = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count ${toIndex(indexTable)}`,
      );
      return rows[0]?.count ?? 0;
    },
  };
}

/**
 * FROM and WHERE of the documents an index has not seen or that changed since. A per-row
 * comparison: polling `changed_at > last run` would miss the rows of a store run that commits
 * late. In milliseconds, as a JavaScript Date holds no more, so an indexer can store the
 * `changed_at` it read.
 */
function toIndex(indexTable: string): string {
  return `FROM documents AS d
          LEFT JOIN ${tableName(indexTable)} AS i ON i.document_id = d.id
          WHERE (i.document_id IS NULL
                 OR i.document_changed_at IS DISTINCT FROM date_trunc('milliseconds', d.changed_at))
            AND ${NOT_EXPIRED}`;
}

const PRECISION_LENGTH = {
  year: 4,
  month: 7,
  day: 10,
} as const satisfies Record<PublishedPrecision, number>;

/** `published_at` at its precision, as the MCP results show it: `2026`, `2026-09` or `2026-09-13`. */
export function publishedDate(
  document: Pick<DocumentRow, "published_at" | "published_precision">,
): string | undefined {
  const { published_at, published_precision } = document;
  if (published_at === null || published_precision === null) return undefined;
  return published_at.slice(0, PRECISION_LENGTH[published_precision]);
}

/**
 * The text of a document's row: title, abstract or description, and subject labels (MeSH for
 * PubMed). What an index reads when it has no full text (Documentation/sources/README.md §3).
 */
export function metadataText(
  document: Pick<DocumentRow, "title" | "summary" | "subjects">,
): string {
  const subjects = document.subjects.map((subject) => subject.label);
  return [document.title, document.summary ?? "", ...subjects].join("\n");
}
