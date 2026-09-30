-- Domain tables. Every JSON column holds a value validated by @galactic/protocol before insert.
-- Speculative fields go in `meta` (IMPLEMENTATION_PLAN corner case 20), never in new columns.

CREATE TABLE bodies (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('planet', 'moon', 'asteroid')),
  parent_id   TEXT REFERENCES bodies(id),
  name        TEXT NOT NULL,
  host_kind   TEXT CHECK (host_kind IN ('project', 'task')),
  host_id     TEXT,
  meta        TEXT
);
CREATE INDEX bodies_host ON bodies(host_kind, host_id);

CREATE TABLE projects (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  workspace          TEXT NOT NULL,
  repo_path          TEXT,
  parent_project_id  TEXT REFERENCES projects(id),
  body_id            TEXT NOT NULL REFERENCES bodies(id),
  state              TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  meta               TEXT
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id),
  body_id        TEXT NOT NULL REFERENCES bodies(id),
  description    TEXT NOT NULL,
  priority       TEXT NOT NULL,
  worktree_path  TEXT,
  branch         TEXT,
  blocked_by     TEXT NOT NULL DEFAULT '[]',
  state          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  meta           TEXT
);
CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('harmonizer', 'waykeeper', 'steward')),
  runtime        TEXT NOT NULL,
  session_ref    TEXT,
  supervisor_id  TEXT REFERENCES agents(id),
  body_id        TEXT NOT NULL REFERENCES bodies(id),
  task_id        TEXT REFERENCES tasks(id),
  project_id     TEXT REFERENCES projects(id),
  caps           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  meta           TEXT
);
CREATE INDEX agents_supervisor ON agents(supervisor_id);

CREATE TABLE proposals (
  id             TEXT PRIMARY KEY,
  request_text   TEXT NOT NULL,
  kind           TEXT NOT NULL,
  proposed_body  TEXT NOT NULL,
  workspace      TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  state          TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  meta           TEXT
);

CREATE TABLE questions (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('clarification', 'permission')),
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
CREATE INDEX questions_status ON questions(status);

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- The event log (TECHNOLOGY §6.2). `id` is the rowid: monotonic, server-assigned, the stream `seq`.
CREATE TABLE events (
  id       INTEGER PRIMARY KEY,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  payload  TEXT NOT NULL
);
CREATE INDEX events_type ON events(type);

-- Agent output, batched and prunable; filled from Phase 1.
CREATE TABLE transcript_chunks (
  agent_id  TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  at        TEXT NOT NULL,
  chunk     TEXT NOT NULL,
  PRIMARY KEY (agent_id, seq)
);
