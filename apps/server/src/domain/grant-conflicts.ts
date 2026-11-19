import { randomUUID } from 'node:crypto';
import {
  GRANT_CONFLICT_MAX_OWN_OPTIONS,
  GRANT_CONFLICT_OPTION_MAX,
  GRANT_CONFLICT_OPTIONS,
  isGrantLive,
  quoteFound,
  type Agent,
  type AskGrantConflictInput,
  type Event,
  type GrantConflictContext,
  type Id,
  type Question,
  type RequestOrigin,
  type ResolveGrantConflictInput,
  type ResolveGrantConflictResult,
  type SendGrant,
} from '@galactic/protocol';
import type { Database } from '../db/database.js';
import type { Tables } from '../db/tables.js';
import { redactSecrets } from '../runtime/redact.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { COMMAND_SOURCE, openQuestion } from './questions.js';
import {
  addSendGrant,
  endGrantByAnswer,
  findGrant,
  grantsPausedBy,
  pauseGrant,
  sendPermissionReplies,
  unpauseGrant,
} from './send-grants.js';

/**
 * Grant conflicts (P13-34, SPEC decision 166): when Cosmin's new words about what may be sent
 * conflict with (or overlap) a grant in force, the decider — the project's Waykeeper, or the
 * Harmonizer for standalone work — does not act on them: it asks him how to reconcile them. The
 * question is user-held (kind `permission`, never answered by an LLM — decision 7); its grants are
 * paused (`SendGrant.pausedBy`) until the decider carries out his answer, or the question closes
 * without one. Whether words conflict is the model's judgement; everything else is checked here.
 */

/** `meta.grantConflictResolved`: when the decider carried out the answer (the question's end). */
export const GRANT_CONFLICT_RESOLVED = 'grantConflictResolved';
/** `meta.newWordsOrigin`: where the new words were typed (unknown counts as remote). */
const NEW_WORDS_ORIGIN = 'newWordsOrigin';

const USER = { type: 'user' } as const;

/** The scope a decider decides for: a Waykeeper's project, or standalone work for a Harmonizer. */
export function deciderScope(agent: Agent | undefined): { projectId?: Id } | undefined {
  if (agent?.role === 'waykeeper' && agent.projectId !== undefined) {
    return { projectId: agent.projectId };
  }
  if (agent?.role === 'harmonizer') return {};
  return undefined;
}

/** Whether the grant-conflict question was carried out by its decider. */
export function isConflictResolved(question: Pick<Question, 'meta'>): boolean {
  return question.meta?.[GRANT_CONFLICT_RESOLVED] !== undefined;
}

/** A grant-conflict question that still decides its grants: open, or answered but not carried out. */
function pending(question: Question): boolean {
  return (
    question.status === 'open' || (question.status === 'answered' && !isConflictResolved(question))
  );
}

/**
 * The grant-conflict question still pending (open, or answered but not carried out) about the
 * send-permission question `sendQuestionId`, if any: while it is, that send is decided by it.
 */
export function pendingConflictAbout(tables: Tables, sendQuestionId: Id): Question | undefined {
  return tables.questions
    .all()
    .find((q) => q.context.grantConflict?.sendQuestionId === sendQuestionId && pending(q));
}

/** "Earlier you said: "…" (until …). Now you said: "…". These conflict. What should I do?" */
export function conflictText(grants: readonly SendGrant[], newWords: string): string {
  const said = grants
    .map((g) => `"${g.words}" (${g.endsAt !== undefined ? `until ${g.endsAt}` : 'no end'})`)
    .join('; and: ');
  return `Earlier you said: ${said}. Now you said: "${newWords}". These conflict. What should I do?`;
}

interface UserLine {
  text: string;
  origin: RequestOrigin;
}

/** Cosmin's chat lines to `deciderId` at or after `since`, oldest first. */
function linesTo(db: Database, deciderId: Id, since: string): UserLine[] {
  const rows = db
    .prepare(
      `SELECT payload FROM events
        WHERE type = 'message.sent' AND at >= ?
          AND json_extract(payload, '$.sender.type') = 'user'
          AND json_extract(payload, '$.agentId') = ?
        ORDER BY id`,
    )
    .all(since, deciderId) as { payload: string }[];
  return rows.flatMap((r) => {
    const e = JSON.parse(r.payload) as Event;
    if (e.type !== 'message.sent' || e.turn) return [];
    return [{ text: e.text, origin: e.origin ?? 'remote' }];
  });
}

/** The decider's own options: trimmed, at most 3 of at most 200 characters, none a fixed one. */
function ownOptions(options: readonly string[] | undefined): string[] {
  const own = (options ?? []).map((o) => (typeof o === 'string' ? o.trim() : ''));
  if (own.length > GRANT_CONFLICT_MAX_OWN_OPTIONS) {
    throw new DomainError(
      'invalid',
      `at most ${GRANT_CONFLICT_MAX_OWN_OPTIONS} options of your own`,
    );
  }
  for (const o of own) {
    if (o === '' || o.length > GRANT_CONFLICT_OPTION_MAX) {
      throw new DomainError('invalid', `each option is 1–${GRANT_CONFLICT_OPTION_MAX} characters`);
    }
    if ((GRANT_CONFLICT_OPTIONS as readonly string[]).includes(o)) {
      throw new DomainError('invalid', `"${o}" is offered already`);
    }
  }
  return [...new Set(own.map((o) => redactSecrets(o)))];
}

