// @vitest-environment jsdom
//
// P25-04 acceptance, the round trip: the cards' control actions against the real server surface
// — the composed runtime with fake-adapter agents behind the real Fastify routes (`inject`, a
// local client) — with the page's store fed the way the session feeds it (snapshot, every
// committed event, status diffs).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Task } from '@galactic/protocol';
import {
  FakeAdapter,
  buildApp,
  buildSnapshot,
  composeRuntime,
  openDatabase,
  type App,
  type ComposedRuntime,
  type ServerConfig,
} from '@galactic/server';
import { createApi } from '../console/api.js';
import { ApiContext } from '../console/hierarchy/shared.js';
import { useAppStore } from '../state/store.js';
import { ManagedAgentCards } from './AgentCards.js';

const TOKEN = 'cards-roundtrip-token-0123456789';
const LONG = { timeout: 15_000 };

let composed: ComposedRuntime;
let app: App;
const unsubscribe: (() => void)[] = [];

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
  });
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    allowedHosts: ['localhost', '127.0.0.1'],
    dev: false,
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
});

afterEach(async () => {
  cleanup();
  for (const u of unsubscribe.splice(0)) u();
  await composed.dispose().catch(() => {});
  await app.close().catch(() => {});
});

/** `fetch` for the page's api: straight into the Fastify routes, as a local client. */
const injectFetch = (async (url: string, init?: RequestInit) => {
  const res = await app.fastify.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST',
    url,
    headers: { host: 'localhost', ...((init?.headers as Record<string, string>) ?? {}) },
    ...(init?.body ? { payload: init.body as string } : {}),
  });
  return new Response(res.body, { status: res.statusCode });
}) as unknown as typeof fetch;

async function asteroidSteward(): Promise<{ harmonizer: Agent; steward: Agent; task: Task }> {
  const { commands, statuses } = composed;
  const task = (await commands.createTask({ description: 'Fix the flaky date test' })).value;
  const harmonizer = (
    await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt: 'x' })
  ).value;
  const steward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: task.id,
      supervisorId: harmonizer.id,
      cwd: '/w/scratch',
      prompt: 'scenario:long',
    })
  ).value;
  await waitFor(() => expect(statuses.get(steward.id)?.state).toBe('working'));
  return { harmonizer, steward, task };
}

function show(harmonizer: Agent) {
  render(
    <ApiContext.Provider value={createApi(TOKEN, injectFetch)}>
      <ManagedAgentCards supervisor={harmonizer} />
    </ApiContext.Provider>,
  );
}

const CARD = 'card of Steward · Fix the flaky date test';
const controls = (scope: 'agent' | 'task') =>
  within(screen.getByRole('article', { name: CARD })).getByRole('group', {
    name: new RegExp(`^${scope} controls of`),
  });

describe('managed-agents cards against the server (P25-04)', () => {
  it('pauses and resumes a task, then cancels it after the inline confirm', LONG, async () => {
    const { harmonizer, steward, task } = await asteroidSteward();
    const { log, statuses } = composed;
    show(harmonizer);

    // Pause the task: the server pauses its Steward; the card follows the stream.
    fireEvent.click(within(controls('task')).getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(log.tables.tasks.get(task.id)?.state).toBe('paused'));
    await waitFor(() => expect(statuses.get(steward.id)?.state).toBe('paused'));
    await waitFor(() =>
      expect(within(controls('task')).getByRole('button', { name: 'Resume' })).toBeTruthy(),
    );
    expect(within(controls('agent')).getByRole('button', { name: 'Resume' })).toBeTruthy();

    // Resume it again.
    fireEvent.click(within(controls('task')).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(statuses.get(steward.id)?.state).toBe('working'));
    await waitFor(() => expect(log.tables.tasks.get(task.id)?.state).toBe('in_progress'));

    // Cancel: destructive, so the card asks first; then the task fails and its Steward stops.
    fireEvent.click(within(controls('task')).getByRole('button', { name: 'Cancel' }));
    expect(log.tables.tasks.get(task.id)?.state).toBe('in_progress');
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }));
    await waitFor(() => expect(log.tables.tasks.get(task.id)?.state).toBe('failed'));
    await waitFor(() => expect(statuses.get(steward.id)?.state).toBe('stopped'));
    // The ended Steward keeps its card, now offering what finished work allows.
    await waitFor(() =>
      expect(within(controls('task')).getByRole('button', { name: 'Reopen' })).toBeTruthy(),
    );
    expect(within(controls('task')).getByRole('button', { name: 'Archive now' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the server’s refusal (409) inline', LONG, async () => {
    const { harmonizer, task } = await asteroidSteward();
    show(harmonizer);
    // The page stops hearing the stream, and the task is cancelled behind its back: the card
    // still offers Pause, and the server refuses it (pause refuses finished work, decision 28).
    for (const u of unsubscribe.splice(0)) u();
    await composed.commands.control(
      { kind: 'task', id: task.id },
      { action: 'cancel' },
      {
        type: 'user',
      },
    );
    fireEvent.click(within(controls('task')).getByRole('button', { name: 'Pause' }));
    const alert = await within(screen.getByRole('article', { name: CARD })).findByRole('alert');
    expect(alert.textContent).toBe(`task ${task.id} is failed`);
  });
});
