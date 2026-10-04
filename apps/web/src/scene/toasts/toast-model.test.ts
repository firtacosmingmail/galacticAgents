import { describe, expect, it } from 'vitest';
import type { Event, EventEnvelope } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { emptyWorld, type WorldState } from '../../state/reduce.js';
import {
  TOAST,
  addToasts,
  isFresh,
  newEnvelopes,
  toastLook,
  toastOf,
  type Toast,
} from './toast-model.js';

const NOW = Date.parse(fx.NOW);
const env = (seq: number, event: Event, at = fx.NOW): EventEnvelope => ({ seq, at, event });

function world(): WorldState {
  const w = emptyWorld();
  w.projects = { [fx.project.id]: fx.project };
  w.tasks = {
    [fx.task.id]: { ...fx.task, state: 'completed' },
    [fx.asteroidTask.id]: fx.asteroidTask,
  };
  w.agents = { [fx.agent.id]: fx.agent, [fx.harmonizer.id]: fx.harmonizer };
  w.questions = {
    [fx.question.id]: fx.question, // held by the Waykeeper
    q9: { ...fx.question, id: 'q9', holder: { type: 'user' } },
    q10: { ...fx.question, id: 'q10', originAgentId: fx.harmonizer.id, holder: { type: 'user' } },
  };
  return w;
}

describe('which events toast (P4-06)', () => {
  it('flares a body when its task or project completes', () => {
    const w = world();
    expect(
      toastOf(
        env(1, { type: 'task.state_changed', taskId: 't-1', from: 'in_progress', to: 'completed' }),
        w,
      ),
    ).toEqual({ kind: 'completed', bodyId: 'b-luna' });
    expect(
      toastOf(
        env(2, {
          type: 'project.state_changed',
          projectId: 'p-1',
          from: 'in_progress',
          to: 'completed',
        }),
        w,
      ),
    ).toEqual({ kind: 'completed', bodyId: 'b-luna' });
    // Any other state change is quiet.
    expect(
      toastOf(
        env(3, { type: 'task.state_changed', taskId: 't-2', from: 'approved', to: 'in_progress' }),
        w,
      ),
    ).toBeUndefined();
    expect(
      toastOf(
        env(4, { type: 'task.state_changed', taskId: 't-1', from: 'completed', to: 'archived' }),
        w,
      ),
    ).toBeUndefined();
  });

  it('pings a body when a question starts waiting for the user, not for an agent', () => {
    const w = world();
    expect(toastOf(env(1, { type: 'question.opened', question: w.questions['q9']! }), w)).toEqual({
      kind: 'question',
      bodyId: 'b-luna',
    });
    // The Harmonizer's own question: Earth.
    expect(toastOf(env(2, { type: 'question.opened', question: w.questions['q10']! }), w)).toEqual({
      kind: 'question',
      bodyId: 'b-earth',
    });
    expect(toastOf(env(3, { type: 'question.opened', question: fx.question }), w)).toBeUndefined();
    expect(
      toastOf(
        env(4, {
          type: 'question.escalated',
          questionId: 'q9',
          from: { type: 'agent', id: 'a-waykeeper-1' },
          to: { type: 'user' },
          version: 1,
        }),
        w,
      ),
    ).toEqual({ kind: 'question', bodyId: 'b-luna' });
    expect(toastOf(env(5, { type: 'agent.idle', agentId: fx.agent.id }), w)).toBeUndefined();
  });

  it('only live events: a replayed backlog is history', () => {
    const e = env(1, { type: 'agent.idle', agentId: 'a' });
    expect(isFresh(e, NOW + 1_000)).toBe(true);
    expect(isFresh(e, NOW + TOAST.freshMs + 1)).toBe(false);
    expect(isFresh({ ...e, at: 'nonsense' }, NOW)).toBe(false);
  });

  it('reads the store’s newest-first log from a mark, oldest first', () => {
    const log = [5, 4, 3, 2].map((seq) => env(seq, { type: 'agent.idle', agentId: 'a' }));
    expect(newEnvelopes(log, 3).map((e) => e.seq)).toEqual([4, 5]);
    expect(newEnvelopes(log, 5)).toEqual([]);
  });
});

describe('toast lifetimes and the cap (P4-06)', () => {
  it('restarts a body’s running toast instead of doubling it, and keeps at most `max`', () => {
    let list: Toast[] = addToasts([], [{ kind: 'completed', bodyId: 'b-1' }], 0, false);
    list = addToasts(list, [{ kind: 'completed', bodyId: 'b-1' }], 100, false);
    expect(list).toEqual([{ kind: 'completed', bodyId: 'b-1', startedAt: 100 }]);
    // Another kind on the same body is its own toast.
    list = addToasts(list, [{ kind: 'question', bodyId: 'b-1' }], 120, false);
    expect(list).toHaveLength(2);
    const burst = Array.from({ length: 7 }, (_, i) => ({
      kind: 'completed' as const,
      bodyId: `b-${i + 10}`,
    }));
    list = addToasts(list, burst, 200, false);
    expect(list).toHaveLength(TOAST.max);
    expect(list.map((t) => t.bodyId)).toEqual(['b-13', 'b-14', 'b-15', 'b-16']);
    // Expired toasts go.
    expect(addToasts(list, [], 200 + TOAST.durationMs, false)).toEqual([]);
  });

  it('expands and fades with motion; is a still, dimmer ring under reduced motion', () => {
    const toast: Toast = { kind: 'completed', bodyId: 'b-1', startedAt: 0 };
    const early = toastLook(toast, 100, false)!;
    const mid = toastLook(toast, 600, false)!;
    const late = toastLook(toast, 1_400, false)!;
    expect(early.radius).toBeLessThan(mid.radius);
    expect(mid.radius).toBeLessThan(late.radius);
    expect(late.radius).toBeLessThanOrEqual(TOAST.to);
    expect(mid.opacity).toBeGreaterThan(late.opacity);
    expect(Math.max(early.opacity, mid.opacity)).toBeLessThanOrEqual(TOAST.peak);
    expect(toastLook(toast, TOAST.durationMs, false)).toBeUndefined();

    const a = toastLook(toast, 10, true)!;
    const b = toastLook(toast, 900, true)!;
    expect(a).toEqual(b); // nothing moves
    expect(a.opacity).toBeLessThan(TOAST.peak);
    expect(toastLook(toast, TOAST.stillMs, true)).toBeUndefined();
    // Reduced motion toasts are shorter-lived in the list too.
    expect(addToasts([toast], [], TOAST.stillMs, true)).toEqual([]);
  });
});
