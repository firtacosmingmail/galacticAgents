import type { Agent, Id } from '@galactic/protocol';
import { updateAgent } from './agents.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';

/**
 * Hand-overs (P2-12; SPEC decision 32, wave-3 review finding 5). When work changes place in the
 * hierarchy — a task joins a project, a sub-project is detached from or attached to a planet —
 * the agents working on it get the supervisor and project the hierarchy prescribes **in the same
 * command**, so the placement invariants hold at every commit:
 * - a moved task's Stewards: its project and that project's Waykeeper (the Harmonizer for a
 *   standalone task);
 * - a detached sub-project's Waykeeper: the Harmonizer; an attached one: the parent's Waykeeper.
 *
 * Every row is re-parented, ended ones too (history rows keep the invariant), except a row from
 * before the rules (no supervisor: the Phase 1 ops console), which stays outside them (P2-20). The supervisor is
 * the newest *living* candidate, else the newest row (supervisors are matched by role and
 * project, not by liveness; decision 32). With no candidate at all the command is refused and
 * rolls back: start the project's Waykeeper first.
 */

export interface HandOverOptions {
  /** Whether an agent still runs (`QuestionRouting.isLiving`); default: every row counts. */
  isLiving?: (agentId: Id) => boolean;
}

/** The newest living agent matching `matches`, else the newest one. */
export function pickSupervisor(
  ctx: Pick<CommandContext, 'tables'>,
  matches: (a: Agent) => boolean,
  opts: HandOverOptions = {},
): Agent | undefined {
  const candidates = ctx.tables.agents
    .all()
    .filter(matches)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return candidates.find((a) => opts.isLiving?.(a.id) ?? true) ?? candidates[0];
}

const waykeeperOf = (projectId: Id) => (a: Agent) =>
  a.role === 'waykeeper' && a.projectId === projectId;
const isHarmonizer = (a: Agent) => a.role === 'harmonizer';

/** The task's Stewards follow it: its project and its project's Waykeeper (or the Harmonizer). */
export function handOverTask(ctx: CommandContext, taskId: Id, opts: HandOverOptions = {}): Agent[] {
  const task = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  const stewards = ctx.tables.agents
    .all()
    .filter(
      (a) =>
        a.role === 'steward' &&
        a.taskId === taskId &&
        // A row from before the rules (the Phase 1 ops console, no supervisor) stays outside them.
        a.supervisorId !== undefined &&
        (a.projectId !== task.projectId || !supervisedRight(ctx, a, task.projectId)),
    );
  if (stewards.length === 0) return [];
  const supervisor = pickSupervisor(
    ctx,
    task.projectId ? waykeeperOf(task.projectId) : isHarmonizer,
    opts,
  );
  if (!supervisor) {
    throw new DomainError(
      'conflict',
      task.projectId
        ? `project ${task.projectId} has no Waykeeper to take over the Stewards of task ${taskId}: start it first`
        : `no Harmonizer to take over the Stewards of task ${taskId}`,
    );
  }
  if (!task.projectId && stewards.some((s) => s.projectId)) {
    // AgentPlacement cannot clear a project: a task never leaves a project for the belt.
    throw new DomainError('invalid', `task ${taskId} cannot leave its project`);
  }
  return stewards.map((s) =>
    updateAgent(ctx, s.id, {
      supervisorId: supervisor.id,
      ...(task.projectId ? { projectId: task.projectId } : {}),
    }),
  );
}

/** A project's Waykeepers answer to its parent's Waykeeper, or to the Harmonizer without one. */
export function handOverProject(
  ctx: CommandContext,
  projectId: Id,
  opts: HandOverOptions = {},
): Agent[] {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const matches = project.parentProjectId ? waykeeperOf(project.parentProjectId) : isHarmonizer;
  const waykeepers = ctx.tables.agents.all().filter((a) => {
    if (a.role !== 'waykeeper' || a.projectId !== projectId || !a.supervisorId) return false;
    const current = a.supervisorId ? ctx.tables.agents.get(a.supervisorId) : undefined;
    return !current || !matches(current);
  });
  if (waykeepers.length === 0) return [];
  const supervisor = pickSupervisor(ctx, matches, opts);
  if (!supervisor) {
    throw new DomainError(
      'conflict',
      project.parentProjectId
        ? `project ${project.parentProjectId} has no Waykeeper to supervise the Waykeeper of ${projectId}: start it first`
        : `no Harmonizer to supervise the Waykeeper of ${projectId}`,
    );
  }
  return waykeepers.map((w) => updateAgent(ctx, w.id, { supervisorId: supervisor.id }));
}

function supervisedRight(ctx: CommandContext, steward: Agent, projectId: Id | undefined): boolean {
  const current = steward.supervisorId ? ctx.tables.agents.get(steward.supervisorId) : undefined;
  if (!current) return false;
  return projectId ? waykeeperOf(projectId)(current) : isHarmonizer(current);
}
