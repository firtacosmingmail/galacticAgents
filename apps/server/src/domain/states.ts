import type { Actor, Id, WorkState } from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';

/**
 * Task and project state transitions (SPEC §4.4, P2-01). The happy path is
 * `proposed → approved → in progress ⇄ blocked on user → awaiting closure → completed → archived`;
 * `paused`, `interrupted` and `failed` branch off a running item and come back, `moved` is the
 * marker a promoted or moved item leaves behind (decision 15), and reopening (decision 11b)
 * takes finished work back to `approved`. P2-15 derives most of these from agents and questions;
 * the explicit commands (close, archive, reopen, a panel's state change) go through this table.
 */
export const TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  proposed: ['approved', 'archived'],
  approved: [
    'in_progress',
    'blocked_on_user',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
    'archived',
  ],
  in_progress: [
    'blocked_on_user',
    'awaiting_closure',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  blocked_on_user: [
    'in_progress',
    'awaiting_closure',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  awaiting_closure: ['in_progress', 'blocked_on_user', 'paused', 'failed', 'moved', 'completed'],
  paused: ['approved', 'in_progress', 'blocked_on_user', 'failed', 'interrupted', 'moved', 'completed'],
  interrupted: ['in_progress', 'blocked_on_user', 'paused', 'failed', 'completed'],
  failed: ['approved', 'in_progress', 'completed', 'archived'],
  completed: ['approved', 'in_progress', 'archived'],
  archived: ['approved'],
  moved: ['archived'],
};

/** States in which an item no longer runs: its body may be freed, its parent closed. */
export const FINISHED_WORK: ReadonlySet<WorkState> = new Set<WorkState>([
  'completed',
  'archived',
  'failed',
  'moved',
]);

export function canTransition(from: WorkState, to: WorkState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function checkTransition(what: string, id: Id, from: WorkState, to: WorkState): void {
  if (!canTransition(from, to)) {
    throw new DomainError('invalid_transition', `${what} ${id} cannot go from ${from} to ${to}`);
  }
}

/** Sets a project's state; the same state is a no-op without an event. */
export function setProjectState(ctx: CommandContext, projectId: Id, to: WorkState, by?: Actor) {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (current.state === to) return current;
  checkTransition('project', projectId, current.state, to);
  const project = ctx.tables.projects.upsert({ ...current, state: to, updatedAt: ctx.now });
  ctx.emit({
    type: 'project.state_changed',
    projectId,
    from: current.state,
    to,
    ...(by ? { by } : {}),
  });
  return project;
}

/** Sets a task's state; the same state is a no-op without an event. */
export function setTaskState(ctx: CommandContext, taskId: Id, to: WorkState, by?: Actor) {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (current.state === to) return current;
  checkTransition('task', taskId, current.state, to);
  const task = ctx.tables.tasks.upsert({ ...current, state: to, updatedAt: ctx.now });
  ctx.emit({ type: 'task.state_changed', taskId, from: current.state, to, ...(by ? { by } : {}) });
  return task;
}
