// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Object3D } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Question, ServerMessage, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { selectionKey } from '../state/selection.js';
import { focusTarget } from '../panel/notifications/focus.js';
import { registerAnchor } from './anchors.js';
import { useCameraStore } from './camera/store.js';
import { activateBody, deselectFromScene } from './picking/store.js';
import { setDeepLinkForTest } from './picking/sync.js';
import { SCENE_VISIBLE_KEY } from './visibility.js';

/**
 * P5-01: every selection path of SPEC §4.1–§4.2 end to end, through the real panel (`App`) with
 * the scene's three.js part stubbed (no WebGL in jsdom): the bodies are registered anchors, the
 * camera is its store. Panel → scene: the selection, the URL and a flight to the agent's body;
 * scene → panel: the main view and the URL.
 */
vi.mock('./SolarScene.js', () => ({ default: () => <div data-testid="solar-scene" /> }));
vi.mock('./webgl.js', () => ({ webglAvailable: () => true }));

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const asteroidSteward: Agent = {
  ...fx.agent,
  id: 'a-steward-2',
  taskId: 't-2',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-ast-1',
};
const working = (agentId: string): StatusRecord => ({ ...fx.status, agentId });
/** A permission the asteroid's Steward waits on: the inbox card links to it. */
const permission: Question = {
  ...fx.question,
  id: 'q-ast',
  kind: 'permission',
  originAgentId: 'a-steward-2',
  holder: { type: 'user' },
  context: { text: 'Run the migration?', permissionAction: 'destructive' },
};

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, fx.agent, asteroidSteward],
  bodies: [
    { id: 'b-earth', kind: 'planet', name: 'Earth', meta: { reserved: true } },
    fx.body,
    fx.moon,
    fx.asteroid,
  ],
  projects: [fx.project],
  tasks: [fx.task, fx.asteroidTask],
  questions: [permission],
  proposals: [],
  statuses: [
    working('a-harmonizer'),
    working('a-waykeeper-1'),
    working('a-steward-1'),
    working('a-steward-2'),
  ],
};

let unregister: (() => void)[] = [];

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  useCameraStore.setState({ focusedId: undefined, request: undefined, flying: false });
  setDeepLinkForTest(undefined);
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
      if (url.includes('/api/preflight'))
        return new Response(JSON.stringify({ ok: true, checkedAt: fx.NOW, runtimes: [] }));
      return new Response('{}');
    }),
  );
  for (const bodyId of ['b-earth', 'b-kepler', 'b-luna', 'b-ast-1'])
    unregister.push(registerAnchor({ bodyId, kind: 'planet', object: new Object3D(), radius: 1 }));
});

