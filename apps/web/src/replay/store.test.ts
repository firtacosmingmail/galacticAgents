import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Body,
  Event,
  EventEnvelope,
  HistoryEventsQuery,
  HistoryEventsResponse,
  Project,
  ServerMessage,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { sceneWorld, useAppStore } from '../state/store.js';
import { LEAD_MS, startReplay, useReplayStore } from './store.js';

// P4-07 — the replay store and the scene's world switch.

const T0 = Date.parse('2026-10-04T09:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const mars: Body = { id: 'b-mars', kind: 'planet', name: 'Mars' };
const rock: Body = { id: 'b-rock', kind: 'asteroid', name: 'Rock-1' };
const project: Project = {
  ...fx.project,
  id: 'p-a',
  name: 'Alpha',
  bodyId: 'b-mars',
  createdAt: at(0),
  updatedAt: at(0),
};
const task: Task = {
  ...fx.asteroidTask,
  id: 't-a',
  description: 'Loose end',
  bodyId: 'b-rock',
  state: 'in_progress',
  createdAt: at(1),
  updatedAt: at(1),
};
delete (task as Partial<Task>).projectId;
const steward: Agent = {
  ...fx.agent,
  id: 's-a',
  role: 'steward',
  bodyId: 'b-rock',
  taskId: 't-a',
  createdAt: at(2),
  updatedAt: at(2),
};
delete (steward as Partial<Agent>).projectId;
delete (steward as Partial<Agent>).supervisorId;
delete (steward as Partial<Agent>).sessionRef;

/** Alpha's history: created, a task on its asteroid with a Steward, the task joins Alpha, completes. */
const history: EventEnvelope[] = (
  [
    [0, { type: 'project.created', project }],
    [1, { type: 'task.created', task }],
    [1, { type: 'body.assigned', bodyId: 'b-rock', host: { kind: 'task', id: 't-a' } }],
    [2, { type: 'agent.created', agent: steward }],
    [
      3,
      { type: 'agent.spawned', agentId: 's-a', role: 'steward', runtime: 'fake', bodyId: 'b-rock' },
    ],
    [
      4,
      { type: 'agent.tool_call', agentId: 's-a', toolName: 'Read', input: { file_path: 'a.ts' } },
    ],
    [
      60,
      {
        type: 'body.moved',
        host: { kind: 'task', id: 't-a' },
        fromBodyId: 'b-rock',
        toBodyId: 'b-mars',
        intoProjectId: 'p-a',
      },
    ],
    [60, { type: 'task.updated', taskId: 't-a', changes: { projectId: 'p-a', bodyId: 'b-mars' } }],
    [60, { type: 'agent.updated', agentId: 's-a', changes: { bodyId: 'b-mars' } }],
    [120, { type: 'task.state_changed', taskId: 't-a', from: 'in_progress', to: 'completed' }],
  ] as [number, Event][]
).map(([s, event], i) => ({ seq: i + 1, at: at(s), event }));

/** A fake `historyEvents` that pages the history three at a time, as the route does. */
function fakeApi(events = history) {
  const historyEvents = vi.fn(async (q: HistoryEventsQuery): Promise<HistoryEventsResponse> => {
    const after = Number(q.after ?? 0);
    const page = events.filter((e) => e.seq > after).slice(0, 3);
    const seq = page.at(-1)?.seq ?? events.at(-1)?.seq ?? 0;
    return { projectId: q.projectId, events: page, seq, hasMore: seq < (events.at(-1)?.seq ?? 0) };
  });
  return { historyEvents };
}

/** The live world: Alpha completed long ago, its task on Mars; another project on Venus. */
const live: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 50,
  agents: [],
  bodies: [
    { ...mars, host: { kind: 'project', id: 'p-a' } },
    { ...rock, movedTo: { bodyId: 'b-mars', host: { kind: 'task', id: 't-a' }, at: at(60) } },
    { id: 'b-venus', kind: 'planet', name: 'Venus', host: { kind: 'project', id: 'p-b' } },
  ],
  projects: [
    { ...project, state: 'completed' },
    { ...project, id: 'p-b', name: 'Beta', bodyId: 'b-venus' },
  ],
  tasks: [{ ...task, projectId: 'p-a', bodyId: 'b-mars', state: 'completed' }],
  questions: [],
  proposals: [],
  statuses: [],
};

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().apply(live);
});
afterEach(() => useReplayStore.getState().close());

const scene = () => sceneWorld(useAppStore.getState());

