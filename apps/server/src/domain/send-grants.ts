import { randomUUID } from 'node:crypto';
import {
  isGrantLive,
  SEND_GRANT_MAX_DAYS,
  type Actor,
  type Id,
  type SendGrant,
  type Settings,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { RULES_END_IN } from './project-rules.js';
import { saveStandalone, standaloneOf } from './waykeeper-approvals.js';

/**
 * Send grants as rows (Auto, design 2026-11-18): the user's words allowing sends or spends for a
 * project (its row's `sendGrants`) or for standalone work (the 'standalone' row). Changed only
 * here, each change with its event in the caller's transaction, folded alike by `applyEvent`.
 * A grant's end, its removal and the project's end are code, never the model.
 */

const SYSTEM: Actor = { type: 'system' };
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stores a grant; returns it. `endsAt` must be after `now` and at most `SEND_GRANT_MAX_DAYS`
 * ahead (`invalid`). Refused for a project that ended. `now` is epoch milliseconds.
 */
export function addSendGrant(
  ctx: CommandContext,
  input: Omit<SendGrant, 'id' | 'createdAt'>,
  now: number,
): SendGrant {
  if (input.endsAt !== undefined) {
    const ends = Date.parse(input.endsAt);
    if (!(ends > now)) {
      throw new DomainError('invalid', 'a send grant must end in the future');
    }
    if (ends > now + SEND_GRANT_MAX_DAYS * DAY_MS) {
      throw new DomainError('invalid', `a send grant lasts at most ${SEND_GRANT_MAX_DAYS} days`);
    }
  }
  const grant: SendGrant = { ...input, id: `sg-${randomUUID()}`, createdAt: ctx.now };
  if (input.projectId === undefined) {
    const standalone = standaloneOf(ctx.tables);
    saveStandalone(ctx.tables, { ...standalone, sendGrants: [...standalone.sendGrants, grant] });
  } else {
    const project = must(ctx.tables.projects.get(input.projectId), 'project', input.projectId);
    if (RULES_END_IN.has(project.state)) {
      throw new DomainError(
        'invalid',
        `project ${project.id} is ${project.state}: it takes no send grants`,
      );
    }
    ctx.tables.projects.upsert({ ...project, sendGrants: [...(project.sendGrants ?? []), grant] });
  }
  ctx.emit({ type: 'send_grant.added', grant });
  return grant;
}

/** The grant `grantId` and the project it belongs to (absent: standalone), or `not_found`. */
function findGrant(tables: Tables, grantId: Id): SendGrant {
  const standalone = standaloneOf(tables).sendGrants.find((g) => g.id === grantId);
  if (standalone) return standalone;
  for (const p of tables.projects.all()) {
    const found = p.sendGrants?.find((g) => g.id === grantId);
    if (found) return found;
  }
  throw new DomainError('not_found', `no send grant ${grantId}`);
}

/** Removes a grant on the user's say; `forbidden` for anyone else. Returns it. */
export function removeSendGrant(
  ctx: CommandContext,
  grantId: Id,
  by: Actor,
  reason: string,
): SendGrant {
  if (by.type !== 'user') {
    throw new DomainError('forbidden', 'only the user removes a send grant');
  }
  return takeGrant(ctx, grantId, by, reason);
}

function takeGrant(ctx: CommandContext, grantId: Id, by: Actor, reason: string): SendGrant {
  const grant = findGrant(ctx.tables, grantId);
  dropGrant(ctx, grant);
  ctx.emit({
    type: 'send_grant.removed',
    grantId,
    ...(grant.projectId !== undefined ? { projectId: grant.projectId } : {}),
    by,
    reason,
  });
  return grant;
}

function dropGrant(ctx: CommandContext, grant: SendGrant): void {
  if (grant.projectId === undefined) {
    const standalone = standaloneOf(ctx.tables);
    saveStandalone(ctx.tables, {
      ...standalone,
      sendGrants: standalone.sendGrants.filter((g) => g.id !== grant.id),
    });
    return;
  }
  const project = must(ctx.tables.projects.get(grant.projectId), 'project', grant.projectId);
  const rest = (project.sendGrants ?? []).filter((g) => g.id !== grant.id);
  const { sendGrants: _old, ...row } = project;
  ctx.tables.projects.upsert(rest.length > 0 ? { ...row, sendGrants: rest } : row);
}

/** The grants of a scope (a project's, or standalone's when `projectId` is absent) still live. */
export function liveGrants(tables: Tables, scope: { projectId?: Id }, now: number): SendGrant[] {
  const all =
    scope.projectId === undefined
      ? standaloneOf(tables).sendGrants
      : (tables.projects.get(scope.projectId)?.sendGrants ?? []);
  return all.filter((g) => isGrantLive(g, now));
}

/** Ends every grant of a project that ended, as the system. */
export function endSendGrants(ctx: CommandContext, projectId: Id, reason: string): void {
  for (const g of ctx.tables.projects.get(projectId)?.sendGrants ?? []) {
    takeGrant(ctx, g.id, SYSTEM, reason);
  }
}

/** Whether Auto is on for standalone work (asteroids and the Harmonizer's own). */
export function standaloneAutoOn(settings: Pick<Settings, 'standaloneAuto'>): boolean {
  return settings.standaloneAuto === true;
}
