import type { Actor, Id, WorkState } from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { endProjectRules } from './project-rules.js';
import { endStandingApprovals } from './waykeeper-approvals.js';
import { withdrawLimitQuestions } from './usage-limits.js';

/**
 * Task and project state transitions (SPEC §4.4, P2-01). The happy path is
 * `proposed → approved → in progress ⇄ blocked on user → awaiting closure → completed → archived`;
 * `paused`, `interrupted` and `failed` branch off a running item and come back, `moved` is the
 * marker a promoted or moved item leaves behind (decision 15), and reopening (decision 11b)
 * takes finished work back to `approved`. P2-15 derives most of these from agents and questions
 * (`work-states.ts`), and the derivation goes through this table like the explicit commands do:
 * it added the moves an agent can cause on its own — a Steward that ends its turn or finishes
 * from `approved`, `paused` or `interrupted` (awaiting closure), one interrupted while awaiting
 * closure, and a failed task picked up again by a new Steward (any running state). A recurring
 * job's hidden task goes back to `approved` when its run ends (P10-03, `JOB_TASK_RULES`).
 */
export const TRANSITIONS: Readonly<Record<WorkState, readonly WorkState[]>> = {
  proposed: ['approved', 'archived'],
  approved: [
    'in_progress',
    'blocked_on_user',
    'awaiting_closure',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  in_progress: [
    'approved',
    'blocked_on_user',
    'awaiting_closure',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  blocked_on_user: [
    'approved',
    'in_progress',
    'awaiting_closure',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  awaiting_closure: [
    'approved',
    'in_progress',
    'blocked_on_user',
    'paused',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  paused: [
    'approved',
    'in_progress',
    'blocked_on_user',
    'awaiting_closure',
    'failed',
    'interrupted',
    'moved',
    'completed',
  ],
  interrupted: [
    'approved',
    'in_progress',
    'blocked_on_user',
    'awaiting_closure',
    'paused',
    'failed',
    'completed',
  ],
  failed: [
    'approved',
    'in_progress',
    'blocked_on_user',
    'awaiting_closure',
    'paused',
    'interrupted',
    'completed',
    'archived',
  ],
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

/** Why a finished task's usage-limit question was withdrawn. */
const TASK_ENDED: Partial<Record<WorkState, string>> = {
  completed: 'the task was closed',
  archived: 'the task was archived',
  failed: 'the task failed',
  moved: 'the task was moved',
};

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
  // Its "Allow similar" rules last until the project closes (P9-17, decision 138).
  if (to === 'completed' || to === 'archived') {
    endProjectRules(ctx, projectId, to);
    // So do its standing approvals (P13, decision 154).
    endStandingApprovals(ctx, projectId, to);
  }
  return ctx.tables.projects.get(projectId) ?? project;
}

/** Sets a task's state; the same state is a no-op without an event. */
export function setTaskState(ctx: CommandContext, taskId: Id, to: WorkState, by?: Actor) {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (current.state === to) return current;
  checkTransition('task', taskId, current.state, to);
  const task = ctx.tables.tasks.upsert({ ...current, state: to, updatedAt: ctx.now });
  ctx.emit({ type: 'task.state_changed', taskId, from: current.state, to, ...(by ? { by } : {}) });
  // A finished task's usage-limit question is moot: withdrawn (P11-13). A paused one keeps it.
  if (FINISHED_WORK.has(to))
    withdrawLimitQuestions(ctx, { taskId }, TASK_ENDED[to] ?? 'the task ended');
  return task;
}
