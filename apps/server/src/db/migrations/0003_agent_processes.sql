-- P1-01: the persisted PID table of the process supervisor. Runtime bookkeeping, not domain
-- state: it never appears in a snapshot and no event describes it. On startup it is reconciled
-- against the live process list; rows of dead or orphaned processes become `interrupted` and
-- the resume path (P1-14) respawns their agents from `agents.session_ref`.
CREATE TABLE agent_processes (
  agent_id    TEXT PRIMARY KEY,
  pid         INTEGER,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running', 'exited', 'interrupted')),
  exit_code   INTEGER,
  signal      TEXT,
  meta        TEXT
);
CREATE INDEX agent_processes_status ON agent_processes(status);
