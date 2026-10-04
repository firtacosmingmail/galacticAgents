import {
  describeTool,
  ENDED_STATES,
  type AgentState,
  type Body,
  type EventEnvelope,
  type Id,
  type StatusRecord,
} from '@galactic/protocol';
import { applyEvent, emptyWorld, type WorldState } from '../state/reduce.js';

/**
 * The timeline scrubber's replay (P4-07; TECHNOLOGY §6.3 "Timeline replay"): a pure fold from one
 * project's events (`GET /api/history/events`) to the world the scene draws at any point of its
 * history. The domain rows fold with the page's own reducer (`applyEvent`), the one the
 * conformance test holds to the server's tables, so a replay at the end shows what the live world
 * holds for that project.
 *
 * The world starts from the solar system as it is drawn with nothing on it: the bodies the client
 * knows (the catalogue is seeded without events, migration 0005) with no host and no "moved to …"
 * marker, and no work. Only the project's story is then folded in — other projects stay off the
 * map during a replay.
 */
export function replayBase(bodies: Record<Id, Body>): WorldState {
  const free: Record<Id, Body> = {};
  for (const [id, body] of Object.entries(bodies)) {
    const { host: _host, movedTo: _marker, ...rest } = body;
    free[id] = rest;
  }
  return { ...emptyWorld(), bodies: free };
}

/**
 * Status records replayed from the log's `agent.*` events, so satellites appear, change state and
 * land as they did. This is **not** the status projection (the server's `StatusStore` stays the one
 * implementation of live records, TECHNOLOGY §4): it keeps what the log alone says — the state, the
 * activity (`describeTool`, shared with the server, so archetypes read it the same way), the open
 * question — and leaves out what the log cannot tell (output-only activity, the silence threshold
 * between logged `agent.stalled` events, cap usage). An agent with no `agent.spawned` yet has no
 * record and therefore no satellite, as live.
 */
export function foldReplayStatus(
  statuses: Record<Id, StatusRecord>,
  { at, event }: EventEnvelope,
  paused: Map<Id, AgentState>,
): Record<Id, StatusRecord> {
  if (event.type === 'question.answered' || event.type === 'question.cancelled') {
    let next = statuses;
    for (const record of Object.values(statuses)) {
      if (record.pendingQuestionId !== event.questionId) continue;
      const { pendingQuestionId: _q, ...rest } = record;
      const state: AgentState =
        record.state === 'paused' || ENDED_STATES.has(record.state)
          ? record.state
          : event.type === 'question.answered'
            ? 'working'
            : 'idle';
      next = { ...next, [record.agentId]: { ...rest, state, lastEventAt: at } };
    }
    return next;
  }
  if (!event.type.startsWith('agent.') || event.type === 'agent.created') return statuses;
  if (event.type === 'agent.updated' || event.type === 'agent.output') return statuses;
  if (!('agentId' in event)) return statuses;
  const id = event.agentId;
  const current = statuses[id];
  if (event.type === 'agent.spawned') {
    paused.delete(id);
    return {
      ...statuses,
      [id]: {
        agentId: id,
        state: 'starting',
        startedAt: at,
        lastEventAt: at,
        caps: { wallClockMs: { used: 0, limit: 1 }, toolCalls: { used: 0, limit: 1 } },
      },
    };
  }
  // Before its first spawn an agent has no satellite; an ended record is a sink (as live).
  if (!current || ENDED_STATES.has(current.state)) return statuses;
  const isPaused = current.state === 'paused';
  const set = (changes: Partial<StatusRecord>, clear: (keyof StatusRecord)[] = []) => {
    const record: StatusRecord = { ...current, ...changes, lastEventAt: at };
    for (const key of clear) delete (record as Partial<StatusRecord>)[key];
    return { ...statuses, [id]: record };
  };
  const work = (state: AgentState) => (isPaused ? {} : { state });
  switch (event.type) {
    case 'agent.tool_call':
      return set({
        ...work('working'),
        currentActivity: describeTool(event.toolName, event.input),
      });
    case 'agent.progress':
      return set({
        ...work('working'),
        currentActivity: event.summary,
        ...(event.progress ? { progress: event.progress } : {}),
      });
    case 'agent.needs_input':
      return set({
        ...work('waiting_for_input'),
        pendingQuestionId: event.questionId,
        currentActivity: `${event.kind === 'permission' ? 'Permission' : 'Question'}: ${event.question.text}`,
      });
    case 'agent.idle':
      return set(work('idle'), ['pendingQuestionId']);
    case 'agent.stalled':
      return set(work('stalled'));
    case 'agent.paused':
      if (!isPaused) paused.set(id, current.state);
      return set({ state: 'paused' });
    case 'agent.resumed': {
      const before = paused.get(id);
      paused.delete(id);
      const state: AgentState = current.pendingQuestionId
        ? 'waiting_for_input'
        : before && before !== 'stalled'
          ? before
          : 'working';
      return set({ state });
    }
    case 'agent.finished':
      return set({ state: 'finished', currentActivity: event.result ?? 'Finished' }, [
        'pendingQuestionId',
      ]);
    case 'agent.failed':
      return set({ state: 'failed', currentActivity: event.error }, ['pendingQuestionId']);
    case 'agent.stopped':
      return set({ state: 'stopped' }, ['pendingQuestionId']);
    case 'agent.interrupted':
      return set({ state: 'interrupted', currentActivity: event.reason }, ['pendingQuestionId']);
    default:
      return statuses;
  }
}

