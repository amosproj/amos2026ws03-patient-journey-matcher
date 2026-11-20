-- The transcription job (matcher/transcriber), in one row: how many audio files it is to read at
-- once (0: none; the debug UI sets it), and what the running job reported last.
CREATE TABLE IF NOT EXISTS transcription (
    only_row    boolean PRIMARY KEY DEFAULT true CHECK (only_row),
    workers     integer NOT NULL DEFAULT 0 CHECK (workers >= 0),
    state       jsonb,
    reported_at timestamptz
);

-- What the transcription job read from the audio of a document without a transcript: the text,
-- or why there is none. Indexes read the text like a downloaded full text; once every index has
-- read it, the indexer drops it, and the row only records which file was read.
CREATE TABLE IF NOT EXISTS transcripts (
    document_id text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    url         text NOT NULL,
    status      text NOT NULL CHECK (status IN ('ok', 'skipped', 'failed')),
    detail      text,
    text        text,
    model       text NOT NULL,
    read_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transcripts_url_idx ON transcripts (url);

-- Takes over the setting from keyword.transcription, where the job kept it while it read audio
-- for the keyword index only, and drops that table.
DO $$
BEGIN
    IF to_regclass('keyword.transcription') IS NOT NULL THEN
        INSERT INTO transcription (workers)
        SELECT workers FROM keyword.transcription
        ON CONFLICT (only_row) DO NOTHING;
        DROP TABLE keyword.transcription;
    END IF;
END $$;
