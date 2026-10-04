-- P5-03: the history's trails and its detail read (`GET /api/history/work/:kind/:id`).
--
-- A piece of work's own lifecycle events — its state changes, its moves and a task's updates —
-- keyed by the work they are about (`projectId`, `taskId`, or a move's `host.id`). Partial: only
-- those four types are indexed, so other events pay nothing. The history reads one page's (or one
-- item's) events by key; the queries repeat the expression and the WHERE term verbatim.
CREATE INDEX events_work_subject ON events(
  coalesce(json_extract(payload, '$.projectId'), json_extract(payload, '$.taskId'),
    json_extract(payload, '$.host.id'))
) WHERE type IN ('project.state_changed', 'task.state_changed', 'task.updated', 'body.moved');

-- The rows the detail lists: a project's sub-projects, the project a task was promoted into
-- (`meta.promotedFrom.taskId`, decision 15's permanent link), the agents of a project or a task,
-- and the questions those agents asked, newest first.
CREATE INDEX projects_parent ON projects(parent_project_id);
CREATE INDEX projects_promoted_from ON projects(json_extract(meta, '$.promotedFrom.taskId'));
CREATE INDEX agents_project ON agents(project_id);
CREATE INDEX agents_task ON agents(task_id);
CREATE INDEX questions_origin ON questions(origin_agent_id, updated_at);