/**
 * Opens a grant-conflict question for `input.agentId` and pauses its grants, in one transaction.
 * Refused: an agent that decides nothing (`forbidden`); no grant, or a grant of another scope
 * (`not_found`), ended, or paused by another question still open (`conflict`); `newWords` that are
 * not Cosmin's verbatim — from his reply on `sendQuestionId` (an open send-permission question this
 * decider decides), else from a message of his to the decider since the newest grant was made.
 * A grant paused by an answered question its decider never carried out is taken over.
 */
export function askGrantConflict(
  ctx: CommandContext,
  db: Database,
  input: AskGrantConflictInput,
  now: number,
): Question {
  const { tables } = ctx;
  const deciderId = input.agentId;
  const scope = deciderScope(tables.agents.get(deciderId));
  if (!scope) {
    throw new DomainError('forbidden', 'only a Waykeeper or the Harmonizer asks about grants');
  }
  const ids = [...new Set(input.grantIds ?? [])];
  if (ids.length === 0) throw new DomainError('invalid', 'name at least one grant in force');
  const newWords = typeof input.newWords === 'string' ? input.newWords.trim() : '';
  if (newWords === '' || newWords.length > 2000) {
    throw new DomainError('invalid', "newWords must be Cosmin's words (1–2000 characters)");
  }
  const options = ownOptions(input.options);
  const grants = ids.map((id) => {
    const g = findGrant(tables, id);
    if (g.projectId !== scope.projectId) {
      throw new DomainError('not_found', `no send grant ${id} here`);
    }
    if (!isGrantLive(g, now)) {
      throw new DomainError('invalid', `send grant ${id} has ended: it is not in force`);
    }
    if (g.pausedBy !== undefined) {
      const by = tables.questions.get(g.pausedBy);
      if (by?.status === 'open') {
        throw new DomainError(
          'conflict',
          `send grant ${id} is paused already: Cosmin is asked about it in question ${by.id}`,
        );
      }
    }
    return g;
  });

  let origin: RequestOrigin;
  if (input.sendQuestionId !== undefined) {
    const send = must(tables.questions.get(input.sendQuestionId), 'question', input.sendQuestionId);
    if (send.kind !== 'permission' || !send.context.sendPermission) {
      throw new DomainError('invalid', `question ${send.id} is not a send permission question`);
    }
    if (send.status !== 'open') {
      throw new DomainError('stale', `question ${send.id} is ${send.status} already`);
    }
    if (send.context.sendPermission.deciderId !== deciderId) {
      throw new DomainError('forbidden', `question ${send.id} is not yours to decide`);
    }
    const from = sendPermissionReplies(db, send, deciderId).find((r) =>
      quoteFound(newWords, [r.text]),
    );
    if (!from) {
      throw new DomainError(
        'invalid',
        `newWords must be Cosmin's exact words, copied from his reply to question ${send.id}`,
      );
    }
    origin = from.origin;
  } else {
    const since = grants
      .map((g) => g.createdAt)
      .sort()
      .at(-1)!;
    const from = linesTo(db, deciderId, since).find((l) => quoteFound(newWords, [l.text]));
    if (!from) {
      throw new DomainError(
        'invalid',
        "newWords must be Cosmin's exact words, copied from a message of his to you since the grant was made",
      );
    }
    origin = from.origin;
  }

  const words = redactSecrets(newWords);
  const grantConflict: GrantConflictContext = {
    deciderId,
    ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}),
    grants: grants.map((g) => ({
      id: g.id,
      words: g.words,
      summary: g.summary,
      ...(g.endsAt !== undefined ? { endsAt: g.endsAt } : {}),
    })),
    newWords: words,
    ...(input.sendQuestionId !== undefined ? { sendQuestionId: input.sendQuestionId } : {}),
    options,
  };
  const question = openQuestion(ctx, {
    id: `q-${randomUUID()}`,
    kind: 'permission',
    originAgentId: deciderId,
    holder: USER,
    context: {
      text: conflictText(grants, words),
      options: [...GRANT_CONFLICT_OPTIONS, ...options],
      grantConflict,
    },
    meta: { source: COMMAND_SOURCE, toUser: true, [NEW_WORDS_ORIGIN]: origin },
  });
  for (const g of grants) pauseGrant(ctx, g, question.id);
  return question;
}

/** The part of his answer he wrote himself: nothing when he picked one of the options. */
function answerWords(question: Question): string[] {
  const answer = question.answer?.trim() ?? '';
  if (answer === '' || (question.context.options ?? []).includes(answer)) return [];
  return [answer];
}

