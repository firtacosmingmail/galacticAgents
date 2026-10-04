import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventEnvelope,
  HistoryEventsResponse,
  HistoryWorkResponse,
  Project,
  ServerMessage,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import { useAppStore } from '../state/store.js';
import { escapeExitsReplay } from './ReplayBar.js';
import { useReplayStore } from './store.js';

// P4-07 — opening the scrubber from the panel, and its bar.

const T0 = Date.parse('2026-10-04T09:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const demo: Project = { ...fx.project, id: 'p-demo', name: 'Demo project', state: 'completed' };

const history: EventEnvelope[] = [
  {
    seq: 1,
    at: at(0),
    event: { type: 'project.created', project: { ...demo, state: 'in_progress' } },
  },
  {
    seq: 2,
    at: at(1),
    event: { type: 'body.assigned', bodyId: fx.body.id, host: { kind: 'project', id: 'p-demo' } },
  },
  {
    seq: 3,
    at: at(90),
    event: {
      type: 'project.state_changed',
      projectId: 'p-demo',
      from: 'in_progress',
      to: 'completed',
    },
  },
];

const snapshot: Extract<ServerMessage, { type: 'snapshot' }> = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer],
  bodies: [{ ...fx.body, host: { kind: 'project', id: 'p-demo' } }],
  projects: [demo],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [],
};

let requested: string[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  // List mode: no WebGL in jsdom. The bar still opens and says how to watch.
  localStorage.setItem(SCENE_VISIBLE_KEY, '0');
  requested = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url);
      if (url.includes('/api/history/events')) {
        return new Response(
          JSON.stringify({
            projectId: 'p-demo',
            events: history,
            seq: 3,
            hasMore: false,
          } satisfies HistoryEventsResponse),
        );
      }
      if (url.includes('/api/history/work')) {
        return new Response(
          JSON.stringify({
            items: [{ kind: 'project', item: demo, cursor: 'c1' }],
            hasMore: false,
          } satisfies HistoryWorkResponse),
        );
      }
      if (url.includes('/api/history/questions'))
        return new Response(JSON.stringify({ items: [], hasMore: false }));
      return url.endsWith('/messages')
        ? new Response(JSON.stringify({ messages: [] }))
        : new Response('{}');
    }),
  );
});
afterEach(() => {
  useReplayStore.getState().close();
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(path = '/') {
  FakeWebSocket.instances = [];
  useAppStore.getState().reset();
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
}

const bar = () => screen.queryByRole('region', { name: 'Replay · Demo project' });

describe('timeline scrubber UI (P4-07)', () => {
  it("opens from a navigation row's actions, scrubs, and exits back to live", async () => {
    await open('/');
    fireEvent.click(screen.getByRole('checkbox', { name: /Show closed/ }));
    const row = within(screen.getByRole('listitem', { name: 'project Demo project' }));
    fireEvent.click(row.getByRole('button', { name: 'Actions for Demo project' }));
    await act(async () => {
      fireEvent.click(row.getByRole('button', { name: 'Replay history' }));
    });
    await vi.waitFor(() => expect(bar()).toBeTruthy());
    expect(requested.some((u) => u.includes('/api/history/events?projectId=p-demo'))).toBe(true);
    const b = within(bar()!);
    expect(b.getByText('Show the scene to watch the replay.')).toBeTruthy();
    expect(b.getByText('0 / 3 events')).toBeTruthy();
    // The panel stays live; the scene's world is the replay's.
    expect(useAppStore.getState().world.projects['p-demo']?.state).toBe('completed');
    expect(useAppStore.getState().replayWorld?.projects).toEqual({});

    fireEvent.click(b.getByRole('button', { name: 'Next event' }));
    expect(b.getByText('2 / 3 events')).toBeTruthy();
    expect(useAppStore.getState().replayWorld?.bodies[fx.body.id]?.host).toEqual({
      kind: 'project',
      id: 'p-demo',
    });
    const slider = b.getByRole('slider', { name: 'Time' }) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: String(T0 + 90_000) } });
    expect(b.getByText('3 / 3 events')).toBeTruthy();
    expect(useAppStore.getState().replayWorld?.projects['p-demo']?.state).toBe('completed');
    // Two ticks: the assignment and the completion are marked; the creation is not.
    expect(bar()!.querySelectorAll('.rpl-tick')).toHaveLength(2);
    expect(b.getByRole('combobox', { name: 'Speed' })).toBeTruthy();
    fireEvent.click(b.getByRole('button', { name: 'Play' }));
    expect(b.getByRole('button', { name: 'Pause' })).toBeTruthy();
    fireEvent.click(b.getByRole('button', { name: 'Pause' }));

    fireEvent.click(b.getByRole('button', { name: 'Exit replay' }));
    expect(bar()).toBeNull();
    expect(useAppStore.getState().replayWorld).toBeUndefined();
  });

  it('opens from a project row of the history page, back on the panel; Escape exits', async () => {
    await open('/history');
    const replay = await screen.findByRole('button', { name: 'Replay' });
    await act(async () => {
      fireEvent.click(replay);
    });
    expect(useAppStore.getState().route).toBe('panel');
    await vi.waitFor(() => expect(bar()).toBeTruthy());
    fireEvent.keyDown(within(bar()!).getByRole('button', { name: 'Exit replay' }), {
      key: 'Escape',
    });
    expect(bar()).toBeNull();
  });

  it('Replay from history, then Escape: the focus lands on the main heading (P5-04 review)', async () => {
    await open('/history');
    const replay = await screen.findByRole('button', { name: 'Replay' });
    replay.focus();
    await act(async () => {
      fireEvent.click(replay);
    });
    await vi.waitFor(() => expect(bar()).toBeTruthy());
    // The history page unmounted with its button, so the bar found no opener (the body). The user
    // tabs into the bar and presses Escape there: the focus must not be dropped on the body.
    const play = within(bar()!).getByRole('button', { name: 'Play' });
    play.focus();
    act(() => {
      fireEvent.keyDown(play, { key: 'Escape' });
    });
    expect(bar()).toBeNull();
    const heading = document.querySelector<HTMLElement>('.pnl-body main h1');
    expect(heading).toBeTruthy();
    expect(document.activeElement).toBe(heading);
  });

  it('Escape exits from anywhere on the page, after fields, dialogs and menus (review S4)', async () => {
    await open('/history');
    const replay = await screen.findByRole('button', { name: 'Replay' });
    await act(async () => {
      fireEvent.click(replay);
    });
    await vi.waitFor(() => expect(bar()).toBeTruthy());
    // Typing in a field: Escape is the field's.
    const field = document.createElement('textarea');
    document.body.append(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(bar()).toBeTruthy();
    // A page-wide menu is open: it closes first.
    const menu = document.createElement('div');
    menu.setAttribute('data-escape-layer', '');
    document.body.append(menu);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(bar()).toBeTruthy();
    menu.remove();
    field.remove();
    // Focus nowhere in particular (not in the bar): Escape exits.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(bar()).toBeNull();
    expect(useAppStore.getState().replayWorld).toBeUndefined();
  });
});

