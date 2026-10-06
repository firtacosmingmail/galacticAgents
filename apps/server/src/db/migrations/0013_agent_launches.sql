-- P8-11: launch intents of the process supervisor. Runtime bookkeeping like `agent_processes`
-- (never in a snapshot, no event, never exported). A row is written BEFORE the supervisor forks
-- an agent's CLI and removed once the PID table holds the child (its `agent_processes` row names
-- this launch in `meta.launchId`) or the launch failed. A row still here at the next start is a
-- launch a killed server may have forked without recording: the startup pass
-- (`ProcessSupervisor.reconcileLaunches`) looks for that launch's processes — they carry the
-- agent marker and this row's id (`GALACTIC_LAUNCH_ID`) in their environment — and stops them.
CREATE TABLE agent_launches (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  command      TEXT NOT NULL,
  args         TEXT NOT NULL DEFAULT '[]',
  cwd          TEXT NOT NULL,
  -- The server run that wrote it (one per `ProcessSupervisor`) and the machine's boot time.
  run_id       TEXT NOT NULL,
  boot_at      TEXT NOT NULL,
  -- Real clock (ISO), just before the fork: the start of the window the CLI started in.
  intended_at  TEXT NOT NULL,
  meta         TEXT
);
CREATE INDEX agent_launches_agent ON agent_launches(agent_id);
