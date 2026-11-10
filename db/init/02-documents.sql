-- Source metadata, one row per source record (#41). Columns: Documentation/sources/README.md §2,
-- storage and read rules: Documentation/storage.md. The crawler is the only writer; the indexer and
-- the MCP server only read. Safe to run again: existing tables are left as they are.
CREATE TABLE IF NOT EXISTS documents (
    id                  text PRIMARY KEY,
    source              text NOT NULL,
    native_id           text NOT NULL,
    version             text,
    content_type        text NOT NULL,
    publication_types   text[] NOT NULL DEFAULT '{}',
    title               text NOT NULL,
    authors             jsonb NOT NULL DEFAULT '[]',
    venue               text,
    summary             text,
    language            text,
    subjects            jsonb NOT NULL DEFAULT '[]',
    published_at        date,
    published_precision text,
    source_updated_at   timestamptz,
    duration_seconds    integer,
    canonical_url       text NOT NULL,
    doi                 text,
    external_ids        jsonb NOT NULL DEFAULT '{}',
    licence             text,
    full_text           jsonb NOT NULL DEFAULT '[]',
    found_by            jsonb NOT NULL DEFAULT '[]',
    retrieved_at        timestamptz NOT NULL,
    expires_at          timestamptz,
    extra               jsonb NOT NULL DEFAULT '{}',
    -- First stored, and last changed in any column except found_by, retrieved_at and expires_at.
    created_at          timestamptz NOT NULL DEFAULT now(),
    changed_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT documents_id_check CHECK (id = source || ':' || native_id),
    CONSTRAINT documents_source_check
        CHECK (source IN ('pubmed', 'arxiv', 'zenodo', 'youtube', 'podcast')),
    CONSTRAINT documents_content_type_check CHECK (content_type IN (
        'journal_article', 'preprint', 'conference_paper', 'poster', 'presentation', 'report',
        'book', 'video', 'podcast_episode'
    )),
    CONSTRAINT documents_published_precision_check
        CHECK (published_precision IN ('year', 'month', 'day')),
    CONSTRAINT documents_published_check
        CHECK ((published_at IS NULL) = (published_precision IS NULL))
);

-- Duplicates are linked at query time, first by DOI.
CREATE INDEX IF NOT EXISTS documents_doi_idx ON documents (doi) WHERE doi IS NOT NULL;

-- Every store run deletes expired rows (YouTube: 30 days after retrieval).
CREATE INDEX IF NOT EXISTS documents_expires_at_idx ON documents (expires_at)
    WHERE expires_at IS NOT NULL;