describe('replay store (P4-07)', () => {
  it('reads every page, then the scene draws the replay while the panel stays live', async () => {
    const api = fakeApi();
    await useReplayStore.getState().open(api, 'p-a');
    expect(api.historyEvents).toHaveBeenCalledTimes(4);
    expect(api.historyEvents.mock.calls.map(([q]) => q.after)).toEqual([undefined, 3, 6, 9]);
    const r = useReplayStore.getState();
    expect(r).toMatchObject({
      phase: 'ready',
      name: 'Alpha',
      start: T0 - LEAD_MS,
      end: T0 + 120_000,
    });
    expect(r.ticks.map((i) => history[i]!.event.type)).toEqual([
      'body.assigned',
      'body.moved',
      'task.state_changed',
    ]);
    // It opens before anything happened: a free system, other projects off the map.
    expect(scene()).toBe(useAppStore.getState().replayWorld);
    expect(scene().projects).toEqual({});
    expect(scene().bodies['b-venus']?.host).toBeUndefined();
    expect(scene().bodies['b-rock']?.movedTo).toBeUndefined();
    // The panel's world is the live one.
    const world = useAppStore.getState().world;
    expect(world.projects['p-b']?.name).toBe('Beta');
    expect(world.bodies['b-venus']?.host).toEqual({ kind: 'project', id: 'p-b' });
  });

  it('scrubs before and after the move and the completion', async () => {
    await useReplayStore.getState().open(fakeApi(), 'p-a');
    const { seek } = useReplayStore.getState();
    seek(T0 + 30_000);
    expect(scene().bodies['b-rock']?.host).toEqual({ kind: 'task', id: 't-a' });
    expect(scene().tasks['t-a']).toMatchObject({ bodyId: 'b-rock', state: 'in_progress' });
    expect(scene().statuses['s-a']).toMatchObject({
      state: 'working',
      currentActivity: 'Read: a.ts',
    });
    seek(T0 + 60_000);
    expect(scene().bodies['b-rock']).toMatchObject({ movedTo: { bodyId: 'b-mars' } });
    expect(scene().bodies['b-rock']?.host).toBeUndefined();
    expect(scene().agents['s-a']?.bodyId).toBe('b-mars');
    expect(scene().tasks['t-a']?.state).toBe('in_progress');
    seek(T0 + 120_000);
    expect(scene().tasks['t-a']?.state).toBe('completed');
    // Back before the move again.
    seek(T0 + 59_000);
    expect(scene().bodies['b-rock']?.host).toEqual({ kind: 'task', id: 't-a' });
    // The slider's range bounds a seek.
    seek(T0 + 10_000_000);
    expect(useReplayStore.getState().time).toBe(T0 + 120_000);
  });

  it('steps between marked events, plays at a speed and stops at the end', async () => {
    await useReplayStore.getState().open(fakeApi(), 'p-a');
    const s = () => useReplayStore.getState();
    s().step(1);
    expect(s().time).toBe(T0 + 1_000); // the assignment
    s().step(1);
    expect(s().time).toBe(T0 + 60_000); // the move
    s().step(-1);
    expect(s().time).toBe(T0 + 1_000);
    s().step(-1);
    expect(s().time).toBe(T0 - LEAD_MS);
    s().setSpeed(60);
    s().play();
    expect(s().playing).toBe(true);
    s().advance(1_000); // one real second at 60×: a minute of history
    expect(s().time).toBe(T0 - LEAD_MS + 60_000);
    expect(scene().bodies['b-rock']?.host).toEqual({ kind: 'task', id: 't-a' });
    s().advance(1_000);
    expect(scene().bodies['b-rock']?.movedTo).toBeDefined();
    s().advance(5_000);
    expect(s()).toMatchObject({ playing: false, time: T0 + 120_000 });
    s().pause();
  });

  it('keeps folding live events into the live world during a replay; exiting goes back to live', async () => {
    await useReplayStore.getState().open(fakeApi(), 'p-a');
    useReplayStore.getState().seek(T0 + 30_000);
    const replayed = useAppStore.getState().replayWorld;
    useAppStore.getState().apply({
      type: 'event',
      seq: 51,
      at: at(500),
      event: { type: 'project.updated', projectId: 'p-b', changes: { name: 'Beta 2' } },
    });
    expect(useAppStore.getState().world.projects['p-b']?.name).toBe('Beta 2');
    expect(useAppStore.getState().replayWorld).toBe(replayed);
    useReplayStore.getState().close();
    expect(useAppStore.getState().replayWorld).toBeUndefined();
    expect(scene()).toBe(useAppStore.getState().world);
    expect(useReplayStore.getState().phase).toBe('closed');
  });

  it('a snapshot of another log ends the replay', async () => {
    await useReplayStore.getState().open(fakeApi(), 'p-a');
    useAppStore.getState().apply({ ...live, logId: 'log-b' } as ServerMessage);
    expect(useReplayStore.getState().phase).toBe('closed');
    expect(useAppStore.getState().replayWorld).toBeUndefined();
  });

  it('reports a failed read, and a replay closed while reading never shows', async () => {
    await useReplayStore
      .getState()
      .open({ historyEvents: () => Promise.reject(new Error('offline')) }, 'p-a');
    expect(useReplayStore.getState()).toMatchObject({ phase: 'error', error: 'offline' });
    expect(useAppStore.getState().replayWorld).toBeUndefined();

    let release!: (r: HistoryEventsResponse) => void;
    const pending = useReplayStore
      .getState()
      .open({ historyEvents: () => new Promise((r) => (release = r)) }, 'p-a');
    expect(useReplayStore.getState().phase).toBe('loading');
    useReplayStore.getState().close();
    release({ projectId: 'p-a', events: history, seq: 10, hasMore: false });
    await pending;
    expect(useReplayStore.getState().phase).toBe('closed');
    expect(useAppStore.getState().replayWorld).toBeUndefined();
  });

  it('startReplay goes back to the panel from the history page', async () => {
    useAppStore.getState().navigate({ route: 'history', selection: { kind: 'harmonizer' } });
    startReplay(fakeApi(), 'p-a', 'Alpha');
    expect(useAppStore.getState().route).toBe('panel');
    await vi.waitFor(() => expect(useReplayStore.getState().phase).toBe('ready'));
  });
});

describe('the scene reads the world through the one switch', () => {
  it('no scene source reads the live world directly', () => {
    const root = join(__dirname, '..', 'scene');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // `s.world`, `getState().world`, `store.world` / `state.world` bypass `sceneWorld`.
      expect(source, file).not.toMatch(/\b(s|state|store|prev)\.world\b|getState\(\)\.world\b/);
    }
  });
});