/**
 * Carries out Cosmin's answer to a grant-conflict question, in one transaction: the grants in
 * `endGrantIds` end (`send_grant.removed`, `by` the decider, the reason quoting his answer), the
 * question's other grants count again, `newGrant` is made (its `questionId` this question), and
 * the question is marked resolved. Refused: another decider's question (`forbidden`), one he has
 * not answered (`invalid`), closed or resolved already (`stale`), a grant not in it (`invalid`), a
 * grant now paused by another question (`stale`), `newGrant.words` not quoted from the new words
 * or his answer (`invalid`), an end in the past or over 90 days (`invalid`, `addSendGrant`). A
 * grant that ended meanwhile (removed, or its project ended) is skipped.
 */
export function resolveGrantConflict(
  ctx: CommandContext,
  input: ResolveGrantConflictInput,
  now: number,
): ResolveGrantConflictResult & { scope: { projectId?: Id } } {
  const { tables } = ctx;
  const question = must(tables.questions.get(input.questionId), 'question', input.questionId);
  const conflict = question.context.grantConflict;
  if (question.kind !== 'permission' || !conflict) {
    throw new DomainError('invalid', `question ${question.id} is not a grant-conflict question`);
  }
  if (conflict.deciderId !== input.agentId || question.originAgentId !== input.agentId) {
    throw new DomainError('forbidden', `question ${question.id} is not yours to carry out`);
  }
  if (question.status === 'open') {
    throw new DomainError(
      'invalid',
      `Cosmin has not answered question ${question.id}: wait for his answer`,
    );
  }
  if (question.status !== 'answered' || question.answeredBy?.type !== 'user') {
    throw new DomainError('stale', `question ${question.id} was closed without his answer`);
  }
  if (isConflictResolved(question)) {
    throw new DomainError('stale', `question ${question.id} was carried out already`);
  }
  const listed = new Set(conflict.grants.map((g) => g.id));
  const ending = [...new Set(input.endGrantIds ?? [])];
  for (const id of ending) {
    if (!listed.has(id)) {
      throw new DomainError('invalid', `send grant ${id} is not in question ${question.id}`);
    }
  }
  const stored = new Map<Id, SendGrant>();
  for (const id of listed) {
    let g: SendGrant;
    try {
      g = findGrant(tables, id);
    } catch {
      continue; // Ended meanwhile: nothing left to end or keep.
    }
    if (g.pausedBy !== question.id) {
      throw new DomainError(
        'stale',
        `send grant ${id} is no longer paused by question ${question.id}` +
          (g.pausedBy ? ` (question ${g.pausedBy} asks about it now)` : ''),
      );
    }
    stored.set(id, g);
  }
  let newGrant: ResolveGrantConflictInput['newGrant'];
  let origin: RequestOrigin = 'remote';
  if (input.newGrant) {
    const words = input.newGrant.words?.trim() ?? '';
    const summary = input.newGrant.summary?.trim() ?? '';
    if (words === '' || summary === '') {
      throw new DomainError('invalid', 'a grant needs words and a summary');
    }
    if (quoteFound(words, [conflict.newWords])) {
      const o = question.meta?.[NEW_WORDS_ORIGIN];
      origin = o === 'local' ? 'local' : 'remote';
    } else if (!quoteFound(words, answerWords(question))) {
      throw new DomainError(
        'invalid',
        "newGrant.words must be Cosmin's exact words: his new words or his answer to the question",
      );
    }
    newGrant = { ...input.newGrant, words, summary };
  }

  const answer = redactSecrets(question.answer ?? '');
  const reason = `Cosmin answered question ${question.id}: "${answer}"`;
  const ended: Id[] = [];
  const unpaused: Id[] = [];
  for (const [id, g] of stored) {
    if (ending.includes(id)) {
      endGrantByAnswer(ctx, id, input.agentId, reason);
      ended.push(id);
    } else {
      unpauseGrant(ctx, g, question.id, reason);
      unpaused.push(id);
    }
  }
  const grant = newGrant
    ? addSendGrant(
        ctx,
        {
          ...(conflict.projectId !== undefined ? { projectId: conflict.projectId } : {}),
          words: redactSecrets(newGrant.words),
          summary: redactSecrets(newGrant.summary),
          ...(newGrant.endsAt !== undefined ? { endsAt: newGrant.endsAt } : {}),
          createdBy: USER,
          origin,
          questionId: question.id,
        },
        now,
      )
    : undefined;
  tables.questions.upsert({
    ...question,
    meta: { ...question.meta, [GRANT_CONFLICT_RESOLVED]: ctx.now },
  });
  return {
    ended,
    unpaused,
    ...(grant ? { grant } : {}),
    scope: conflict.projectId !== undefined ? { projectId: conflict.projectId } : {},
  };
}

/**
 * A grant-conflict question closed without an answer (dismissed, its decider stopped, its project
 * ended): its grants count again — they return to what Cosmin last approved (P13-34). Called by
 * `cancelQuestion` in the same transaction.
 */
export function releaseConflictGrants(
  ctx: CommandContext,
  question: Question,
  reason: string,
): void {
  if (!question.context.grantConflict) return;
  for (const g of grantsPausedBy(ctx.tables, question.id)) {
    unpauseGrant(ctx, g, question.id, `the question closed without an answer: ${reason}`);
  }
}