afterEach(() => {
  cleanup();
  unregister.forEach((u) => u());
  unregister = [];
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(path = '/', scene = true) {
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances.at(-1)!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
  if (scene) await vi.waitFor(() => expect(screen.getByTestId('solar-scene')).toBeTruthy());
}

const selected = () => selectionKey(useAppStore.getState().selection);
const focused = () => useCameraStore.getState().focusedId;
const flights = () => useCameraStore.getState().request?.seq ?? 0;
const main = () => screen.getByRole('main');
const nav = () => screen.getByRole('navigation', { name: 'navigation' });

describe('panel → scene: every panel path selects, rewrites the URL and flies (P5-01)', () => {
  it('a navigation row; the Harmonizer row leaves the camera where it is', async () => {
    await open();
    fireEvent.click(within(nav()).getByRole('link', { name: /Auth refactor/ }));
    expect(selected()).toBe('waykeeper:a-waykeeper-1');
    expect(window.location.pathname).toBe('/waykeeper/a-waykeeper-1');
    expect(focused()).toBe('b-luna');
    fireEvent.click(within(nav()).getByRole('link', { name: /Fix the flaky date test/ }));
    expect(focused()).toBe('b-ast-1');
    const seq = flights();
    fireEvent.click(within(nav()).getByRole('link', { name: /Harmonizer/ }));
    expect(selected()).toBe('harmonizer');
    expect(main().dataset['selection']).toBe('harmonizer');
    expect(flights()).toBe(seq);
    expect(focused()).toBe('b-ast-1');
  });

  it("an inbox card's agent link", async () => {
    await open();
    const inbox = screen.getByRole('region', { name: 'inbox' });
    fireEvent.click(within(inbox).getAllByRole('link', { name: /^open Steward/ })[0]!);
    expect(selected()).toBe('steward:a-steward-2');
    expect(window.location.pathname).toBe('/steward/a-steward-2');
    expect(focused()).toBe('b-ast-1');
  });

  it('back and forward fly to the agent again; back to the Harmonizer does not', async () => {
    await open();
    fireEvent.click(within(nav()).getByRole('link', { name: /Auth refactor/ }));
    fireEvent.click(within(nav()).getByRole('link', { name: /Fix the flaky date test/ }));
    expect(focused()).toBe('b-ast-1');
    await act(async () => {
      window.history.back();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/waykeeper/a-waykeeper-1'));
    });
    expect(selected()).toBe('waykeeper:a-waykeeper-1');
    expect(focused()).toBe('b-luna');
    await act(async () => {
      window.history.back();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/'));
    });
    expect(selected()).toBe('harmonizer');
    expect(focused()).toBe('b-luna');
    await act(async () => {
      window.history.forward();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/waykeeper/a-waykeeper-1'));
    });
    act(() => void useCameraStore.getState().back());
    await act(async () => {
      window.history.forward();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/steward/a-steward-2'));
    });
    expect(focused()).toBe('b-ast-1');
  });

  it('a deep link (a reload) opens the view and flies once the body is drawn', async () => {
    setDeepLinkForTest({ kind: 'steward', id: 'a-steward-2' });
    await open('/steward/a-steward-2');
    expect(main().dataset['selection']).toBe('steward:a-steward-2');
    expect(focused()).toBe('b-ast-1');
  });

  it('a notification clicked while the settings page shows: back on the panel, flown there', async () => {
    await open('/settings', false);
    expect(screen.queryByTestId('solar-scene')).toBeNull();
    act(() => focusTarget({ kind: 'task', id: 't-2' }));
    await vi.waitFor(() => expect(screen.getByTestId('solar-scene')).toBeTruthy());
    expect(selected()).toBe('steward:a-steward-2');
    expect(window.location.pathname).toBe('/steward/a-steward-2');
    expect(focused()).toBe('b-ast-1');
  });

  it('a return to the panel in list mode does not fly when the scene is shown later', async () => {
    localStorage.setItem(SCENE_VISIBLE_KEY, '0');
    await open('/settings', false);
    act(() => focusTarget({ kind: 'task', id: 't-2' }));
    await vi.waitFor(() => expect(useAppStore.getState().route).toBe('panel'));
    expect(selected()).toBe('steward:a-steward-2');
    expect(screen.queryByTestId('solar-scene')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Show scene' })[0]!);
    await vi.waitFor(() => expect(screen.getByTestId('solar-scene')).toBeTruthy());
    expect(focused()).toBeUndefined();
    expect(flights()).toBe(0);
  });
});

describe('scene → panel: a pick changes the main view and the URL (P5-01)', () => {
  it('a body, Earth, and a click on empty space', async () => {
    await open();
    act(() => void activateBody('b-luna', { x: 0, y: 0 }));
    expect(main().dataset['selection']).toBe('waykeeper:a-waykeeper-1');
    expect(window.location.pathname).toBe('/waykeeper/a-waykeeper-1');
    expect(within(main()).getByRole('region', { name: /chat with Waykeeper/ })).toBeTruthy();

    act(() => void activateBody('b-earth', { x: 0, y: 0 }));
    expect(main().dataset['selection']).toBe('harmonizer');
    expect(focused()).toBe('b-earth');

    act(() => void activateBody('b-ast-1', { x: 0, y: 0 }));
    expect(within(main()).getByRole('region', { name: /view of Steward/ })).toBeTruthy();
    const seq = flights();
    act(() => void deselectFromScene());
    expect(main().dataset['selection']).toBe('harmonizer');
    expect(window.location.pathname).toBe('/');
    expect(flights()).toBe(seq);

    // Back returns to the Steward the scene had selected, and the camera follows.
    act(() => void useCameraStore.getState().back());
    await act(async () => {
      window.history.back();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/steward/a-steward-2'));
    });
    expect(focused()).toBe('b-ast-1');
  });
});
