import type { Actor, Event, EventEnvelope, Id } from '@galactic/protocol';
import { wakeLine, type WakeRules, type WakeScope } from './wake.js';

/**
 * The mailbox a brain had when the server went down (P2-16; TECHNOLOGY §5.2). The mailbox lives
 * in memory, so a resumed brain rebuilds it from the log: every event after the last turn the
 * brain actually received that its wake rules let through, minus its own side effects and the
 * messages it already got. The first turn after the resume folds them in.
 *
 * Where the brain's knowledge ends (the cut):
 *   - its last turn message (`message.sent` from the system) that has a `message.delivered`: the
 *     runner drained the mailbox into that prompt, so everything before it was seen;
 *   - or an earlier reopen whose first turn ended: its `agent.spawned{foldedUpTo}` says how far
 *     its first prompt folded the log, and the cut is there once the brain's next `agent.idle`
 *     shows that session took the turn (a session lost before it did folded nothing);
 *   - or the interruption before a new session without a watermark (`agent.interrupted` followed
 *     by `agent.spawned`: a session reset), whose first prompt folded what waited;
 *   - else the brain's creation.
 *
 * Its own side effects: the turn that starts at the cut (and the first turn of every session that
 * starts after it) ran the brain's tools. Inside such a turn (until the brain's next `agent.idle`
 * or end) an event without an actor may be the brain's own (a task it created) and its effect is
 * in the seed anyway, so it is dropped — unless it is another agent's lifecycle (`agent.*` of
 * another agent: a Steward finished), a question event or a proposal decision, which the brain's
 * tools never produce, and it is not in the same command as an event the brain is the actor of
 * (one command, one `at`). Events with an actor other than the brain are kept — a line from the
 * user, an answer, a control action. Outside its turns the brain was idle: every event the rules
 * let through is kept, except one the brain itself is the actor of.
 */

/** One requeued line, as the runner's mailbox holds it. */
export interface RequeuedItem {
  seq: number;
  at: string;
  event: Event;
  line: string;
}

/** What `requeue` reads: the log, paged. */
export interface RequeueLog {
  eventsSince(seq: number, limit: number): EventEnvelope[];
}

const PAGE = 5_000;
const ENDS_TURN = new Set([
  'agent.idle',
  'agent.interrupted',
  'agent.finished',
  'agent.failed',
  'agent.stopped',
]);

function* envelopes(log: RequeueLog, from: number, upTo: number): Generator<EventEnvelope> {
  let since = from;
  for (;;) {
    const page = log.eventsSince(since, PAGE);
    for (const env of page) {
      if (env.seq > upTo) return;
      since = env.seq;
      yield env;
    }
    if (page.length < PAGE) return;
  }
}

/** Who did it, when the event says (`by`, `answeredBy`, `sender`, `from`, a question's asker). */
export function actorOf(event: Event): Actor | undefined {
  if (event.type === 'question.opened') {
    return { type: 'agent', id: event.question.originAgentId };
  }
  const record = event as unknown as Record<string, unknown>;
  for (const key of ['by', 'answeredBy', 'sender', 'from']) {
    const value = record[key];
    if (value && typeof value === 'object' && 'type' in value) return value as Actor;
  }
  return undefined;
}

const isAgent = (actor: Actor | undefined, id: Id) => actor?.type === 'agent' && actor.id === id;

/** An actor-less event the brain's own tools never produce (see the module comment). */
function notTheBrains(event: Event, brainId: Id): boolean {
  if (event.type.startsWith('agent.')) {
    return 'agentId' in event && event.agentId !== brainId;
  }
  return (
    event.type.startsWith('question.') ||
    event.type.startsWith('proposal.') ||
    event.type === 'promotion.carried_out'
  );
}

/** The brain's own lifecycle and delivery events (never a wake). */
function ownLifecycle(event: Event, brainId: Id): boolean {
  return 'agentId' in event && event.agentId === brainId && event.type !== 'message.sent';
}

/**
 * The events `brainId` had not consumed by `upTo`, as mailbox lines in log order. `scope` and
 * `rules` are the brain's wake scope and table.
 */
export function requeue(
  log: RequeueLog,
  brainId: Id,
  scope: WakeScope,
  rules: WakeRules | undefined,
  upTo: number,
): RequeuedItem[] {
  // Pass 1: the cut and the messages the brain already received.
  let cut = 0;
  let interruptedAt: number | undefined;
  /** An earlier reopen's watermark, until its first turn ends (or the session is lost). */
  let folding: number | undefined;
  const turnMessages = new Map<Id, number>();
  const delivered = new Set<Id>();
  for (const { seq, event } of envelopes(log, 0, upTo)) {
    switch (event.type) {
      case 'agent.created':
        if (event.agent.id === brainId && cut === 0) cut = seq;
        break;
      case 'message.sent':
        if (event.agentId === brainId && event.sender.type === 'system') {
          turnMessages.set(event.messageId, seq);
        }
        break;
      case 'message.delivered':
        if (event.agentId !== brainId) break;
        delivered.add(event.messageId);
        cut = Math.max(cut, turnMessages.get(event.messageId) ?? 0);
        break;
      case 'agent.interrupted':
        if (event.agentId === brainId) {
          interruptedAt = seq;
          folding = undefined;
        }
        break;
      case 'agent.finished':
      case 'agent.failed':
      case 'agent.stopped':
        if (event.agentId === brainId) folding = undefined;
        break;
      case 'agent.idle':
        if (event.agentId !== brainId || folding === undefined) break;
        cut = Math.max(cut, folding);
        folding = undefined;
        break;
      case 'agent.spawned':
        if (event.agentId !== brainId) break;
        if (event.foldedUpTo !== undefined) folding = event.foldedUpTo;
        else if (interruptedAt !== undefined) cut = Math.max(cut, interruptedAt);
        interruptedAt = undefined;
        break;
      default:
        break;
    }
  }

  // Pass 2: what woke the brain after the cut.
  const items: RequeuedItem[] = [];
  let inOwnTurn = true;
  // The command an event belongs to (one `at` per command) and the last actor seen in it.
  let commandAt: string | undefined;
  let commandActor: Actor | undefined;
  for (const { seq, at, event } of envelopes(log, cut, upTo)) {
    if (seq <= cut) continue;
    if (at !== commandAt) {
      commandAt = at;
      commandActor = undefined;
    }
    const actor = actorOf(event);
    if (actor) commandActor = actor;
    if (ownLifecycle(event, brainId)) {
      if (ENDS_TURN.has(event.type)) inOwnTurn = false;
      // A new session's first turn runs the brain's tools too.
      if (event.type === 'agent.spawned') inOwnTurn = true;
      continue;
    }
    if (event.type === 'message.sent' && delivered.has(event.messageId)) continue;
    // The runner's own turn prompts: what they folded is requeued itself.
    if (turnMessages.has((event as { messageId?: Id }).messageId ?? '')) continue;
    if (isAgent(actor, brainId)) continue;
    if (inOwnTurn && !actor) {
      if (isAgent(commandActor, brainId) || !notTheBrains(event, brainId)) continue;
    }
    const line = wakeLine(event, scope, rules);
    if (line !== undefined) items.push({ seq, at, event, line });
  }
  return items;
}
