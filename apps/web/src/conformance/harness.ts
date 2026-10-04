import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { Object3D } from 'three';
import { expect, vi } from 'vitest';
import type {
  Agent,
  Body,
  EventEnvelope,
  Project,
  Proposal,
  Question,
  ServerMessage,
  StatusRecord,
  Task,
  TranscriptChunk,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { useConversationStore } from '../state/conversation.js';
import { registerAnchor } from '../scene/anchors.js';
import { useCameraStore } from '../scene/camera/store.js';
import { setDeepLinkForTest } from '../scene/picking/sync.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import { useDockView } from '../panel/status/dock-view.js';
import { archivedTask, preflightReady, settingsResponse } from '../a11y/a11y-fixtures.js';

/**
 * P5-05: the SPEC §4.2 / §4.3 conformance suites' world and page. Every requirement is walked
 * through the real panel (`<App/>`, the fake socket feeding it a snapshot and events) twice: **with
 * the scene** — its three.js part stubbed as `selection-paths.test.tsx` does (bodies are registered
 * anchors, the camera is its store, picks go through the picking store) — and **in list mode**,
 * the scene hidden by the per-browser preference (decision 62). The test files mock `SolarScene`
 * and `webgl` themselves (a `vi.mock` is hoisted only in its own file).
 */

export interface Mode {
  name: 'with scene' | 'list mode';
  scene: boolean;
}
export const MODES: readonly Mode[] = [
  { name: 'with scene', scene: true },
  { name: 'list mode', scene: false },
];

const later = (s: number) => new Date(Date.parse(fx.NOW) + s * 1000).toISOString();

export const EARTH: Body = {
  id: 'b-earth',
  kind: 'planet',
  name: 'Earth',
  meta: { reserved: true },
};
export const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
/** The project's Steward (task t-1 on the project's moon), under the Waykeeper. */
export const steward: Agent = fx.agent;
/** The standalone task's Steward (t-2 on the asteroid), under the Harmonizer (decision 6). */
export const asteroidSteward: Agent = {
  ...fx.agent,
  id: 'a-steward-2',
  taskId: 't-2',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-ast-1',
};
export const project: Project = { ...fx.project, state: 'in_progress' };
export const projectTask: Task = { ...fx.task, state: 'in_progress' };
export const asteroidTask: Task = { ...fx.asteroidTask, state: 'in_progress', blockedBy: [] };

/** The project Steward's clarification, held by the user (it reached the user). */
export const clarification: Question = {
  ...fx.question,
  holder: { type: 'user' },
  version: 3,
};
/** The asteroid Steward's permission request: the user's alone (decision 7). */
export const permission: Question = {
  ...fx.permissionQuestion,
  originAgentId: 'a-steward-2',
  status: 'open',
  version: 0,
  context: {
    ...fx.permissionQuestion.context,
    origin: {
      role: 'steward',
      taskId: 't-2',
      bodyId: 'b-ast-1',
      recent: [{ seq: 50, at: fx.NOW, type: 'agent.tool_call', summary: 'Bash' }],
    },
  },
  createdAt: later(5),
  updatedAt: later(5),
};
/** A clarification the Waykeeper holds (decision 26): the user may still answer it. */
const { options: _options, ...plainContext } = fx.question.context;
export const supervisorHeld: Question = {
  ...fx.question,
  id: 'q-3',
  context: { ...plainContext, text: 'Which date format?' },
  createdAt: later(10),
  updatedAt: later(10),
};

export const workCard: Proposal = { ...fx.proposal, createdAt: later(-120) };

const status = (agentId: string, over: Partial<StatusRecord> = {}): StatusRecord => ({
  ...fx.status,
  agentId,
  ...over,
});

export interface WorldOptions {
  agents?: Agent[];
  bodies?: Body[];
  projects?: Project[];
  tasks?: Task[];
  questions?: Question[];
  proposals?: Proposal[];
  statuses?: StatusRecord[];
}

/** The world every row starts from; `over` replaces whole lists. */
export function snapshot(over: WorldOptions = {}): ServerMessage {
  return {
    type: 'snapshot',
    logId: 'log-a',
    seq: 10,
    agents: over.agents ?? [fx.harmonizer, waykeeper, steward, asteroidSteward],
    bodies: over.bodies ?? [EARTH, fx.body, fx.moon, fx.asteroid],
    projects: over.projects ?? [project],
    tasks: over.tasks ?? [projectTask, asteroidTask],
    questions: over.questions ?? [clarification, permission, supervisorHeld],
    proposals: over.proposals ?? [workCard],
    statuses: over.statuses ?? [
      status('a-harmonizer', { costSoFar: { usd: 1.25 }, currentActivity: 'Thinking' }),
      status('a-waykeeper-1', { costSoFar: { usd: 0.75 }, currentActivity: 'Planning' }),
      status('a-steward-1'),
      status('a-steward-2', { costSoFar: { usd: 0.3 }, currentActivity: 'Running the tests' }),
    ],
  } as ServerMessage;
}

/** The Steward's transcript page: a thought, a tool call and its words (its thought process). */
export const TRANSCRIPT: TranscriptChunk[] = [
  { agentId: 'a-steward-1', seq: 1, at: fx.NOW, kind: 'thinking', text: 'The cookie name matters' },
  { agentId: 'a-steward-1', seq: 2, at: fx.NOW, kind: 'tool', text: 'Read src/session.ts' },
  { agentId: 'a-steward-1', seq: 3, at: fx.NOW, kind: 'text', text: 'Reading the middleware.' },
];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A `fetch` answering every panel route; POSTs succeed and are recorded. */
export function panelFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://x').pathname;
    if (init?.method === 'POST') {
      if (path.endsWith('/send')) return json({ messageId: 'msg-sent' });
      if (path === '/api/control') return json({ ok: true, seq: 99 });
      return json({ ok: true });
    }
    if (path === '/api/settings') return json(settingsResponse(true));
    if (path.startsWith('/api/preflight')) return json(preflightReady);
    if (path.endsWith('/conversation')) return json({ entries: [], hasMore: false, lastSeq: 0 });
    if (path.endsWith('/messages')) return json({ messages: [] });
    if (path.endsWith('/processes')) return json({ processes: [] });
    if (path.endsWith('/transcript'))
      return json({
        chunks: path.includes('a-steward-1') ? TRANSCRIPT : [],
        hasMore: false,
        lastSeq: 3,
      });
    if (path === '/api/history/work')
      return json({ items: [{ kind: 'task', item: archivedTask, cursor: 'c-1' }], hasMore: false });
    if (path === '/api/history/questions')
      return json({
        items: [
          {
            question: {
              ...fx.question,
              id: 'q-old',
              context: { ...fx.question.context, text: 'Tabs or spaces?' },
              status: 'answered',
              answer: 'spaces',
              answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
            },
            cursor: 'c-q',
          },
        ],
        hasMore: false,
      });
    return json({});
  });
}

