-- P9-01: deliverables (SPEC §4.7, decisions 118–134; TECHNOLOGY §9.1).
--
-- A deliverable is a pointer to what a project or a task produced — never the bytes. The rows are
-- folded from `deliverable.*` events (and `last_run` from `run.*`) like every other domain table;
-- removed rows stay (`removed_at`) so the history keeps them (decision 132). JSON columns hold
-- values validated by @galactic/protocol (`Deliverable`) before insert.
CREATE TABLE deliverables (
  id              TEXT PRIMARY KEY,
  project_id      TEXT REFERENCES projects(id),
  task_id         TEXT REFERENCES tasks(id),
  kind            TEXT NOT NULL
                  CHECK (kind IN ('file', 'folder', 'app', 'image', 'command', 'url')),
  title           TEXT NOT NULL,
  description     TEXT,
  source          TEXT NOT NULL CHECK (source IN ('agent', 'detected', 'user')),
  added_by        TEXT NOT NULL,
  location        TEXT,
  command         TEXT,
  url             TEXT,
  detected_key    TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  removed_at      TEXT,
  removed_by      TEXT,
  removed_reason  TEXT,
  last_run        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  meta            TEXT,
  CHECK (project_id IS NOT NULL OR task_id IS NOT NULL)
);
CREATE INDEX deliverables_project ON deliverables(project_id);
CREATE INDEX deliverables_task ON deliverables(task_id);
-- One row per detected script and project, also once removed, so a scan never re-adds what the
-- user removed (decision 119).
CREATE UNIQUE INDEX deliverables_detected ON deliverables(project_id, detected_key)
  WHERE detected_key IS NOT NULL;

-- Every run of a command deliverable (the run history, `GET /api/deliverables/:id/runs`): a
-- projection of `run.*` events, written in the transaction of the event (`projectRunEvent`).
CREATE TABLE deliverable_runs (
  id              TEXT PRIMARY KEY,
  deliverable_id  TEXT NOT NULL REFERENCES deliverables(id),
  line            TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopping', 'ended')),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  exit_code       INTEGER,
  signal          TEXT,
  outcome         TEXT CHECK (outcome IS NULL OR outcome IN ('exited', 'failed', 'stopped')),
  reason          TEXT,
  ports           TEXT NOT NULL DEFAULT '[]',
  started_by      TEXT NOT NULL,
  stopped_by      TEXT,
  meta            TEXT
);
CREATE INDEX deliverable_runs_deliverable ON deliverable_runs(deliverable_id, started_at);

-- A run's output, like `transcript_chunks`: runtime bookkeeping with no event, redacted before it
-- is written, pruned by retention (decision 130), never exported.
CREATE TABLE run_output (
  run_id  TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  at      TEXT NOT NULL,
  chunk   TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
