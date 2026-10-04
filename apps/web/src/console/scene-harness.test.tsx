// @vitest-environment jsdom
//
// P4-06 acceptance, end to end on the page side: the Phase 4 exit criterion "switching an agent's
// state in a test harness changes its satellite within a second", and "moving a task to a project
// flies its satellite there". A real server surface — the composed runtime (event log, commands,
// status store with its real 100 ms batching) behind the real Fastify routes with the dev routes
// on — and the page fed the way the session feeds it (snapshot, every committed event, status
// diffs). Every step is a click on the harness tab, sent through `/dev/harness/*` (Fastify
// `inject`); what is checked is what the scene draws from the store: the satellite list and look.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildApp,
  buildSnapshot,
  composeRuntime,
  openDatabase,
  type App,
  type ComposedRuntime,
  type ServerConfig,
} from '@galactic/server';
import { useAppStore } from '../state/store.js';
import { SceneHarness } from './SceneHarness.js';
import { SCENE_SATELLITES, satelliteList } from '../scene/satellites/satellite-model.js';
import { satelliteOrbitRate, satelliteTint } from '../scene/satellites/look.js';
import { beaconList } from '../scene/beacons/beacon-model.js';

const TOKEN = 'harness-token-0123456789';
let composed: ComposedRuntime;
let app: App;
const unsubscribe: (() => void)[] = [];

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'));
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    allowedHosts: ['localhost', '127.0.0.1'],
    dev: true,
    dataDir: '/tmp/unused',
    configPath: '/tmp/unused/config.json',
    dbPath: ':memory:',
    projectsRoot: '/tmp/unused/projects',
    autoApproveRemote: false,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
    },
  };
  const { log, statuses, transcripts, runtime, commands } = composed;
  app = buildApp({ config, log, statuses, transcripts, runtime, commands });
  await app.fastify.ready();
  const store = useAppStore.getState();
  store.reset();
  store.apply({ type: 'snapshot', ...buildSnapshot(log, statuses) });
  useAppStore.setState({ status: 'live' });
  unsubscribe.push(log.subscribe((envelope) => store.apply({ type: 'event', ...envelope })));
  unsubscribe.push(
    statuses.subscribe((records, removed) =>
      store.apply({ type: 'status', statuses: records, removed }),
    ),
  );
  vi.stubGlobal('fetch', (async (url: string, init?: RequestInit) => {
    const res = await app.fastify.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url,
      headers: { host: 'localhost', ...((init?.headers as Record<string, string>) ?? {}) },
      ...(init?.body ? { payload: init.body as string } : {}),
    });
    return new Response(res.body, { status: res.statusCode });
  }) as unknown as typeof fetch);
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  for (const u of unsubscribe.splice(0)) u();
  await composed.dispose();
  await app.close();
  useAppStore.getState().reset();
});

