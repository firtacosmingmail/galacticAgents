-- P8-01: dollar budgets per project and task (SPEC decision 18; TECHNOLOGY §5.4).
--
-- `budget_usd` is a real column on both rows (budgets are no longer speculative): absent (NULL)
-- means no budget. It is folded from `project.updated` / `task.updated` like every other field.
ALTER TABLE projects ADD COLUMN budget_usd REAL CHECK (budget_usd IS NULL OR budget_usd > 0);
ALTER TABLE tasks ADD COLUMN budget_usd REAL CHECK (budget_usd IS NULL OR budget_usd > 0);

-- Each agent's reported cost: a projection of the cost-carrying `agent.*` events, written in the
-- transaction of the event that changes it (`foldSpend` in the protocol package, which the web
-- client folds alike). Kept in a table so the spend outlives anything that trims the log.
-- `sessions` is a JSON object: session key -> the highest cumulative figure it reported.
CREATE TABLE agent_spend (
  agent_id  TEXT PRIMARY KEY,
  usd       REAL NOT NULL DEFAULT 0,
  reported  INTEGER NOT NULL DEFAULT 0 CHECK (reported IN (0, 1)),
  session   TEXT NOT NULL,
  sessions  TEXT NOT NULL DEFAULT '{}'
);

-- The highest budget notice logged for a target's current budget: `warning` or `exceeded`
-- (`budget.warning` / `budget.exceeded`), cleared by `budget.set`. Also a projection of the log,
-- written in the same transaction as the event, so a notice is never repeated after a restart.
CREATE TABLE budget_notices (
  target_kind  TEXT NOT NULL CHECK (target_kind IN ('project', 'task')),
  target_id    TEXT NOT NULL,
  level        TEXT NOT NULL CHECK (level IN ('warning', 'exceeded')),
  budget_usd   REAL NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);

-- Existing logs are folded into `agent_spend` and `budget_notices` once, at the next start
-- (`EventLog`, settings key `budget_projection`).