/** What a tick on the timeline marks (the acceptance's assignments, moves, completions; questions). */
export type TickKind = 'assignment' | 'move' | 'completion' | 'question';

export function tickOf({ event }: EventEnvelope): TickKind | undefined {
  switch (event.type) {
    case 'body.assigned':
      return 'assignment';
    case 'body.moved':
      return 'move';
    case 'project.state_changed':
    case 'task.state_changed':
      return event.to === 'completed' ? 'completion' : undefined;
    case 'question.opened':
      return 'question';
    default:
      return undefined;
  }
}

/** World every this many events, so a scrub folds at most this many from the nearest one. */
export const CHECKPOINT_EVERY = 64;

/**
 * A replay over a fixed list of events: `worldAt(n)` is the world after the first `n` events
 * (0 … `events.length`). Checkpoints make any jump cheap; moving forward one step from the last
 * answer folds one event.
 */
export interface ReplayTimeline {
  readonly events: readonly EventEnvelope[];
  worldAt(n: number): WorldState;
  /** How many events happened at or before `time` (ms since the epoch). */
  countAt(time: number): number;
}

interface Folded {
  world: WorldState;
  paused: Map<Id, AgentState>;
}

const step = (s: Folded, envelope: EventEnvelope): Folded => {
  const world = applyEvent(s.world, envelope);
  const statuses = foldReplayStatus(world.statuses, envelope, s.paused);
  return { world: statuses === world.statuses ? world : { ...world, statuses }, paused: s.paused };
};

export function createReplayTimeline(
  base: WorldState,
  events: readonly EventEnvelope[],
): ReplayTimeline {
  const times = events.map((e) => Date.parse(e.at));
  const checkpoints: { world: WorldState; paused: Map<Id, AgentState> }[] = [];
  let s: Folded = { world: base, paused: new Map() };
  checkpoints.push({ world: s.world, paused: new Map(s.paused) });
  events.forEach((e, i) => {
    s = step(s, e);
    if ((i + 1) % CHECKPOINT_EVERY === 0)
      checkpoints.push({ world: s.world, paused: new Map(s.paused) });
  });
  let last: { n: number; folded: Folded } | undefined;
  return {
    events,
    worldAt(n) {
      const target = Math.max(0, Math.min(events.length, Math.floor(n)));
      if (last && last.n === target) return last.folded.world;
      let from: number;
      let folded: Folded;
      if (last && last.n < target && target - last.n <= CHECKPOINT_EVERY) {
        from = last.n;
        folded = last.folded;
      } else {
        const c = checkpoints[Math.floor(target / CHECKPOINT_EVERY)]!;
        from = Math.floor(target / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
        folded = { world: c.world, paused: new Map(c.paused) };
      }
      for (let i = from; i < target; i++) folded = step(folded, events[i]!);
      last = { n: target, folded };
      return folded.world;
    },
    countAt(time) {
      // Events are in `seq` order, and their times rise with it (one clock, read once per
      // command): the count is the index of the first event later than `time`.
      let lo = 0;
      let hi = times.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid]! <= time) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}