const world = () => useAppStore.getState().world;
/** Clicks once the button is enabled (the previous action has settled: one at a time). */
const click = async (find: () => HTMLElement) => {
  await waitFor(() => expect((find() as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(find());
};
const spec = (agentId: string) =>
  satelliteList(world(), SCENE_SATELLITES).find((s) => s.agentId === agentId);
const agentNamed = (label: RegExp) => {
  const rows = within(screen.getByRole('list', { name: 'Agents' })).getAllByRole('button');
  return rows.find((r) => label.test(r.textContent ?? ''))!;
};
const idOf = (label: RegExp) =>
  Object.values(world().agents).find((a) => {
    const task = a.taskId ? world().tasks[a.taskId] : undefined;
    const project = a.projectId ? world().projects[a.projectId] : undefined;
    const name =
      a.role === 'steward' ? `Steward · ${task?.description}` : `Waykeeper · ${project?.name}`;
    return label.test(name);
  })!.id;

describe('the scene harness drives the satellites (P4-06)', () => {
  it('switching a state changes the satellite within a second; a move flies it; a close lands it', async () => {
    render(<SceneHarness token={TOKEN} />);
    fireEvent.change(screen.getByLabelText('Stewards'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo scenario' }));
    await waitFor(() => expect(screen.getByText(/Scenario seeded/)).toBeTruthy());
    await waitFor(() => expect(spec(idOf(/Harness task 1\.1/))?.state).toBe('working'));

    // -- the exit criterion: a state switch reaches the satellite within a second.
    const steward = idOf(/Harness task 1\.1/);
    fireEvent.click(agentNamed(/Harness task 1\.1/));
    const before = spec(steward)!;
    const workingTint = satelliteTint(before);
    for (const [button, state] of [
      ['Paused', 'paused'],
      ['Waiting for you', 'waiting_for_input'],
      ['Idle', 'idle'],
      ['Stalled', 'stalled'],
      ['Working', 'working'],
    ] as const) {
      const t0 = performance.now();
      await click(() =>
        within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: button }),
      );
      await waitFor(() => expect(spec(steward)?.state).toBe(state), { timeout: 1_000 });
      expect(performance.now() - t0, button).toBeLessThan(1_000);
      await waitFor(() =>
        expect(screen.getByText(new RegExp(`${state} reached this page in \\d+ ms`))).toBeTruthy(),
      );
    }
    // The look changes with it (colour, orbit rate) — what a viewer sees.
    await click(() =>
      within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Paused' }),
    );
    await waitFor(() => expect(spec(steward)?.state).toBe('paused'));
    expect(satelliteTint(spec(steward)!)).not.toBe(workingTint);
    expect(satelliteOrbitRate(spec(steward)!)).toBe(0);

    // -- an activity preset reaches the satellite's archetype input.
    await click(() =>
      within(screen.getByRole('group', { name: 'Activity' })).getByRole('button', {
        name: 'Building',
      }),
    );
    await waitFor(() => expect(spec(steward)?.archetype).toBe('building'));

    // -- a permission question: the agent waits and a beacon stands over its body.
    await click(() => screen.getByRole('button', { name: 'Ask permission' }));
    await waitFor(() => expect(beaconList(world())).toHaveLength(1));
    expect(beaconList(world())[0]!.bodyId).toBe(spec(steward)!.bodyId);
    await click(() =>
      within(screen.getByRole('list', { name: 'Open questions' })).getByRole('button', {
        name: 'Answer',
      }),
    );
    await waitFor(() => expect(beaconList(world())).toHaveLength(0));
    await waitFor(() => expect(spec(steward)?.state).toBe('working'));

    // -- the second exit criterion: moving the asteroid task into the project flies its Steward.
    const lone = idOf(/Harness asteroid task/);
    const asteroidBody = spec(lone)!.bodyId;
    const projectBody = spec(steward)!.bodyId;
    expect(asteroidBody).not.toBe(projectBody);
    fireEvent.click(agentNamed(/Harness asteroid task/));
    await click(() =>
      within(screen.getByRole('group', { name: 'Move task' })).getByRole('button', {
        name: 'Move',
      }),
    );
    // The satellite's body changes: the actor flies there (`machine.ts`).
    await waitFor(() => expect(spec(lone)?.bodyId).toBe(projectBody));

    // -- completing a task lands its Steward (decision 77).
    fireEvent.click(agentNamed(/Harness task 1\.2/));
    await click(() => screen.getByRole('button', { name: 'Complete task' }));
    const done = idOf(/Harness task 1\.2/);
    await waitFor(() => expect(spec(done)?.landed).toBe(true));

    // -- failing an agent keeps its satellite, in its failure colour.
    fireEvent.click(agentNamed(/Harness task 1\.1/));
    await click(() => screen.getByRole('button', { name: 'Fail' }));
    await waitFor(() => expect(spec(steward)?.state).toBe('failed'));

    // -- clearing: every harness satellite goes.
    await click(() => screen.getByRole('button', { name: 'Clear harness scenario' }));
    await waitFor(() => expect(screen.getByText(/Harness scenario cleared/)).toBeTruthy());
    await waitFor(() =>
      expect(
        satelliteList(world(), SCENE_SATELLITES).filter((s) => s.role !== 'harmonizer'),
      ).toEqual([]),
    );
  }, 20_000);

  it('says when the dev routes are off', async () => {
    vi.stubGlobal(
      'fetch',
      (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
    );
    render(<SceneHarness token={TOKEN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Seed demo scenario' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/pnpm dev/));
  });

  it('lists the exit criteria with how to check each', () => {
    render(<SceneHarness token={TOKEN} />);
    expect(screen.getByText(/changes its satellite within a second/)).toBeTruthy();
    expect(screen.getByText(/flies its satellite there/)).toBeTruthy();
    expect(screen.getAllByText(/which planets are busy/).length).toBeGreaterThan(0);
  });
});
