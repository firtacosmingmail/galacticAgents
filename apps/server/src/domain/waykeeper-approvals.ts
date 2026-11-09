import { randomUUID } from 'node:crypto';
import {
  MAX_RECORDED_APPROVALS,
  type Actor,
  type Id,
  type RecordedApproval,
  type RequestOrigin,
  type StandingApproval,
} from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { RULES_END_IN } from './project-rules.js';

/**
 * A project's Waykeeper approvals as rows (P13-01, SPEC decision 154), kept on its row like the
 * "Allow similar" rules (`project-rules.ts`): the switch (`Project.waykeeperApprovals`), the
 * standing approvals and the recorded approvals, changed only here, each change with its event in
 * the caller's transaction, folded alike by `applyEvent`. None of them is an edit of the project:
 * `updatedAt` stays.
 */

const SYSTEM: Actor = { type: 'system' };

/** Turns the project's Waykeeper approvals on or off; `on` is refused for a project that ended. */
export function setWaykeeperApprovals(
  ctx: CommandContext,
  projectId: Id,
  on: boolean,
  by: Actor,
): void {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (on && RULES_END_IN.has(project.state)) {
    throw new DomainError(
      'invalid',
      `project ${projectId} is ${project.state}: it takes no Waykeeper approvals`,
    );
  }
  const { waykeeperApprovals: _old, ...row } = project;
  ctx.tables.projects.upsert(on ? { ...row, waykeeperApprovals: true } : row);
  ctx.emit({ type: 'waykeeper_approvals.set', projectId, on, by });
}

/** Records an approval on the project, keeping the newest `MAX_RECORDED_APPROVALS`. */
export function recordApproval(
  ctx: CommandContext,
  projectId: Id,
  approval: RecordedApproval,
): void {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const recorded = [...(project.recordedApprovals ?? []), approval].slice(-MAX_RECORDED_APPROVALS);
  ctx.tables.projects.upsert({ ...project, recordedApprovals: recorded });
  ctx.emit({ type: 'approval.recorded', projectId, approval });
}

/** Stores a standing approval for `projectId`; returns it. Refused for a project that ended. */
export function addStandingApproval(
  ctx: CommandContext,
  projectId: Id,
  draft: { kind: string; examples: string[] },
  made: { by: Actor; origin: RequestOrigin; questionId?: Id },
): StandingApproval {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (RULES_END_IN.has(project.state)) {
    throw new DomainError(
      'invalid',
      `project ${projectId} is ${project.state}: it takes no standing approvals`,
    );
  }
  const approval: StandingApproval = {
    id: `sa-${randomUUID()}`,
    projectId,
    kind: draft.kind,
    examples: draft.examples,
    createdBy: made.by,
    createdAt: ctx.now,
    origin: made.origin,
    ...(made.questionId ? { questionId: made.questionId } : {}),
  };
  ctx.tables.projects.upsert({
    ...project,
    standingApprovals: [...(project.standingApprovals ?? []), approval],
  });
  ctx.emit({ type: 'standing_approval.added', approval });
  return approval;
}

/** Removes one standing approval; `not_found` when the project has no such approval. */
export function removeStandingApproval(
  ctx: CommandContext,
  projectId: Id,
  approvalId: Id,
  by: Actor,
  reason: string,
): StandingApproval {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const approval = project.standingApprovals?.find((a) => a.id === approvalId);
  if (!approval) {
    throw new DomainError(
      'not_found',
      `project ${projectId} has no standing approval ${approvalId}`,
    );
  }
  const rest = project.standingApprovals!.filter((a) => a.id !== approvalId);
  const { standingApprovals: _old, ...row } = project;
  ctx.tables.projects.upsert(rest.length > 0 ? { ...row, standingApprovals: rest } : row);
  ctx.emit({ type: 'standing_approval.removed', projectId, approvalId, by, reason });
  return approval;
}

/**
 * Ends the standing approvals of a project that ended, as the system, and forgets its recorded
 * approvals (they carry no event of their own: they follow the removals).
 */
export function endStandingApprovals(
  ctx: CommandContext,
  projectId: Id,
  to: 'completed' | 'archived' | 'cancelled',
): void {
  const approvals = ctx.tables.projects.get(projectId)?.standingApprovals ?? [];
  const why =
    to === 'completed'
      ? 'the project was closed'
      : to === 'cancelled'
        ? 'the project was cancelled'
        : 'the project was archived';
  for (const a of approvals) removeStandingApproval(ctx, projectId, a.id, SYSTEM, why);
  const project = ctx.tables.projects.get(projectId);
  if (project?.recordedApprovals) {
    const { recordedApprovals: _old, ...row } = project;
    ctx.tables.projects.upsert(row);
  }
}
