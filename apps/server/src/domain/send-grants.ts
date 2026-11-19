import { randomUUID } from 'node:crypto';
import {
  excerpt,
  isGrantInForce,
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
  type WorkState,
} from '@galactic/protocol';
import type { Database } from '../db/database.js';
import type { Tables } from '../db/tables.js';
import { redactSecrets } from '../runtime/redact.js';
import { DomainError, must } from './errors.js';
import { cancelQuestion } from './questions.js';
import type { CommandContext } from './event-log.js';
import { saveStandalone, standaloneOf } from './waykeeper-approvals.js';

/**
 * Send grants as rows (Auto, design 2026-11-18): the user's words allowing sends or spends for a
 * project (its row's `sendGrants`) or for standalone work (the 'standalone' row). Changed only
 * here, each change with its event in the caller's transaction, folded alike by `applyEvent`.
 * A grant's end, its removal and the project's end are code, never the model.
 */

const SYSTEM: Actor = { type: 'system' };
/** A project in one of these takes no grant: closed, archived, or failed (a cancel too). */
const GRANTS_END_IN: ReadonlySet<WorkState> = new Set<WorkState>([
  'completed',
  'archived',
  'failed',
]);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Stores a grant; returns it. `endsAt` must be after `now` and at most `SEND_GRANT_MAX_DAYS`
 * ahead (`invalid`). Refused for a project that ended: closed, archived, failed or cancelled.
 * `now` is epoch milliseconds.
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
    if (GRANTS_END_IN.has(project.state)) {
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

/** The grant `grantId` (its `projectId` absent: standalone), or `not_found`. */
export function findGrant(tables: Tables, grantId: Id): SendGrant {
  const standalone = standaloneOf(tables).sendGrants.find((g) => g.id === grantId);
  if (standalone) return standalone;
  for (const p of tables.projects.all()) {
    const found = p.sendGrants?.find((g) => g.id === grantId);
    if (found) return found;
  }
  throw new DomainError('not_found', `no send grant ${grantId}`);
}

/**
 * Removes a grant on the user's say; `forbidden` for anyone else. With `scope`, a grant of
 * another scope (a project's, or standalone's when `scope.projectId` is absent) is `not_found`.
 * Returns it.
 */
export function removeSendGrant(
  ctx: CommandContext,
  grantId: Id,
  by: Actor,
  reason: string,
  scope?: { projectId?: Id },
): SendGrant {
  if (by.type !== 'user') {
    throw new DomainError('forbidden', 'only the user removes a send grant');
  }
  if (scope && findGrant(ctx.tables, grantId).projectId !== scope.projectId) {
    throw new DomainError('not_found', `no send grant ${grantId} here`);
  }
  return takeGrant(ctx, grantId, by, reason);
}

/**
 * Ends a grant on the decider's say, carrying out Cosmin's answer to a grant-conflict question
 * (P13-34): only `resolveGrantConflict` calls it, after checking the answered question. Logged
 * as `send_grant.removed` with `by` the decider. Direct removal stays the user's alone.
 */
export function endGrantByAnswer(
  ctx: CommandContext,
  grantId: Id,
  deciderId: Id,
  reason: string,
): SendGrant {
  return takeGrant(ctx, grantId, { type: 'agent', id: deciderId }, reason);
}

/** Writes `grant` back in place, in its project's row or standalone's. */
function putGrant(ctx: CommandContext, grant: SendGrant): void {
  const swap = (all: readonly SendGrant[]) => all.map((g) => (g.id === grant.id ? grant : g));
  if (grant.projectId === undefined) {
    const standalone = standaloneOf(ctx.tables);
    saveStandalone(ctx.tables, { ...standalone, sendGrants: swap(standalone.sendGrants) });
    return;
  }
  const project = must(ctx.tables.projects.get(grant.projectId), 'project', grant.projectId);
  ctx.tables.projects.upsert({ ...project, sendGrants: swap(project.sendGrants ?? []) });
}

/** Pauses `grant` for the grant-conflict question `questionId` (P13-34): it covers nothing. */
export function pauseGrant(ctx: CommandContext, grant: SendGrant, questionId: Id): void {
  putGrant(ctx, { ...grant, pausedBy: questionId });
  ctx.emit({
    type: 'send_grant.paused',
    grantId: grant.id,
    ...(grant.projectId !== undefined ? { projectId: grant.projectId } : {}),
    questionId,
  });
}

/** Lets a grant paused by `questionId` count again (P13-34); any other grant is left alone. */
export function unpauseGrant(
  ctx: CommandContext,
  grant: SendGrant,
  questionId: Id,
  reason: string,
): void {
  if (grant.pausedBy !== questionId) return;
  const { pausedBy: _old, ...rest } = grant;
  putGrant(ctx, rest);
  ctx.emit({
    type: 'send_grant.unpaused',
    grantId: grant.id,
    ...(grant.projectId !== undefined ? { projectId: grant.projectId } : {}),
    questionId,
    reason,
  });
}

/** Every stored grant (live or not) paused by `questionId`. */
export function grantsPausedBy(tables: Tables, questionId: Id): SendGrant[] {
  return [
    ...standaloneOf(tables).sendGrants,
    ...tables.projects.all().flatMap((p) => p.sendGrants ?? []),
  ].filter((g) => g.pausedBy === questionId);
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

/** Every stored grant of a scope (a project's, or standalone's when `projectId` is absent). */
export function grantsOf(tables: Tables, scope: { projectId?: Id }): SendGrant[] {
  return scope.projectId === undefined
    ? standaloneOf(tables).sendGrants
    : (tables.projects.get(scope.projectId)?.sendGrants ?? []);
}

/**
 * The grants of a scope (a project's, or standalone's when `projectId` is absent) in force: live
 * and not paused by a grant-conflict question (`isGrantInForce`, P13-34). Only these cover a send.
 */
export function liveGrants(tables: Tables, scope: { projectId?: Id }, now: number): SendGrant[] {
  return grantsOf(tables, scope).filter((g) => isGrantInForce(g, now));
}

/**
 * Ends every grant of a project that ended, as the system, and withdraws its open grant-conflict
 * questions (P13-34): nothing is left to reconcile.
 */
export function endSendGrants(ctx: CommandContext, projectId: Id, reason: string): void {
  for (const g of ctx.tables.projects.get(projectId)?.sendGrants ?? []) {
    takeGrant(ctx, g.id, SYSTEM, reason);
  }
  for (const q of ctx.tables.questions.all()) {
    if (q.status === 'open' && q.context.grantConflict?.projectId === projectId) {
      cancelQuestion(ctx, q.id, reason);
    }
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
 * The rule that takes a plain chat line as an answer (final review I2; P13-33), for the decider
 * `deciderId`: given a user line's event id and time — a `message.sent` to `deciderId` that does
 * not reply to a question — the send-permission question it answers, or `undefined`. It answers
 * one only when that question was the decider's only open send-permission question at the line's
 * event, opened at or before the line's time. With two open, it answers neither; with none, it is
 * an ordinary line. Fixed once the line is logged: a question opened later never counts, and how
 * the question closes afterwards does not matter. `sendPermissionReplies` and `userWordsFor` (which
 * leaves such a line out of the task words) both use it, so the two cannot drift.
 */
export function plainLineAnswer(
  db: Database,
  deciderId: Id,
): (eventId: number, at: string) => Id | undefined {
  // The decider's send-permission questions, as event-id spans [opened, closed).
  const spans = db
    .prepare(
      `SELECT json_extract(o.payload, '$.question.id') AS questionId,
              json_extract(o.payload, '$.question.createdAt') AS createdAt,
              o.id AS opened,
              (SELECT MIN(c.id) FROM events c
                WHERE c.type IN ('question.answered', 'question.cancelled')
                  AND json_extract(c.payload, '$.questionId') =
                    json_extract(o.payload, '$.question.id')) AS closed
         FROM events o
        WHERE o.type = 'question.opened'
          AND json_extract(o.payload, '$.question.context.sendPermission.deciderId') = ?`,
    )
    .all(deciderId) as {
    questionId: Id;
    createdAt: string;
    opened: number;
    closed: number | null;
  }[];
  return (eventId, at) => {
    const open = spans.filter(
      (s) => s.opened < eventId && (s.closed === null || s.closed > eventId),
    );
    const [only] = open;
    return open.length === 1 && only && only.createdAt <= at ? only.questionId : undefined;
  };
}

/**
 * The user's replies to the send-permission question `question` (P13-28; design §4.4 step 4;
 * final review I2), oldest first, since it opened: every `message.sent` from the user that
 * replies to it (`replyTo`), and every other chat line of his to its decider `deciderId` — not
 * one replying to a question — that `plainLineAnswer` takes as an answer to it: sent while
 * `question` was the decider's only open send-permission question. With two open, a plain "yes"
 * answers neither. An allow needs one of these, and a grant's words are checked against these
 * texts only.
 */
export function sendPermissionReplies(
  db: Database,
  question: Question,
  deciderId: Id,
): SendPermissionReply[] {
  const rows = db
    .prepare(
      `SELECT id, at, payload FROM events
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
    .all(question.createdAt, question.id, deciderId) as {
    id: number;
    at: string;
    payload: string;
  }[];
  const answers = plainLineAnswer(db, deciderId);
  return rows.flatMap((r) => {
    const e = JSON.parse(r.payload) as Event;
    if (e.type !== 'message.sent' || e.turn) return [];
    const toThis = e.replyTo?.kind === 'question' && e.replyTo.id === question.id;
    if (!toThis && answers(r.id, r.at) !== question.id) return [];
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
 * only after the user replied (`sendPermissionReplies`: a reply to it, or a chat line to the
 * decider while it was the decider's only open one), and its grant's `words` are a verbatim span
 * of one of those replies.
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
