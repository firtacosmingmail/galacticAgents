import type { Agent, Body, BodyKind, Host, Id } from '@galactic/protocol';
import { isReserved } from './catalogue.js';
import { DomainError, must, notFound } from './errors.js';
import type { CommandContext } from './event-log.js';
import { unparkWaiting } from './parking.js';
import { FINISHED_WORK } from './states.js';

/**
 * Body commands (P2-01; SPEC §3.1, §3.4). A body hosts at most one project or standalone task;
 * project tasks live on their project's body and never occupy one of their own (decision 9).
 * Reserved bodies (the Sun, Earth, Earth's Moon — seeded by migration 0005 with `meta.reserved`)
 * are never assigned. Which free body a new project should get is the catalogue's choice
 * (`catalogue.ts`, P2-02); these are the moves. A body the work moved away from shows a "moved
 * to …" marker (`movedTo`, decision 15) and is not assignable until it is freed.
 */

export { createAsteroid, isReserved } from './catalogue.js';

const sameHost = (a: Host | undefined, b: Host): boolean => a?.kind === b.kind && a.id === b.id;

/** The body hosting `host`, if any. */
export function bodyOf(ctx: CommandContext, host: Host): Body | undefined {
  return ctx.tables.bodies.all().find((b) => sameHost(b.host, host));
}

/** Projects go on planets and moons, standalone tasks on asteroids (SPEC §3.1). */
const KINDS: Record<Host['kind'], readonly BodyKind[]> = {
  project: ['planet', 'moon'],
  task: ['asteroid'],
};

/** The current state of what a host points at; refuses unknown hosts and project tasks. */
function hostEntity(ctx: CommandContext, host: Host): { bodyId: Id; state: string } {
  if (host.kind === 'project') return must(ctx.tables.projects.get(host.id), 'project', host.id);
  const task = must(ctx.tables.tasks.get(host.id), 'task', host.id);
  if (task.projectId) {
    throw new DomainError('invalid', `task ${task.id} lives on its project's body`);
  }
  return task;
}

/**
 * A sub-project lives on a moon of its parent's planet (SPEC §3.2); `parentBodyId` is the parent
 * project's body.
 */
export function checkSubProjectBody(body: Body, parentBodyId: Id | undefined): void {
  if (parentBodyId === undefined) return;
  if (body.kind !== 'moon' || body.parentId !== parentBodyId) {
    throw new DomainError(
      'invalid',
      `a sub-project lives on a moon of its parent's planet, not on ${body.name}`,
    );
  }
}

/** The body of a project's parent, when it is a sub-project. */
export function parentBodyOf(ctx: CommandContext, host: Host): Id | undefined {
  if (host.kind !== 'project') return undefined;
  const parentId = ctx.tables.projects.get(host.id)?.parentProjectId;
  return parentId ? ctx.tables.projects.get(parentId)?.bodyId : undefined;
}

/** Refuses a body that cannot take `host`: reserved, the wrong kind, or taken by someone else. */
export function checkAssignable(body: Body, host: Host): void {
  if (isReserved(body)) throw new DomainError('conflict', `${body.name} is reserved`);
  if (body.movedTo && !body.host) {
    throw new DomainError(
      'conflict',
      `${body.name} shows "moved to ${body.movedTo.bodyId}" until its retention ends`,
    );
  }
  if (!KINDS[host.kind].includes(body.kind)) {
    throw new DomainError('invalid', `a ${host.kind} cannot live on a ${body.kind}`);
  }
  if (body.host && !sameHost(body.host, host)) {
    throw new DomainError(
      'conflict',
      `${body.name} already hosts ${body.host.kind} ${body.host.id}`,
    );
  }
}

/** Sets `body.host` and emits `body.assigned`. The caller has checked the body. */
export function occupy(ctx: CommandContext, body: Body, host: Host): Body {
  if (sameHost(body.host, host)) return body;
  const next = ctx.tables.bodies.upsert({ ...body, host });
  ctx.emit({ type: 'body.assigned', bodyId: body.id, host });
  return next;
}

