-- migrate: foreign_keys=off
-- P11-02: AI providers (Codex, Antigravity), per-task and per-job models, publish approvals and
-- usage limits (spec 2026-10-31-more-ai-providers).
--
-- Tasks gain `provider`, `model`, `publishes` and `makes_images`; projects gain
-- `default_provider`; jobs gain `model`, `follow_up_provider`, `follow_up_model` and
-- `limit_question_id`. The provider columns are new and nullable, so their CHECK is added with the
-- column. `jobs.provider` (0016) keeps its default 'claude' and is validated by the mapper.
-- Questions gain the `publish` kind and job runs the `limited` outcome: SQLite cannot alter a
-- CHECK constraint, so both tables are rebuilt the documented way (as 0016 did: new table, copy,
-- drop, rename) with foreign keys off; the runner checks `foreign_key_check` before committing.
-- Every column and index the two tables have are kept.

ALTER TABLE tasks ADD COLUMN provider TEXT CHECK (provider IN ('claude', 'chatgpt', 'gemini'));
ALTER TABLE tasks ADD COLUMN model TEXT;
ALTER TABLE tasks ADD COLUMN publishes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN makes_images INTEGER NOT NULL DEFAULT 0;

ALTER TABLE projects ADD COLUMN default_provider TEXT
  CHECK (default_provider IN ('claude', 'chatgpt', 'gemini'));

ALTER TABLE jobs ADD COLUMN model TEXT;
ALTER TABLE jobs ADD COLUMN follow_up_provider TEXT
  CHECK (follow_up_provider IN ('claude', 'chatgpt', 'gemini'));
ALTER TABLE jobs ADD COLUMN follow_up_model TEXT;
ALTER TABLE jobs ADD COLUMN limit_question_id TEXT;

CREATE TABLE questions_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL
                   CHECK (kind IN ('clarification', 'permission', 'spend', 'publish')),
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
-- 0008 and 0009.
CREATE INDEX questions_history ON questions(updated_at, id)
  WHERE status IN ('answered', 'cancelled');
CREATE INDEX questions_origin ON questions(origin_agent_id, updated_at);

CREATE TABLE job_runs_new (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  agent_id     TEXT,
  purpose      TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  covers_from  TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  outcome      TEXT NOT NULL
               CHECK (outcome IN ('running', 'quiet', 'findings', 'failed', 'interrupted',
                                  'limited')),
  summary      TEXT,
  numbers      TEXT,
  follow_up    TEXT,
  note         TEXT,
  meta         TEXT
);
INSERT INTO job_runs_new (id, job_id, agent_id, purpose, due_at, covers_from, started_at, ended_at,
    outcome, summary, numbers, follow_up, note, meta)
  SELECT id, job_id, agent_id, purpose, due_at, covers_from, started_at, ended_at, outcome,
    summary, numbers, follow_up, note, meta FROM job_runs ORDER BY rowid;
DROP TABLE job_runs;
ALTER TABLE job_runs_new RENAME TO job_runs;
CREATE INDEX job_runs_job ON job_runs(job_id, started_at);
