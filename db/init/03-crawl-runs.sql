-- One row per crawler run with --store (#41): what ran, how it went and what it stored. Written
-- in the same transaction as the documents of the run, so a failed store leaves no row.
CREATE TABLE IF NOT EXISTS crawl_runs (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source      text NOT NULL,
    topics      text[] NOT NULL DEFAULT '{}',
    arguments   text[] NOT NULL,
    started_at  timestamptz NOT NULL,
    finished_at timestamptz NOT NULL,
    ok          boolean NOT NULL,
    stats       jsonb NOT NULL,
    failures    jsonb NOT NULL DEFAULT '[]',
    run_error   text,
    -- Documents of the run: new, changed or unchanged rows; stored documents newly cited by the
    -- run; expired rows deleted.
    inserted    integer NOT NULL,
    changed     integer NOT NULL,
    unchanged   integer NOT NULL,
    cited       integer NOT NULL,
    expired     integer NOT NULL,
    CONSTRAINT crawl_runs_source_check
        CHECK (source IN ('pubmed', 'arxiv', 'zenodo', 'youtube', 'podcast'))
);
