import { randomUUID } from 'node:crypto';
import type { Actor, CreateTaskInput, Host, Id, ReopenInput, Task } from '@galactic/protocol';
import {
  assignBody,
  bodyOf,
  checkAssignable,
  createAsteroid,
  moveAgents,
  occupy,
  release,
} from './bodies.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { setTaskState } from './states.js';

/**
 * Task commands (P2-01; SPEC §2.7, §3.1, §3.4, decisions 9, 11, 11b). A project task lives on its
 * project's body; a standalone task occupies an asteroid of its own. The Waykeeper (or, for an
 * asteroid, the Harmonizer) closes tasks; archive frees an asteroid; a standalone task moved into
 * a project leaves its asteroid and lives on the project's body from then on.
 */

export type TaskChanges = Partial<Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'state'>>;

const hostOf = (taskId: Id): Host => ({ kind: 'task', id: taskId });

/** A project that can still take work: not archived (reopen it first). */
function openProject(ctx: CommandContext, projectId: Id) {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (project.state === 'archived') {
    throw new DomainError(
      'invalid_transition',
      `project ${projectId} is archived; reopen it first`,
    );
  }
  return project;
}

function checkBlockers(ctx: CommandContext, taskId: Id | undefined, blockedBy: Id[]): void {
  for (const id of blockedBy) {
    if (id === taskId) throw new DomainError('invalid', 'a task cannot block itself');
    must(ctx.tables.tasks.get(id), 'task', id);
  }
}

export function createTask(ctx: CommandContext, input: CreateTaskInput): Task {
  if (!input.description.trim()) throw new DomainError('invalid', 'a task needs a description');
  const id = `t-${randomUUID()}`;
  const blockedBy = input.blockedBy ?? [];
  checkBlockers(ctx, undefined, blockedBy);
  let bodyId: Id;
  let asteroid;
  if (input.projectId) {
    if (input.bodyId)
      throw new DomainError('invalid', 'a project task lives on its project’s body');
    bodyId = openProject(ctx, input.projectId).bodyId;
  } else {
    asteroid = input.bodyId
      ? must(ctx.tables.bodies.get(input.bodyId), 'body', input.bodyId)
      : createAsteroid(ctx);
    checkAssignable(asteroid, hostOf(id));
    bodyId = asteroid.id;
  }
  const task: Task = {
    id,
    bodyId,
    description: input.description,
    priority: input.priority ?? 'normal',
    blockedBy,
    state: input.state ?? 'approved',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  ctx.tables.tasks.insert(task);
  ctx.emit({ type: 'task.created', task });
  if (asteroid) occupy(ctx, asteroid, hostOf(id));
  return task;
}

/**
 * Edits a task's fields (description, priority, blockers, worktree, branch, pin). Its body and
 * project change only by moving, its state only by the state commands.
 */
export function updateTask(ctx: CommandContext, taskId: Id, changes: TaskChanges): Task {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  const defined = Object.fromEntries(
    Object.entries(changes).filter(([, v]) => v !== undefined),
  ) as TaskChanges;
  if ('bodyId' in defined && defined.bodyId !== current.bodyId) {
    throw new DomainError('invalid', 'a task changes body by moving, not by an update');
  }
  if ('projectId' in defined && defined.projectId !== current.projectId) {
    throw new DomainError('invalid', 'a task joins a project by moving, not by an update');
  }
  delete defined.bodyId;
  delete defined.projectId;
  if (defined.description !== undefined && !defined.description.trim()) {
    throw new DomainError('invalid', 'a task needs a description');
  }
  if (defined.blockedBy) checkBlockers(ctx, taskId, defined.blockedBy);
  if (Object.keys(defined).length === 0) return current;
  const task = ctx.tables.tasks.upsert({ ...current, ...defined, updatedAt: ctx.now });
  ctx.emit({ type: 'task.updated', taskId, changes: defined });
  return task;
}

/** The supervisor closes a task (decision 11): `completed`; an asteroid stays visible until archived. */
export function closeTask(ctx: CommandContext, taskId: Id, by: Actor): Task {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (current.state === 'completed') {
    throw new DomainError('invalid_transition', `task ${taskId} is already completed`);
  }
  return setTaskState(ctx, taskId, 'completed', by);
}

/** Archives a finished task now; a standalone task's asteroid is freed. */
export function archiveTask(ctx: CommandContext, taskId: Id, by: Actor): Task {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (current.state === 'archived') {
    throw new DomainError('invalid_transition', `task ${taskId} is already archived`);
  }
  const task = setTaskState(ctx, taskId, 'archived', by);
  const body = bodyOf(ctx, hostOf(taskId));
  if (body) release(ctx, body);
  return task;
}

export function pinTask(ctx: CommandContext, taskId: Id, pinned: boolean): Task {
  return updateTask(ctx, taskId, { pinned });
}

/**
 * Reopens a finished task as `approved`. A project task needs its project to be open; a
 * standalone one gets its old asteroid back if it is free, else `input.bodyId` or a fresh one.
 */
export function reopenTask(
  ctx: CommandContext,
  taskId: Id,
  by: Actor,
  input: ReopenInput = {},
): Task {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (!['completed', 'archived', 'failed'].includes(current.state)) {
    throw new DomainError('invalid_transition', `task ${taskId} is ${current.state}, not finished`);
  }
  if (current.projectId) {
    if (input.bodyId)
      throw new DomainError('invalid', 'a project task lives on its project’s body');
    openProject(ctx, current.projectId);
    return setTaskState(ctx, taskId, 'approved', by);
  }
  const host = hostOf(taskId);
  const old = must(ctx.tables.bodies.get(current.bodyId), 'body', current.bodyId);
  const oldIsFree = !old.host || (old.host.kind === 'task' && old.host.id === taskId);
  if (oldIsFree && (!input.bodyId || input.bodyId === old.id)) {
    occupy(ctx, old, host);
  } else {
    if (old.host?.kind === 'task' && old.host.id === taskId) release(ctx, old);
    const body = input.bodyId ? input.bodyId : createAsteroid(ctx).id;
    assignBody(ctx, body, host);
  }
  return setTaskState(ctx, taskId, 'approved', by);
}

/**
 * A standalone task joins a project (SPEC §3.4, decision 9): it lives on the project's body from
 * now on, its asteroid is freed and its agents fly over. The asteroid's "moved to …" marker and
 * the Steward hand-over to the project's Waykeeper are P2-12.
 */
export function moveTask(ctx: CommandContext, taskId: Id, toProjectId: Id, _by: Actor): Task {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (current.projectId) {
    throw new DomainError(
      'invalid',
      `task ${taskId} already belongs to project ${current.projectId}`,
    );
  }
  const project = openProject(ctx, toProjectId);
  const old = bodyOf(ctx, hostOf(taskId));
  const task = ctx.tables.tasks.upsert({
    ...current,
    projectId: toProjectId,
    bodyId: project.bodyId,
    updatedAt: ctx.now,
  });
  ctx.emit({
    type: 'task.updated',
    taskId,
    changes: { projectId: toProjectId, bodyId: project.bodyId },
  });
  if (old) release(ctx, old);
  moveAgents(ctx, hostOf(taskId), current.bodyId, project.bodyId);
  return task;
}
