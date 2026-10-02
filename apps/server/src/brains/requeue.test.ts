import { describe, expect, it } from 'vitest';
import type { Event, EventEnvelope } from '@galactic/protocol';
import { requeue } from './requeue.js';
import type { WakeRules, WakeScope } from './wake.js';

/**
 * The mailbox a brain had at a crash, rebuilt from the log (P2-16): after the last turn it
 * received, without its own side effects or messages it already got.
 */

const B = 'a-brain';
const USER = { type: 'user' } as const;
const SYSTEM = { type: 'system' } as const;

/** Every listed type wakes the brain; the line is the type plus a tag. */
const tagOf = (e: Event) => (e as unknown as { tag?: string }).tag ?? '';
const always = { wakes: () => true, describe: (e: Event) => `${e.type} ${tagOf(e)}`.trim() };
const RULES = {
  'message.sent': {
    wakes: (e: Extract<Event, { type: 'message.sent' }>) => e.agentId === B,
    describe: (e: Extract<Event, { type: 'message.sent' }>) => `said ${e.text}`,
  },
  'task.created': always,
  'control.pause': always,
  'agent.finished': always,
  'question.cancelled': always,
} as unknown as WakeRules;
const scope = { brainId: B, role: 'waykeeper' } as unknown as WakeScope;

function logOf(events: Partial<Event>[]) {
  // One `at` per command: every event its own, unless it names the command it belongs to (`cmd`).
  const envelopes = events.map((event, i) => ({
    seq: i + 1,
    at: `2026-10-02T00:00:${String((event as { cmd?: number }).cmd ?? i).padStart(2, '0')}.000Z`,
    event: event as Event,
  })) as EventEnvelope[];
  return {
    upTo: envelopes.length,
    log: {
      eventsSince: (seq: number, limit: number) =>
        envelopes.filter((e) => e.seq > seq).slice(0, limit),
    },
  };
}

const created = { type: 'agent.created', agent: { id: B } } as unknown as Event;
const sent = (id: string, sender: typeof USER | typeof SYSTEM, text = id): Partial<Event> =>
  ({ type: 'message.sent', messageId: id, agentId: B, sender, text, interrupt: false }) as Event;
const delivered = (id: string): Partial<Event> =>
  ({ type: 'message.delivered', messageId: id, agentId: B }) as Event;
const task = (tag: string) => ({ type: 'task.created', tag }) as unknown as Event;
const lines = (events: Partial<Event>[]) => {
  const { log, upTo } = logOf(events);
  return requeue(log, B, scope, RULES, upTo).map((i) => i.line);
};

describe('requeue (P2-16)', () => {
  it('keeps what came after the last delivered turn, minus the brain’s own turn effects', () => {
    expect(
      lines([
        created,
        task('before the turn'), // folded into the turn below
        sent('turn-1', SYSTEM),
        delivered('turn-1'),
        task('own'), // during its own turn, no actor: its own create_task
        sent('during', USER), // during its turn, from the user: kept
        {
          type: 'control.pause',
          target: { kind: 'agent', id: 'x' },
          by: { type: 'agent', id: B },
        } as Event,
        { type: 'agent.idle', agentId: B } as Event,
        task('after'), // after the turn: kept
        {
          type: 'control.pause',
          target: { kind: 'agent', id: 'x' },
          by: { type: 'agent', id: B },
          tag: 'own',
        } as Event,
        sent('late', USER),
      ]),
    ).toEqual(['said during', 'task.created after', 'said late']);
  });

  it('a turn that never reached the brain is folded again; a message it got is not', () => {
    expect(
      lines([
        created,
        sent('turn-1', SYSTEM),
        delivered('turn-1'),
        { type: 'agent.idle', agentId: B } as Event,
        sent('folded', USER),
        sent('turn-2', SYSTEM), // the crash came before its delivery
        sent('got', USER),
        delivered('got'),
      ]),
    ).toEqual(['said folded']);
  });

  it('a session reset (or an earlier resume) is a cut too', () => {
    expect(
      lines([
        created,
        sent('old', USER),
        { type: 'agent.interrupted', agentId: B, reason: 'session reset' } as Event,
        { type: 'agent.spawned', agentId: B } as Event,
        { type: 'agent.idle', agentId: B } as Event,
        sent('new', USER),
      ]),
    ).toEqual(['said new']);
  });

  it('keeps other agents’ lifecycle in the brain’s own turn, not what its own command caused', () => {
    expect(
      lines([
        created,
        sent('turn-1', SYSTEM),
        delivered('turn-1'),
        { type: 'agent.finished', agentId: 'a-steward', tag: 'other' } as unknown as Event,
        task('own'),
        // One command of the brain (stop_steward): its actor-less effect goes with it.
        {
          type: 'control.pause',
          target: { kind: 'agent', id: 'x' },
          by: { type: 'agent', id: B },
          cmd: 90,
        } as unknown as Event,
        { type: 'question.cancelled', agentId: 'x', tag: 'own', cmd: 90 } as unknown as Event,
        { type: 'question.cancelled', agentId: 'y', tag: 'other' } as unknown as Event,
        { type: 'agent.idle', agentId: B } as Event,
      ]),
    ).toEqual(['agent.finished other', 'question.cancelled other']);
  });

  it('an earlier reopen cuts at its watermark once its first turn ended', () => {
    const before = [
      created,
      sent('turn-1', SYSTEM),
      delivered('turn-1'),
      { type: 'agent.idle', agentId: B } as Event,
      { type: 'agent.interrupted', agentId: B, reason: 'server restarted' } as Event,
      task('recovery noise'), // seq 6: folded into the reopened session's first prompt
    ];
    const spawned = { type: 'agent.spawned', agentId: B, foldedUpTo: 6 } as unknown as Event;
    // The first turn ended: nothing up to the watermark comes back (no double fold).
    expect(
      lines([...before, spawned, { type: 'agent.idle', agentId: B } as Event, task('after')]),
    ).toEqual(['task.created after']);
    // The session was lost before its first turn ended: what it was given is folded again.
    expect(
      lines([
        ...before,
        spawned,
        { type: 'agent.interrupted', agentId: B, reason: 'resume failed' } as Event,
        task('after'),
      ]),
    ).toEqual(['task.created recovery noise', 'task.created after']);
  });
});
