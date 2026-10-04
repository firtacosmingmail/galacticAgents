import type { EventEnvelope, Id } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { questionBody, waitsForUser } from '../beacons/beacon-model.js';

/**
 * Event toasts as data (P4-06; TECHNOLOGY §2.1). No three.js, no React: `Toasts.tsx` draws them.
 *
 * A toast is a brief, subtle flare on a body when something worth a glance happens there:
 * - **completed** — a task or a project completes (`task/project.state_changed → completed`): a
 *   warm ring (the colonised lights' white, decision 77) expands from the body and fades, while
 *   its satellite lands;
 * - **question** — a question starts waiting for the user (`question.opened`, or escalated /
 *   reassigned to the user): one amber ring (the waiting colour, decision 72), under its beacon.
 *
 * Only **live** events toast: an event whose `at` is older than `fresh` (a catch-up replay after a
 * reconnect, a page loaded on a busy log) is history, not news. One toast per body and kind at a
 * time (a burst of completions on a planet flares once), at most `max` at once (the oldest go
 * first). Under reduced motion a toast is a still, dimmer ring held for `stillMs`, then gone.
 */

export type ToastKind = 'completed' | 'question';

export interface Toast {
  kind: ToastKind;
  bodyId: Id;
  /** When it started, in ms on the page's clock (`performance.now()`). */
  startedAt: number;
}

export const TOAST = {
  /** Expanding flare. */
  durationMs: 1_600,
  /** Reduced motion: a still ring, shown this long. */
  stillMs: 1_200,
  /** At most this many at once (mobile-friendly; a flare is one draw call). */
  max: 4,
  /** An event older than this (by its `at`, on the wall clock) does not toast. */
  freshMs: 5_000,
  /** Ring radius in body radii: from `from` to `to` (still: `still`). */
  from: 1.15,
  to: 2.4,
  still: 1.5,
  /** The ring is never smaller on screen than this (an asteroid, the whole-system view). */
  minPx: 22,
  /** Peak opacity (additive), and the still one. */
  peak: 0.75,
  stillOpacity: 0.45,
  color: { completed: '#ffe6b8', question: '#ffb547' } as Record<ToastKind, string>,
} as const;

type ToastWorld = Pick<WorldState, 'tasks' | 'projects' | 'questions' | 'agents'>;

/** The toast an event calls for, read against the world it produced; none for most events. */
export function toastOf(
  envelope: EventEnvelope,
  world: ToastWorld,
): { kind: ToastKind; bodyId: Id } | undefined {
  const { event } = envelope;
  switch (event.type) {
    case 'task.state_changed': {
      if (event.to !== 'completed') return undefined;
      const bodyId = world.tasks[event.taskId]?.bodyId;
      return bodyId ? { kind: 'completed', bodyId } : undefined;
    }
    case 'project.state_changed': {
      if (event.to !== 'completed') return undefined;
      const bodyId = world.projects[event.projectId]?.bodyId;
      return bodyId ? { kind: 'completed', bodyId } : undefined;
    }
    case 'question.opened':
    case 'question.escalated':
    case 'question.reassigned': {
      const id = event.type === 'question.opened' ? event.question.id : event.questionId;
      const question = world.questions[id];
      if (!question || !waitsForUser(question)) return undefined;
      const bodyId = questionBody(world, question);
      return bodyId ? { kind: 'question', bodyId } : undefined;
    }
    default:
      return undefined;
  }
}

/** Whether an event is news (logged within `freshMs` of `wallNow`), not history. */
export function isFresh(
  envelope: EventEnvelope,
  wallNow: number,
  freshMs = TOAST.freshMs,
): boolean {
  const at = Date.parse(envelope.at);
  return Number.isFinite(at) && wallNow - at <= freshMs;
}

/** How long a toast lasts. */
export const lifetime = (reducedMotion: boolean): number =>
  reducedMotion ? TOAST.stillMs : TOAST.durationMs;

/**
 * The toasts after `incoming` started at `now`: expired ones dropped, a body's running toast of
 * the same kind restarted rather than doubled, and only the newest `max` kept.
 */
export function addToasts(
  current: readonly Toast[],
  incoming: readonly { kind: ToastKind; bodyId: Id }[],
  now: number,
  reducedMotion: boolean,
  max: number = TOAST.max,
): Toast[] {
  const life = lifetime(reducedMotion);
  let out = current.filter((t) => now - t.startedAt < life);
  for (const t of incoming) {
    out = out.filter((o) => !(o.bodyId === t.bodyId && o.kind === t.kind));
    out.push({ kind: t.kind, bodyId: t.bodyId, startedAt: now });
  }
  return out.slice(-max);
}

/** What a toast draws at `now`: ring radius (body radii) and opacity; `undefined` once over. */
export function toastLook(
  toast: Toast,
  now: number,
  reducedMotion: boolean,
): { radius: number; opacity: number } | undefined {
  const age = now - toast.startedAt;
  if (age < 0) return { radius: TOAST.from, opacity: 0 };
  if (reducedMotion) {
    return age < TOAST.stillMs ? { radius: TOAST.still, opacity: TOAST.stillOpacity } : undefined;
  }
  if (age >= TOAST.durationMs) return undefined;
  const t = age / TOAST.durationMs;
  const ease = 1 - (1 - t) ** 3; // fast out, slow settle
  // A quick rise (first 12 %), then a long fade.
  const rise = Math.min(1, t / 0.12);
  return {
    radius: TOAST.from + (TOAST.to - TOAST.from) * ease,
    opacity: TOAST.peak * rise * (1 - t) ** 2,
  };
}

/** The log's envelopes newer than `afterSeq`, oldest first (the store keeps them newest first). */
export function newEnvelopes(log: readonly EventEnvelope[], afterSeq: number): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  for (const e of log) {
    if (e.seq <= afterSeq) break;
    out.push(e);
  }
  return out.reverse();
}