/**
 * The work on `from` left for `toBodyId` (SPEC §3.4): `from` loses its host and shows the "moved
 * to …" marker, stamped with the command's clock, and `body.moved` announces it (the satellite
 * flies). With `intoProjectId` a standalone task joined that project's body, whose host stays.
 */
export function markMoved(
  ctx: CommandContext,
  from: Body,
  host: Host,
  toBodyId: Id,
  intoProjectId?: Id,
): Body {
  const { host: _old, ...rest } = from;
  const marked = ctx.tables.bodies.upsert({
    ...rest,
    movedTo: { bodyId: toBodyId, host, at: ctx.now },
  });
  ctx.emit({
    type: 'body.moved',
    host,
    fromBodyId: from.id,
    toBodyId,
    ...(intoProjectId ? { intoProjectId } : {}),
  });
  return marked;
}

/**
 * Points the hosted row at its new body and announces it. A project's tasks live on its body
 * (decision 9), so they follow it.
 */
function rehome(ctx: CommandContext, host: Host, bodyId: Id): void {
  if (host.kind === 'project') {
    const project = must(ctx.tables.projects.get(host.id), 'project', host.id);
    if (project.bodyId === bodyId) return;
    ctx.tables.projects.upsert({ ...project, bodyId, updatedAt: ctx.now });
    ctx.emit({ type: 'project.updated', projectId: host.id, changes: { bodyId } });
    for (const task of ctx.tables.tasks.all()) {
      if (task.projectId === host.id && task.bodyId === project.bodyId)
        setTaskBody(ctx, task.id, bodyId);
    }
  } else {
    setTaskBody(ctx, host.id, bodyId);
  }
}

function setTaskBody(ctx: CommandContext, taskId: Id, bodyId: Id): void {
  const task = must(ctx.tables.tasks.get(taskId), 'task', taskId);
  if (task.bodyId === bodyId) return;
  ctx.tables.tasks.upsert({ ...task, bodyId, updatedAt: ctx.now });
  ctx.emit({ type: 'task.updated', taskId, changes: { bodyId } });
}

/**
 * Agents working on `host` that orbit `fromBodyId` follow it to `toBodyId` (their satellites
 * fly): a task's Steward, or a project's Waykeeper and the Stewards of its tasks.
 */
export function moveAgents(ctx: CommandContext, host: Host, fromBodyId: Id, toBodyId: Id): Agent[] {
  const projectTasks =
    host.kind === 'project'
      ? new Set(
          ctx.tables.tasks
            .all()
            .filter((t) => t.projectId === host.id)
            .map((t) => t.id),
        )
      : new Set<Id>();
  const works = (a: Agent) =>
    host.kind === 'project'
      ? a.projectId === host.id || (a.taskId !== undefined && projectTasks.has(a.taskId))
      : a.taskId === host.id;
  return ctx.tables.agents
    .all()
    .filter((a) => works(a) && a.bodyId === fromBodyId)
    .map((a) => {
      const agent = ctx.tables.agents.upsert({ ...a, bodyId: toBodyId, updatedAt: ctx.now });
      ctx.emit({ type: 'agent.updated', agentId: a.id, changes: { bodyId: toBodyId } });
      return agent;
    });
}

/**
 * Puts a host that has no body yet (or whose body was freed) on `bodyId`. A host that already
 * lives on another body moves with `moveHost` instead.
 */
export function assignBody(ctx: CommandContext, bodyId: Id, host: Host): Body {
  const entity = hostEntity(ctx, host);
  if (FINISHED_WORK.has(entity.state as never)) {
    throw new DomainError(
      'invalid_transition',
      `${host.kind} ${host.id} is ${entity.state}; reopen it instead`,
    );
  }
  return place(ctx, bodyId, host);
}

