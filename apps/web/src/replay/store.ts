import { create } from 'zustand';
import type { EventEnvelope, Id } from '@galactic/protocol';
import type { Api } from '../console/api.js';
import { useAppStore } from '../state/store.js';
import { createReplayTimeline, replayBase, tickOf, type ReplayTimeline } from './replay-model.js';

/** The playback speeds the bar offers (real seconds of history per second). */
export const REPLAY_SPEEDS = [1, 10, 60] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** How long before the first event the slider starts: the system before anything happened. */
export const LEAD_MS = 1_000;
/** Page size and a bound on the pages read (2 000 × 200: far beyond one project's log). */
const PAGE = 2_000;
const MAX_PAGES = 200;

export interface ReplayState {
  phase: 'closed' | 'loading' | 'ready' | 'error';
  projectId?: Id | undefined;
  /** The project's name when the replay opened (the bar's title). */
  name?: string | undefined;
  error?: string | undefined;
  timeline?: ReplayTimeline | undefined;
  /** Indexes of the events that get a tick on the bar, in order. */
  ticks: number[];
  /** The slider's range and position, in ms since the epoch. */
  start: number;
  end: number;
  time: number;
  playing: boolean;
  speed: ReplaySpeed;
  /** Reads the project's events and shows its start in the scene. */
  open: (api: Pick<Api, 'historyEvents'>, projectId: Id, name?: string) => Promise<void>;
  /** Back to live: the scene draws the live world again. */
  close: () => void;
  seek: (time: number) => void;
  /** To the next (1) or previous (-1) marked event. */
  step: (direction: 1 | -1) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  /** Moves playback on by `ms` of real time (the driver's frame; tests call it directly). */
  advance: (ms: number) => void;
}

const closed = {
  phase: 'closed' as const,
  projectId: undefined,
  name: undefined,
  error: undefined,
  timeline: undefined,
  ticks: [],
  start: 0,
  end: 0,
  time: 0,
  playing: false,
};

let opening = 0;
let stopDriver: (() => void) | undefined;
let stopWatch: (() => void) | undefined;

/** Whether the system asks for reduced motion (playback then moves in whole-second steps). */
function reducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

/**
 * Runs playback: every animation frame (or, with reduced motion, once a second, so nothing moves
 * smoothly — only the replayed state changes) the time moves on by the real time passed × speed.
 */
function startDriver(advance: (ms: number) => void): () => void {
  if (reducedMotion() || typeof globalThis.requestAnimationFrame !== 'function') {
    const timer = setInterval(() => advance(1_000), 1_000);
    return () => clearInterval(timer);
  }
  let last: number | undefined;
  let frame = 0;
  const loop = (now: number) => {
    if (last !== undefined) advance(Math.min(now - last, 250));
    last = now;
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(frame);
}

/**
 * The timeline scrubber (P4-07; SPEC decision 78): one project's history replayed in the scene.
 * Opening reads `GET /api/history/events` to the end, folds it (`replay-model.ts`) and hands the
 * world at the slider's time to the app store's `replayWorld`, which the scene draws instead of
 * the live world (`sceneWorld`). The panel stays live; live events keep folding into `world`. The
 * replay is the history as it was when it opened: events after that are not added to it.
 */
export const useReplayStore = create<ReplayState>((set, get) => {
  const show = (time: number) => {
    const { timeline, start, end } = get();
    if (!timeline) return;
    const t = Math.max(start, Math.min(end, time));
    useAppStore.setState({ replayWorld: timeline.worldAt(timeline.countAt(t)) });
    set({ time: t });
  };
  const halt = () => {
    stopDriver?.();
    stopDriver = undefined;
  };
  return {
    ...closed,
    speed: 10,
    open: async (api, projectId, name) => {
      halt();
      const token = ++opening;
      set({ ...closed, phase: 'loading', projectId, name });
      try {
        const events: EventEnvelope[] = [];
        let after: number | undefined;
        for (let page = 0; page < MAX_PAGES; page++) {
          const res = await api.historyEvents({
            projectId,
            limit: PAGE,
            ...(after !== undefined ? { after } : {}),
          });
          if (token !== opening) return; // closed or reopened meanwhile
          events.push(...res.events);
          after = res.seq;
          if (!res.hasMore) break;
        }
        const live = useAppStore.getState();
        const timeline = createReplayTimeline(replayBase(live.world.bodies), events);
        const first = events.length > 0 ? Date.parse(events[0]!.at) : Date.now();
        const last = events.length > 0 ? Date.parse(events.at(-1)!.at) : first;
        const ticks: number[] = [];
        events.forEach((e, i) => {
          if (tickOf(e)) ticks.push(i);
        });
        set({
          phase: 'ready',
          timeline,
          ticks,
          start: first - LEAD_MS,
          end: last,
          name: name ?? live.world.projects[projectId]?.name,
        });
        show(first - LEAD_MS);
        // A snapshot of another log (a new database) ends the replay (the store drops it too).
        stopWatch?.();
        const logId = live.logId;
        stopWatch = useAppStore.subscribe((s) => {
          if (s.logId !== logId) get().close();
        });
      } catch (error) {
        if (token !== opening) return;
        set({ phase: 'error', error: (error as Error).message });
      }
    },
    close: () => {
      halt();
      opening++;
      stopWatch?.();
      stopWatch = undefined;
      set({ ...closed });
      if (useAppStore.getState().replayWorld !== undefined)
        useAppStore.setState({ replayWorld: undefined });
    },
    seek: (time) => show(time),
    step: (direction) => {
      const { timeline, ticks, time, start, end } = get();
      if (!timeline) return;
      const at = (i: number) => Date.parse(timeline.events[i]!.at);
      if (direction === 1) {
        const next = ticks.find((i) => at(i) > time);
        show(next === undefined ? end : at(next));
      } else {
        const prev = [...ticks].reverse().find((i) => at(i) < time);
        show(prev === undefined ? start : at(prev));
      }
    },
    play: () => {
      const { phase, time, end, start } = get();
      if (phase !== 'ready') return;
      if (time >= end) show(start); // from the start again
      set({ playing: true });
      halt();
      stopDriver = startDriver((ms) => get().advance(ms));
    },
    pause: () => {
      halt();
      set({ playing: false });
    },
    setSpeed: (speed) => set({ speed }),
    advance: (ms) => {
      const { playing, time, end, speed } = get();
      if (!playing) return;
      const next = time + ms * speed;
      show(next);
      if (next >= end) get().pause();
    },
  };
});

/**
 * Opens a project's replay from the panel (a navigation row's "⋯", a history row): back to the
 * panel's main view, where the scene and the bar are, then reads the history.
 */
export function startReplay(api: Pick<Api, 'historyEvents'>, projectId: Id, name?: string): void {
  const app = useAppStore.getState();
  if (app.route !== 'panel') app.navigate({ route: 'panel', selection: app.selection });
  void useReplayStore.getState().open(api, projectId, name);
}