describe('escapeExitsReplay (review S4)', () => {
  const key = (target: EventTarget | null, extra: Partial<KeyboardEvent> = {}) => ({
    key: 'Escape',
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    target,
    ...extra,
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('yields to whatever wants Escape first', () => {
    document.body.innerHTML = `
      <section class="rpl"><select id="speed"></select><input id="slider" type="range" /></section>
      <div role="dialog"><button id="in-dialog">x</button></div>
      <div role="dialog" hidden></div>
      <input id="text" type="text" /><select id="other"></select>
      <div contenteditable="true" id="editable"></div>
      <button id="plain">b</button>`;
    const $ = (id: string) => document.getElementById(id);
    const bar = document.querySelector('.rpl');
    expect(escapeExitsReplay(key($('plain')), document, bar)).toBe(true);
    expect(escapeExitsReplay(key(document.body), document, bar)).toBe(true);
    // The bar's own controls: Escape exits.
    expect(escapeExitsReplay(key($('speed')), document, bar)).toBe(true);
    expect(escapeExitsReplay(key($('slider')), document, bar)).toBe(true);
    // Fields, a focused dialog, a handled or modified key, another key: not ours.
    expect(escapeExitsReplay(key($('text')), document, bar)).toBe(false);
    expect(escapeExitsReplay(key($('other')), document, bar)).toBe(false);
    expect(escapeExitsReplay(key($('editable')), document, bar)).toBe(false);
    expect(escapeExitsReplay(key($('in-dialog')), document, bar)).toBe(false);
    expect(escapeExitsReplay(key($('plain'), { defaultPrevented: true }), document, bar)).toBe(
      false,
    );
    expect(escapeExitsReplay(key($('plain'), { ctrlKey: true }), document, bar)).toBe(false);
    expect(escapeExitsReplay(key($('plain'), { isComposing: true }), document, bar)).toBe(false);
    expect(escapeExitsReplay(key($('plain'), { key: 'Enter' }), document, bar)).toBe(false);
    // A page-wide menu or a modal open anywhere: it closes first.
    document.body.insertAdjacentHTML('beforeend', '<div data-escape-layer hidden></div>');
    expect(escapeExitsReplay(key($('plain')), document, bar)).toBe(true);
    document.body.insertAdjacentHTML('beforeend', '<div data-escape-layer></div>');
    expect(escapeExitsReplay(key($('plain')), document, bar)).toBe(false);
  });
});
