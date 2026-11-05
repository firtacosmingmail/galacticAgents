-- migrate: foreign_keys=off
-- P12-07: the `launch` question kind (a Waykeeper's request to start a Steward with CLI flags).
-- SQLite cannot alter a CHECK constraint, so `questions` is rebuilt the documented way (as 0017
-- did: new table, copy, drop, rename) with foreign keys off; the runner checks `foreign_key_check`
-- before committing. Every column and index is kept.

CREATE TABLE questions_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL
                   CHECK (kind IN ('clarification', 'permission', 'spend', 'publish', 'launch')),
  origin_agent_id  TEXT NOT NULL REFERENCES agents(id),
  holder           TEXT NOT NULL,
  status           TEXT NOT NULL,
  context          TEXT NOT NULL,
  answered_by      TEXT,
  answer           TEXT,
  version          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  meta             TEXT
);
INSERT INTO questions_new (id, kind, origin_agent_id, holder, status, context, answered_by, answer,
    version, created_at, updated_at, meta)
  SELECT id, kind, origin_agent_id, holder, status, context, answered_by, answer, version,
    created_at, updated_at, meta FROM questions ORDER BY rowid;
DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;
CREATE INDEX questions_status ON questions(status);
CREATE INDEX questions_history ON questions(updated_at, id)
  WHERE status IN ('answered', 'cancelled');
CREATE INDEX questions_origin ON questions(origin_agent_id, updated_at);
