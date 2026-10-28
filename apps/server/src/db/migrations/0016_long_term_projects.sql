-- migrate: foreign_keys=off
-- P10-01: long-term projects, area moons, recurring jobs (SPEC decisions 142–145).
--
-- Projects gain `long_term` (0/1), `purpose` and `goals` (a JSON array of strings). Bodies may
-- host a long-term project's areas (`host_kind = 'areas'`, `host_id` = the project) and questions
-- gain the `spend` kind: SQLite cannot alter a CHECK constraint, so both tables are rebuilt the
-- documented way (0005: new table, copy, drop, rename) with foreign keys off; the runner checks
-- `foreign_key_check` before committing. Every column and index the two tables have gained since
-- 0001 is kept. JSON columns hold values validated by @galactic/protocol before insert.

ALTER TABLE projects ADD COLUMN long_term INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN purpose TEXT;
ALTER TABLE projects ADD COLUMN goals TEXT;

CREATE TABLE bodies_new (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('star', 'planet', 'moon', 'asteroid')),
  parent_id   TEXT REFERENCES bodies(id),
  name        TEXT NOT NULL,
  host_kind   TEXT CHECK (host_kind IN ('project', 'task', 'areas')),
  host_id     TEXT,
  moved_to    TEXT,
  meta        TEXT
);
INSERT INTO bodies_new (id, kind, parent_id, name, host_kind, host_id, moved_to, meta)
  SELECT id, kind, parent_id, name, host_kind, host_id, moved_to, meta FROM bodies ORDER BY rowid;
DROP TABLE bodies;
ALTER TABLE bodies_new RENAME TO bodies;
CREATE INDEX bodies_host ON bodies(host_kind, host_id);

CREATE TABLE questions_new (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('clarification', 'permission', 'spend')),
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

-- A business area of a long-term project, on a moon of its planet (`Area`). Folded from
-- `area.*` events like every other domain table.
CREATE TABLE areas (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  name        TEXT NOT NULL,
  body_id     TEXT NOT NULL REFERENCES bodies(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  meta        TEXT
);
CREATE INDEX areas_project ON areas(project_id);
CREATE INDEX areas_body ON areas(body_id);

-- A recurring job of an area (`Job`), run as Stewards on its hidden task. `schedule`,
-- `unattended_rules`, `last_run` and `follow_ups` are JSON. The scheduler reads the due jobs by
-- (`state`, `next_run_at`).
CREATE TABLE jobs (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES projects(id),
  area_id              TEXT NOT NULL REFERENCES areas(id),
  task_id              TEXT NOT NULL REFERENCES tasks(id),
  name                 TEXT NOT NULL,
  instructions         TEXT NOT NULL,
  schedule             TEXT NOT NULL,
  provider             TEXT NOT NULL DEFAULT 'claude',
  unattended_rules     TEXT,
  state                TEXT NOT NULL CHECK (state IN ('active', 'paused', 'stopped')),
  paused_reason        TEXT,
  failure_question_id  TEXT,
  next_run_at          TEXT,
  last_run             TEXT,
  running_run_id       TEXT,
  follow_ups           TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  meta                 TEXT
);
CREATE INDEX jobs_due ON jobs(state, next_run_at);

-- Every run of a job (`JobRun`), kept per job: the last 200 (older rows deleted when a run is
-- recorded). `numbers` and `follow_up` are JSON.
CREATE TABLE job_runs (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id),
  agent_id     TEXT,
  purpose      TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  covers_from  TEXT,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  outcome      TEXT NOT NULL
               CHECK (outcome IN ('running', 'quiet', 'findings', 'failed', 'interrupted')),
  summary      TEXT,
  numbers      TEXT,
  follow_up    TEXT,
  note         TEXT,
  meta         TEXT
);
CREATE INDEX job_runs_job ON job_runs(job_id, started_at);
