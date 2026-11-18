import { randomUUID } from 'node:crypto';
import {
  excerpt,
  isGrantLive,
  quoteFound,
  SEND_GRANT_MAX_DAYS,
  type Actor,
  type AnswerSendPermissionInput,
  type Event,
  type Id,
  type Question,
  type RequestOrigin,
  type SendGrant,
  type Settings,
} from '@galactic/protocol';
import type { Database } from '../db/database.js';
import type { Tables } from '../db/tables.js';
import { redactSecrets } from '../runtime/redact.js';
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

/** The reason an Allow once on a send-permission card is logged with. */
export const ALLOWED_ONCE = 'Allowed once by Cosmin.';

/**
 * The user's Allow once on a send-permission card (P13-27; design §4.4 step 3): logged as
 * `permission.decided{allow, allowedBy: 'allow_once'}` in the answer's own transaction, for the
 * approvals log. No grant is made. Anything else — a deny, an answer by anyone but the user, a
 * question without `sendPermission` — logs nothing here.
 */
export function logAllowOnce(
  ctx: CommandContext,
  question: Question,
  answer: string,
  by: Actor,
): void {
  const send = question.context.sendPermission;
  const call = question.context.toolCall;
  if (question.kind !== 'permission' || !send || !call) return;
  if (answer !== 'allow' || by.type !== 'user') return;
  const action = question.context.permissionAction;
  ctx.emit({
    type: 'permission.decided',
    agentId: question.originAgentId,
    questionId: question.id,
    // The question's call and parts were redacted when it opened.
    toolCall: call,
    decision: 'allow',
    ...(action ? { action } : {}),
    reason: ALLOWED_ONCE,
    decidedBy: by,
    allowedBy: 'allow_once',
    ...(send.parts.length > 0 ? { parts: send.parts } : {}),
  });
}

/** A user's reply to a send-permission question (P13-28): what he wrote, and from where. */
export interface SendPermissionReply {
  text: string;
  /** Unknown counts as remote. */
  origin: RequestOrigin;
}

/**
 * The user's replies to the send-permission question `question` (P13-28; design §4.4 step 4),
 * oldest first: every `message.sent` from the user that replies to it, and every other chat line
 * of his to its decider `deciderId` since it opened — except one replying to another question.
 * The verbatim check of a grant's words runs against these texts only.
 */
export function sendPermissionReplies(
  db: Database,
  question: Question,
  deciderId: Id,
): SendPermissionReply[] {
  const rows = db
    .prepare(
      `SELECT payload FROM events
        WHERE type = 'message.sent' AND at >= ?
          AND json_extract(payload, '$.sender.type') = 'user'
          AND (
            (json_extract(payload, '$.replyTo.kind') = 'question'
              AND json_extract(payload, '$.replyTo.id') = ?)
            OR (json_extract(payload, '$.agentId') = ?
              AND (json_extract(payload, '$.replyTo.kind') IS NULL
                OR json_extract(payload, '$.replyTo.kind') != 'question'))
          )
        ORDER BY id`,
    )
    .all(question.createdAt, question.id, deciderId) as { payload: string }[];
  return rows.flatMap((r) => {
    const e = JSON.parse(r.payload) as Event;
    if (e.type !== 'message.sent' || e.turn) return [];
    return [{ text: e.text, origin: e.origin ?? 'remote' }];
  });
}

/** What the Steward is told when its held send is not allowed. */
export const NOT_ALLOWED = 'Cosmin did not allow this';
/** How much of the user's reply the Steward is told on a deny. */
export const DENY_REPLY_MAX = 300;

/** The deny the Steward gets (P13-28): "Cosmin did not allow this: <his last reply>". */
export function notAllowedText(replies: readonly SendPermissionReply[]): string {
  const last = replies.at(-1)?.text.trim();
  if (!last) return `${NOT_ALLOWED}.`;
  return `${NOT_ALLOWED}: ${excerpt(redactSecrets(last), DENY_REPLY_MAX)}`;
}

/**
 * The checks of a decider's answer to a send-permission question (P13-28; design §4.4): the
 * question is open, carries `sendPermission` and names `agentId` as its decider; an `allow` comes
 * only after the user replied, and its grant's `words` are a verbatim span of one of his replies.
 * Throws the refusal (`stale`, `forbidden`, `invalid`); returns the replies and, for a grant, the
 * reply its words were found in.
 */
export function checkSendPermissionAnswer(
  db: Database,
  question: Question,
  input: AnswerSendPermissionInput,
): { replies: SendPermissionReply[]; from?: SendPermissionReply } {
  const send = question.context.sendPermission;
  if (question.kind !== 'permission' || !send) {
    throw new DomainError('invalid', `question ${question.id} is not a send permission question`);
  }
  if (question.status !== 'open') {
    throw new DomainError('stale', `question ${question.id} is ${question.status} already`);
  }
  if (send.deciderId === undefined || send.deciderId !== input.agentId) {
    throw new DomainError(
      'forbidden',
      `question ${question.id} is not yours to decide: only its card's buttons answer it`,
    );
  }
  const replies = sendPermissionReplies(db, question, input.agentId);
  if (input.decision === 'deny') return { replies };
  if (replies.length === 0) {
    throw new DomainError(
      'invalid',
      `Cosmin has not replied to question ${question.id}: only his reply allows a send. Wait for it`,
    );
  }
  if (!input.grant) return { replies };
  const { words, summary } = input.grant;
  if (words.trim() === '' || summary.trim() === '') {
    throw new DomainError('invalid', 'a grant needs words and a summary');
  }
  const from = replies.find((r) => quoteFound(words, [r.text]));
  if (!from) {
    throw new DomainError(
      'invalid',
      "grant.words must be Cosmin's exact words, copied from his reply to this question",
    );
  }
  return { replies, from };
}

/**
 * A decider's checked answer to a held send, for the runtime (P13-28): `reason` is logged with
 * the allow and closes the question; on a deny it is what the Steward is told. `grant` makes the
 * grant in its own transaction before anything else (a refused grant changes nothing).
 */
export type HeldSendAnswer =
  | {
      decision: 'allow';
      deciderId: Id;
      reason: string;
      grant?: (ctx: CommandContext) => SendGrant;
    }
  | { decision: 'deny'; deciderId: Id; reason: string };
