import {
  proposalPromotion,
  type Body,
  type BodyChoice,
  type BodyRequest,
  type Host,
  type Id,
  type Project,
  type PromotionOutcome,
  type PromotionRequest,
  type Proposal,
  type Task,
} from '@galactic/protocol';
import { moveAgents, moveHost } from './bodies.js';
import { chooseBody, isFree, type ChooseOptions, type Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { handOverTask, type HandOverOptions } from './handover.js';
import { createProject, updateProject } from './projects.js';
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
  ctx: Reader,
  bodyId: Id | undefined,
  kind: Body['kind'],
): Body | undefined {
  const body = bodyId ? ctx.tables.bodies.get(bodyId) : undefined;
  return body && body.kind === kind && isFree(body) ? body : undefined;
}

/**
 * The project a Waykeeper's moon becomes a sub-project of (SPEC §3.2): the requesting project —
 * unless the user put the card on a moon of another planet, which makes it a project of its own.
 */
export function promotedParent(ctx: Reader, p: Proposal, req: PromotionRequest): Id | undefined {
  if (req.target.kind !== 'task' || !req.fromProjectId || p.kind !== 'moon') return undefined;
  const from = ctx.tables.projects.get(req.fromProjectId);
  if (!from) return undefined;
  const named = p.proposedBody.bodyId ? ctx.tables.bodies.get(p.proposedBody.bodyId) : undefined;
  return !named || named.parentId === from.bodyId ? from.id : undefined;
}

/** The catalogue request of a promotion that needs a new body (none for a move into a project). */
export function promotionBodyRequest(ctx: Reader, p: Proposal): BodyRequest | undefined {
  const req = proposalPromotion(p);
  if (!req || req.toProjectId || p.kind === 'asteroid') return undefined;
  if (p.kind === 'planet') return { kind: 'planet' };
  const parentProjectId = promotedParent(ctx, p, req);
  return parentProjectId ? { kind: 'moon', parentProjectId } : { kind: 'moon' };
}

/**
 * The body a promotion gets now: the one the card names while it is free, of the card's kind and
 * (for a sub-project) a moon of the parent's planet; else the catalogue's choice. P2-09's
 * `roomFor` does the same for the Harmonizer's cards (and parks them when nothing is free).
 */
export function promotionRoom(
  ctx: Reader,
  p: Proposal,
  opts: ChooseOptions = {},
): BodyChoice | undefined {
  const request = promotionBodyRequest(ctx, p);
  if (!request) return undefined;
  const named = usableBody(ctx, p.proposedBody.bodyId, request.kind);
  if (named) {
    const parentPlanet =
      'parentProjectId' in request && request.parentProjectId
        ? ctx.tables.projects.get(request.parentProjectId)?.bodyId
        : undefined;
    if (!parentPlanet || named.parentId === parentPlanet) return { ok: true, body: named };
  }
  return chooseBody(ctx, request, opts);
}

/**
 * The new project of a task promotion card, on `body`: created once (found again by
 * `meta.proposalId`), with `meta.promotedFrom` — the permanent link in history (decision 15),
 * besides the `body.moved` event. A Waykeeper's moon is a sub-project of its project. Usable in
 * the approval transaction (P2-09's `carryOut`) as well as by the flow.
 */
export function createPromotedProject(ctx: CommandContext, p: Proposal, body: Body): Project {
  const existing = ctx.tables.projects.all().find((x) => x.meta?.['proposalId'] === p.id);
  if (existing) return existing;
  const req = proposalPromotion(p);
  if (!req || req.target.kind !== 'task' || req.toProjectId) {
    throw new DomainError('invalid', `proposal ${p.id} does not make a new project`);
  }
  if (p.kind === 'asteroid') {
    throw new DomainError('invalid', `proposal ${p.id} was resized to an asteroid: nothing grows`);
  }
  const task = must(ctx.tables.tasks.get(req.target.id), 'task', req.target.id);
  const parentProjectId = promotedParent(ctx, p, req);
  return createProject(ctx, {
    name: req.name ?? nameOf(task.description),
    workspace: p.workspace,
    kind: p.kind,
    bodyId: body.id,
    ...(parentProjectId ? { parentProjectId } : {}),
    meta: {
      proposalId: p.id,
      promotedFrom: {
        kind: 'task',
        taskId: task.id,
        bodyId: req.fromBodyId ?? task.bodyId,
        ...(task.projectId ? { projectId: task.projectId } : {}),
      },
    },
  });
}

/** A project name from a task description: its first line, at most 60 characters. */
export function nameOf(description: string): string {
  const line = description.split('\n')[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59)}…` : line || 'Promoted task';
}
