-- P8-02: transcript retention. One row per agent whose transcript was compacted: every chunk up
-- to `through_seq` (written up to `through_at`) was removed, last at `removed_at`, for `reason`.
-- `last_seq` is the agent's high-water mark — the newest `seq` it had when chunks were removed —
-- so the transcript pipeline never hands out a `seq` again after removing an agent's newest
-- chunks (it numbers from MAX(chunks, last_seq)). Storage bookkeeping, not domain state: no event
-- describes it and it is not in a snapshot (like agent_processes); the event log is untouched.
CREATE TABLE transcript_compactions (
  agent_id        TEXT PRIMARY KEY,
  through_seq     INTEGER NOT NULL,
  through_at      TEXT NOT NULL,
  last_seq        INTEGER NOT NULL,
  removed_at      TEXT NOT NULL,
  removed_chunks  INTEGER NOT NULL DEFAULT 0,
  reason          TEXT NOT NULL CHECK (reason IN ('age', 'archived'))
);