/** `assignBody` without the state check: reopening finished work puts it back on a body. */
export function place(ctx: CommandContext, bodyId: Id, host: Host): Body {
  const body = must(ctx.tables.bodies.get(bodyId), 'body', bodyId);
  const entity = hostEntity(ctx, host);
  checkAssignable(body, host);
  checkSubProjectBody(body, parentBodyOf(ctx, host));
  const current = bodyOf(ctx, host);
  if (current && current.id !== bodyId) {
    throw new DomainError(
      'conflict',
      `${host.kind} ${host.id} already lives on ${current.name}; move it instead`,
    );
  }
  const next = occupy(ctx, body, host);
  rehome(ctx, host, bodyId);
  moveAgents(ctx, host, entity.bodyId, bodyId);
  return next;
}

/**
 * Moves a hosted project or standalone task to another free body (SPEC §3.4): `body.moved`, the
 * row's `bodyId`, and the agents orbiting the old body with it. The old body shows the "moved to
 * …" marker until `sweepMarkers` frees it after the retention period (decision 15).
 */
export function moveHost(ctx: CommandContext, host: Host, toBodyId: Id): Body {
  const to = must(ctx.tables.bodies.get(toBodyId), 'body', toBodyId);
  hostEntity(ctx, host);
  const from = bodyOf(ctx, host);
  if (!from) throw new DomainError('invalid', `${host.kind} ${host.id} has no body to move from`);
  if (from.id === to.id) return to;
  checkAssignable(to, host);
  checkSubProjectBody(to, parentBodyOf(ctx, host));
  markMoved(ctx, from, host, toBodyId);
  const next = ctx.tables.bodies.upsert({ ...to, host });
  rehome(ctx, host, toBodyId);
  moveAgents(ctx, host, from.id, toBodyId);
  return next;
}

/**
 * Frees a body whose occupant is finished (completed, archived, failed or moved): an active
 * project or task keeps its body. A body showing only a "moved to …" marker is freed early (the
 * user needs the space, decision 16). Freeing a free body is a no-op.
 */
export function freeBody(ctx: CommandContext, bodyId: Id): Body {
  const body = must(ctx.tables.bodies.get(bodyId), 'body', bodyId);
  if (!body.host) return release(ctx, body);
  const occupant =
    body.host.kind === 'project'
      ? ctx.tables.projects.get(body.host.id)
      : ctx.tables.tasks.get(body.host.id);
  if (!occupant) throw notFound(body.host.kind, body.host.id);
  if (!FINISHED_WORK.has(occupant.state)) {
    throw new DomainError(
      'conflict',
      `${body.name} hosts ${body.host.kind} ${body.host.id}, which is ${occupant.state}`,
    );
  }
  return release(ctx, body);
}

/** Clears the host and the marker and emits `body.freed`, unchecked (archival, retention). */
export function release(ctx: CommandContext, body: Body): Body {
  if (!body.host && !body.movedTo) return body;
  const { host: _host, movedTo: _marker, ...freed } = body;
  const next = ctx.tables.bodies.upsert(freed);
  ctx.emit({ type: 'body.freed', bodyId: body.id });
  // A card parked for want of this kind of body un-parks in the same transaction (P2-09).
  unparkWaiting(ctx);
  return next;
}

/** Decision 4's default retention period, until the settings page (P2-13) makes it configurable. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The retention sweep for "moved to …" markers (decision 15): frees every body whose marker is at
 * least `retentionMs` old by the command's clock (`ctx.now`, injectable through the event log).
 * P2-13's scheduler calls it; it returns the bodies it freed, in catalogue order of the table.
 */
export function sweepMarkers(
  ctx: CommandContext,
  retentionMs: number = DEFAULT_RETENTION_MS,
): Body[] {
  const now = Date.parse(ctx.now);
  return ctx.tables.bodies
    .all()
    .filter((b) => !b.host && b.movedTo && Date.parse(b.movedTo.at) + retentionMs <= now)
    .map((b) => release(ctx, b));
}
