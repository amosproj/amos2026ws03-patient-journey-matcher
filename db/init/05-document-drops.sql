-- The drop list of the document pre-filter (#92): documents a rule proposes to leave out of the
-- indexes, each decided by a person. scripts/prefilter.py propose-drops adds proposals and never
-- changes a row that exists; the debug UI's Pre-filter screen saves decisions. The matcher's
-- document store hands an accepted drop to every index as an empty document and leaves it out of
-- match results; the row in documents stays as it is. effect_at is when a drop last changed what
-- is indexed (accept, or undo of an accepted drop); it is part of the document's index version
-- and only moves forward.
-- Never delete a row of a decided drop: its document's index version would go back, and an index
-- that keeps its newer row would list it again in every run.
CREATE TABLE IF NOT EXISTS document_drops (
    document_id text PRIMARY KEY REFERENCES documents (id) ON DELETE CASCADE,
    proposed_by text NOT NULL,
    reason      text NOT NULL,
    status      text NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed', 'accepted', 'rejected')),
    proposed_at timestamptz NOT NULL DEFAULT now(),
    decided_at  timestamptz,
    effect_at   timestamptz,
    note        text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS document_drops_status_idx ON document_drops (status);