export type PanelFetch = ReturnType<typeof panelFetch>;

let unregister: (() => void)[] = [];
let seq = 10;

/** Resets the stores and the globals before a row. */
export function resetPage(mode: Mode): PanelFetch {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  localStorage.setItem(SCENE_VISIBLE_KEY, mode.scene ? '1' : '0');
  useAppStore.getState().reset();
  useConversationStore.getState().reset();
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
  useDockView.getState().setView('chat');
  setDeepLinkForTest(undefined);
  seq = 10;
  const fetchMock = panelFetch();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', fetchMock);
  if (mode.scene)
    for (const bodyId of ['b-earth', 'b-kepler', 'b-luna', 'b-ast-1'])
      unregister.push(
        registerAnchor({ bodyId, kind: 'planet', object: new Object3D(), radius: 1 }),
      );
  return fetchMock;
}

export function teardownPage(): void {
  unregister.forEach((u) => u());
  unregister = [];
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
}

/** Opens the panel at `path` in `mode` and feeds it the world. */
export async function openPanel(
  mode: Mode,
  path = '/',
  world: ServerMessage = snapshot(),
): Promise<void> {
  window.history.replaceState(null, '', path);
  useAppStore.getState().syncFromLocation();
  render(createElement(App));
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(world);
  });
  await flush();
  if (mode.scene) await vi.waitFor(() => expect(screen.getByTestId('solar-scene')).toBeTruthy());
  else expect(screen.queryByTestId('solar-scene')).toBeNull();
}

/** A live event from the server, as the stream brings it. */
export async function serverEvent(event: EventEnvelope['event']): Promise<void> {
  const socket = FakeWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.serverSends({ type: 'event', seq: ++seq, at: later(seq), event });
  });
  await flush();
}

export const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
  await flush();
}

export async function type(el: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(el, { target: { value } });
  });
}

/** The POSTs made to `path`, with their parsed bodies. */
export function posts(fetchMock: PanelFetch, path: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => url === path && init?.method === 'POST')
    .map(([, init]) => (init?.body ? JSON.parse(init.body as string) : undefined));
}

/** Every POST made, by path: proves what a click did and did not send (no LLM message). */
export function postedPaths(fetchMock: PanelFetch): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([url]) => new URL(url, 'http://x').pathname);
}

export const main = () => screen.getByRole('main');
export const nav = () => screen.getByRole('navigation', { name: 'navigation' });
export const inbox = () => screen.getByRole('region', { name: 'question inbox' });
export const managed = () => screen.getByRole('region', { name: 'managed agents' });
export const selection = () => useAppStore.getState().selection;

/** Selects through the navigation (works in both modes). */
export async function navTo(name: RegExp): Promise<void> {
  const link = within(nav()).queryByRole('link', { name });
  if (!link) {
    // A project row keeps its work folded: open it first.
    for (const b of within(nav()).queryAllByRole('button', { name: /^Show the work in / }))
      await click(b);
  }
  await click(within(nav()).getByRole('link', { name }));
}
