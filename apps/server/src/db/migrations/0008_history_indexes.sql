-- P25-10: the history view (`GET /api/history/work`, `GET /api/history/questions`) lists finished
-- and archived projects and tasks, and answered and cancelled questions, newest first by
-- (`updated_at`, `id`), paged by a cursor on that order. A partial index per table holds exactly
-- the rows the history lists, in that order, so a page reads only its rows: no sort, and no scan
-- of the open work or the open questions. The queries repeat each WHERE term verbatim, which is
-- what lets SQLite use a partial index.
CREATE INDEX projects_history ON projects(updated_at, id)
  WHERE state IN ('completed', 'failed', 'archived');
CREATE INDEX tasks_history ON tasks(updated_at, id)
  WHERE state IN ('completed', 'failed', 'archived');
CREATE INDEX questions_history ON questions(updated_at, id)
  WHERE status IN ('answered', 'cancelled');
-- A cancelled question's reason lives only on its `question.cancelled` event: the history reads it
-- for one page's ids by `type` and the payload's `questionId` (as 0006's `events_type_agent` does
-- for `agentId`), a lookup per id instead of a walk of every cancellation in the log.
CREATE INDEX events_type_question ON events(type, json_extract(payload, '$.questionId'));
