-- P15-01: the project dashboard (SPEC decision 156).
--
-- A long-term project's dashboard panels (`Panel`), folded from `panel.*` and `panels.arranged`
-- events like every other domain table. `source`, `display`, `limits`, `layout` and `created_by`
-- are JSON columns holding values validated by @galactic/protocol before insert.
--
-- A job gains its data map (`data_map`: where its data comes from; NULL on older jobs) and a run
-- gains the snapshot data it reported (`data`) and what it read from (`sources`), both JSON.
CREATE TABLE dashboard_panels (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  type                  TEXT NOT NULL,
  title                 TEXT NOT NULL,
  source                TEXT NOT NULL,
  display               TEXT NOT NULL,
  limits                TEXT NOT NULL,
  layout                TEXT NOT NULL,
  history_from          TEXT,
  removal_suggested_at  TEXT,
  created_by            TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  meta                  TEXT
);
CREATE INDEX dashboard_panels_project ON dashboard_panels(project_id);

ALTER TABLE jobs ADD COLUMN data_map TEXT;
ALTER TABLE job_runs ADD COLUMN data TEXT;
ALTER TABLE job_runs ADD COLUMN sources TEXT;
