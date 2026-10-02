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
 *   - or the interruption before a new session (`agent.interrupted` followed by `agent.spawned`:
 *     a session reset or an earlier resume), whose first prompt folded what waited;
 *   - else the brain's creation.
 *
 * Its own side effects: the turn that starts at the cut ran the brain's tools. Inside it (until
 * the brain's next `agent.idle` or end) only events with an actor other than the brain are kept —
 * a line from the user, an answer, a decision, a control action — since an event without an actor
 * (a task the brain created, a question it withdrew) may be its own and its effect is in the seed
 * anyway. After that turn the brain was idle: every event the rules let through is kept, except
 * one the brain itself is the actor of.
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
        if (event.agentId === brainId) interruptedAt = seq;
        break;
      case 'agent.spawned':
        if (event.agentId !== brainId) break;
        if (interruptedAt !== undefined) cut = Math.max(cut, interruptedAt);
        interruptedAt = undefined;
        break;
      default:
        break;
    }
  }

  // Pass 2: what woke the brain after the cut.
  const items: RequeuedItem[] = [];
  let inOwnTurn = true;
  for (const { seq, at, event } of envelopes(log, cut, upTo)) {
    if (seq <= cut) continue;
    if (ownLifecycle(event, brainId)) {
      if (ENDS_TURN.has(event.type)) inOwnTurn = false;
      continue;
    }
    if (event.type === 'message.sent' && delivered.has(event.messageId)) continue;
    // The runner's own turn prompts: what they folded is requeued itself.
    if (turnMessages.has((event as { messageId?: Id }).messageId ?? '')) continue;
    const actor = actorOf(event);
    if (isAgent(actor, brainId)) continue;
    if (inOwnTurn && !actor) continue;
    const line = wakeLine(event, scope, rules);
    if (line !== undefined) items.push({ seq, at, event, line });
  }
  return items;
}
