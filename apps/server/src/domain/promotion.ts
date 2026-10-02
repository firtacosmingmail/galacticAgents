import {
  proposalPromotion,
  type Body,
  type Host,
  type Id,
  type PromotionOutcome,
  type Proposal,
  type Task,
} from '@galactic/protocol';
import { moveAgents, moveHost } from './bodies.js';
import { isFree } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { handOverTask, type HandOverOptions } from './handover.js';
import { updateProject } from './projects.js';
import { FINISHED_WORK } from './states.js';

/**
 * The transactional steps of a promotion (P2-12; SPEC §3.4, decisions 2, 9, 15, 32). The
 * orchestration — pause, create, spawn, move, resume, report — is `brains/promotion.ts`; each
 * step here is one command (mutation + events in one transaction), and each is safe to repeat.
 */

/** A proposal is a promotion card (either shape): P2-09's approval flow leaves it to P2-12. */
export const isPromotion = (p: Pick<Proposal, 'meta'> | undefined): boolean =>
  proposalPromotion(p) !== undefined;

/** The outcome kept on a card that was carried out, if it was. */
export const carriedOut = (p: Pick<Proposal, 'meta'> | undefined): PromotionOutcome | undefined =>
  p?.meta?.['carriedOut'] as PromotionOutcome | undefined;

/**
 * A project task becomes the task of another project (a Waykeeper's task promoted to a moon or a
 * planet of its own): it lives on the new project's body from now on, its Stewards fly there and
 * are handed over to the new project's Waykeeper in the same command. The old project's body
 * keeps its host, so no body shows a marker; the new project's `meta.promotedFrom` is the link.
 */
export function transferTask(
  ctx: CommandContext,
  taskId: Id,
  toProjectId: Id,
  handOver: HandOverOptions = {},
): Task {
  const current = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (!current.projectId) {
    throw new DomainError('invalid', `task ${taskId} is a standalone task: move it instead`);
  }
  if (current.projectId === toProjectId) return current;
  if (FINISHED_WORK.has(current.state)) {
    throw new DomainError('invalid_transition', `task ${taskId} is ${current.state}`);
  }
  const project = must(ctx.tables.projects.get(toProjectId), 'project', toProjectId);
  if (project.state === 'archived') {
    throw new DomainError('invalid_transition', `project ${toProjectId} is archived`);
  }
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
  moveAgents(ctx, { kind: 'task', id: taskId }, current.bodyId, project.bodyId);
  handOverTask(ctx, taskId, handOver);
  return task;
}

/**
 * A project moves to a bigger (or other) body (a moon project promoted to a planet). A sub-project
 * that leaves its parent's planet becomes independent first — its Waykeeper is handed over to the
 * Harmonizer in the same command — then `moveHost` flies it (`body.moved`, the old body's marker).
 * A project with sub-project moons stays a planet: their moons orbit it.
 */
export function moveProject(
  ctx: CommandContext,
  projectId: Id,
  toBodyId: Id,
  handOver: HandOverOptions = {},
): Body {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const to = must(ctx.tables.bodies.get(toBodyId), 'body', toBodyId);
  if (project.bodyId === toBodyId) return to;
  const subs = ctx.tables.projects
    .all()
    .filter((p) => p.parentProjectId === projectId && p.state !== 'archived');
  if (subs.length > 0) {
    throw new DomainError(
      'conflict',
      `project ${projectId} has sub-projects on its planet's moons (${subs.map((p) => p.name).join(', ')}): it stays where it is`,
    );
  }
  if (project.parentProjectId) {
    const parentBody = ctx.tables.projects.get(project.parentProjectId)?.bodyId;
    if (to.kind !== 'moon' || to.parentId !== parentBody) {
      updateProject(ctx, projectId, { parentProjectId: null }, {}, handOver);
    }
  }
  const host: Host = { kind: 'project', id: projectId };
  return moveHost(ctx, host, toBodyId);
}

/**
 * The card records how it was carried out (`meta.carriedOut`) and `promotion.carried_out` wakes
 * the brain that owns it. Recorded once: the record is what makes the flow idempotent.
 */
export function recordPromotion(
  ctx: CommandContext,
  proposalId: Id,
  outcome: PromotionOutcome,
): Proposal {
  const current = must(ctx.tables.proposals.get(proposalId), 'proposal', proposalId);
  if (!isPromotion(current)) {
    throw new DomainError('invalid', `proposal ${proposalId} is not a promotion card`);
  }
  if (carriedOut(current)) return current;
  const proposal = ctx.tables.proposals.upsert({
    ...current,
    meta: { ...(current.meta ?? {}), carriedOut: outcome },
    updatedAt: ctx.now,
  });
  ctx.emit({ type: 'promotion.carried_out', proposalId, outcome });
  return proposal;
}

/** A body the card names that can still take the work: free and of the card's kind. */
export function usableBody(
  ctx: Pick<CommandContext, 'tables'>,
  bodyId: Id | undefined,
  kind: Body['kind'],
): Body | undefined {
  const body = bodyId ? ctx.tables.bodies.get(bodyId) : undefined;
  return body && body.kind === kind && isFree(body) ? body : undefined;
}
