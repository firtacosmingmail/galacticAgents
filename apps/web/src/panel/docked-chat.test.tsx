// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { Profiler } from 'react';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, ServerMessage, ServerMessage as Msg } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { useConversationStore } from '../state/conversation.js';
import { SCENE_VISIBLE_KEY } from '../scene/visibility.js';
import { MANAGED_AGENTS_VISIBLE_KEY } from './managed-agents-visibility.js';
import {
  clampDockSize,
  DOCK_DEFAULT,
  DOCK_KEY,
  DOCK_MAX,
  DOCK_MIN,
  readDockPrefs,
} from './dock-state.js';
import { STACKED_LAYOUT_QUERY } from './use-media-query.js';

/*
 * P4-10: the main area docked under the scene, between the side columns; it minimises to its bar
 * and comes back, its handle sets its height, and both are remembered per browser. The shell is
 * exactly the viewport.
 */

// The three.js scene never loads in jsdom: a stub stands in, and WebGL is "available".
vi.mock('../scene/SolarScene.js', () => ({
  default: function StubScene() {
    return <div data-testid="solar-scene" />;
  },
}));
vi.mock('../scene/webgl.js', () => ({ webglAvailable: () => true }));

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-kepler',
};
const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, fx.agent],
  bodies: [fx.body, fx.moon],
  projects: [fx.project],
  tasks: [fx.task],
  questions: [{ ...fx.question, id: 'q-user', holder: { type: 'user' } }],
  proposals: [],
  statuses: [
    { ...fx.status, agentId: 'a-harmonizer', currentActivity: 'Sizing the request' },
    { ...fx.status, agentId: 'a-waykeeper-1' },
    { ...fx.status, agentId: 'a-steward-1' },
  ],
};

beforeEach(() => {
  useConversationStore.getState().reset();
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/conversation')
        ? new Response(JSON.stringify({ entries: [], hasMore: false, lastSeq: 0 }))
        : new Response('{}'),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

/** Sets the per-browser choices, then renders the app at a URL as a fresh page load. */
async function open(
  path = '/',
  prefs: { scene?: boolean; agents?: boolean; dock?: unknown } = {},
  /** Counts React commits of the whole page (a `Profiler` around it). */
  onCommit?: () => void,
): Promise<void> {
  if (prefs.scene !== undefined) localStorage.setItem(SCENE_VISIBLE_KEY, prefs.scene ? '1' : '0');
  if (prefs.agents !== undefined)
    localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, prefs.agents ? '1' : '0');
  if (prefs.dock !== undefined) localStorage.setItem(DOCK_KEY, JSON.stringify(prefs.dock));
  FakeWebSocket.instances = [];
  useAppStore.getState().reset();
  window.history.replaceState(null, '', path);
  render(
    onCommit ? (
      <Profiler id="page" onRender={onCommit}>
        <App />
      </Profiler>
    ) : (
      <App />
    ),
  );
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
}

async function reload(path = '/') {
  cleanup();
  await open(path);
}

/** The stacked layout (≤1100 px); the compact top bar only below 760 px. */
function narrow(phone = false) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === STACKED_LAYOUT_QUERY || (phone && query === '(max-width: 760px)'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const grid = () => document.querySelector('.pnl-grid')!;
const main = () => screen.getByRole('main');
const dockBody = () => document.getElementById('pnl-dock-body')!;
/** Minimised: the body is collapsed by CSS (still laid out), `inert` and `aria-hidden`. */
const collapsed = () => {
  const body = dockBody();
  const inert = body.hasAttribute('inert');
  expect(body.getAttribute('aria-hidden') === 'true').toBe(inert);
  expect(body.hidden).toBe(false); // never display: none (it would drop the scroll position)
  return inert;
};
const sceneRegion = () => screen.queryByRole('region', { name: 'solar system' });
const minimise = () => screen.getByRole('button', { name: 'Minimise the conversation' });
const restore = () => screen.getByRole('button', { name: 'Restore the conversation' });
const handle = () => screen.getByRole('separator', { name: 'Resize the conversation' });
const stored = () => JSON.parse(localStorage.getItem(DOCK_KEY) ?? 'null');

describe('the docked conversation (P4-10)', () => {
  it('sits under the scene in the centre, between the navigation and the side column', async () => {
    await open('/');
    const centre = document.querySelector('.pnl-centre')!;
    expect(centre.parentElement).toBe(grid());
    // nav | centre | side, in that order; the scene above the dock inside the centre.
    expect([...grid().children].map((c) => c.className.split(' ')[0])).toEqual([
      'pnl-nav',
      'pnl-centre',
      'pnl-side',
    ]);
    expect([...centre.children]).toEqual([sceneRegion(), main()]);
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
    // The bar: who, its state and activity, and the minimise button.
    const bar = main().querySelector('.pnl-dock-bar')!;
    expect(within(bar as HTMLElement).getByText('Harmonizer')).toBeTruthy();
    expect(within(bar as HTMLElement).getByText('Sizing the request')).toBeTruthy();
    expect(minimise().getAttribute('aria-expanded')).toBe('true');
    expect(minimise().getAttribute('aria-controls')).toBe('pnl-dock-body');
  });

  it('minimises to its bar and comes back, remembered after a reload', async () => {
    await open('/');
    expect(main().classList.contains('is-open')).toBe(true);
    expect(grid().classList.contains('pnl-grid-dock-open')).toBe(true);

    fireEvent.click(minimise());
    expect(restore().getAttribute('aria-expanded')).toBe('false');
    expect(main().classList.contains('is-minimised')).toBe(true);
    expect(grid().classList.contains('pnl-grid-dock-min')).toBe(true);
    expect(collapsed()).toBe(true);
    // Still mounted, only hidden: a draft and the live thread survive.
    expect(
      within(dockBody()).getByRole('region', { name: 'chat with Harmonizer', hidden: true }),
    ).toBeTruthy();
    // No handle while minimised; the bar keeps the title.
    expect(screen.queryByRole('separator')).toBeNull();
    expect(within(main()).getByRole('heading', { name: 'Harmonizer' })).toBeTruthy();
    expect(stored()).toEqual({ open: false, size: DOCK_DEFAULT });

    await reload('/');
    expect(main().classList.contains('is-minimised')).toBe(true);
    expect(collapsed()).toBe(true);

    fireEvent.click(restore());
    expect(minimise().getAttribute('aria-expanded')).toBe('true');
    expect(collapsed()).toBe(false);
    expect(stored()).toEqual({ open: true, size: DOCK_DEFAULT });
    await reload('/');
    expect(main().classList.contains('is-open')).toBe(true);
  });

  it('keeps a draft across minimise and restore', async () => {
    await open('/');
    const box = screen.getByRole('textbox', { name: 'message to Harmonizer' });
    fireEvent.change(box, { target: { value: 'half a thought' } });
    fireEvent.click(minimise());
    fireEvent.click(restore());
    expect(
      (screen.getByRole('textbox', { name: 'message to Harmonizer' }) as HTMLTextAreaElement).value,
    ).toBe('half a thought');
  });

  it('counts the replies that arrive while minimised', async () => {
    await open('/');
    fireEvent.click(minimise());
    expect(screen.queryByText(/new$/)).toBeNull();
    act(() => {
      useAppStore.getState().apply({
        type: 'transcript',
        agentId: 'a-harmonizer',
        chunks: [
          { agentId: 'a-harmonizer', seq: 5, at: fx.NOW, kind: 'text', text: 'Done sizing.' },
          { agentId: 'a-harmonizer', seq: 6, at: fx.NOW, kind: 'tool', text: 'propose_work' },
          { agentId: 'a-harmonizer', seq: 7, at: fx.NOW, kind: 'text', text: 'One card.' },
        ],
      } as Msg);
    });
    expect(screen.getByRole('status', { name: '2 new replies' }).textContent).toBe('2 new');
    fireEvent.click(restore());
    expect(screen.queryByRole('status', { name: /new replies/ })).toBeNull();
  });

  it('resizes from the keyboard, clamped to 25–75 % of the centre, and remembers it', async () => {
    await open('/');
    expect(handle().getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT));
    expect(handle().getAttribute('aria-valuemin')).toBe(String(DOCK_MIN));
    expect(handle().getAttribute('aria-valuemax')).toBe(String(DOCK_MAX));
    expect(handle().getAttribute('aria-orientation')).toBe('horizontal');
    expect(main().style.getPropertyValue('--pnl-dock-size')).toBe(`${DOCK_DEFAULT}%`);

    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(handle().getAttribute('aria-valuenow')).toBe('50');
    fireEvent.keyDown(handle(), { key: 'End' });
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(handle().getAttribute('aria-valuenow')).toBe('75');
    fireEvent.keyDown(handle(), { key: 'Home' });
    fireEvent.keyDown(handle(), { key: 'ArrowDown' });
    expect(handle().getAttribute('aria-valuenow')).toBe('25');
    fireEvent.keyDown(handle(), { key: 'PageUp' });
    expect(handle().getAttribute('aria-valuenow')).toBe('35');
    expect(main().style.getPropertyValue('--pnl-dock-size')).toBe('35%');
    expect(stored()).toEqual({ open: true, size: 35 });

    // Minimised and restored: back at the last height.
    fireEvent.click(minimise());
    await reload('/');
    fireEvent.click(restore());
    expect(handle().getAttribute('aria-valuenow')).toBe('35');
  });

  it('resizes by dragging its handle, saved when the drag ends', async () => {
    await open('/');
    const centre = document.querySelector('.pnl-centre') as HTMLElement;
    centre.getBoundingClientRect = () =>
      ({ top: 200, bottom: 1000, height: 800, left: 0, right: 800, width: 800 }) as DOMRect;
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 640 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 400 }); // (1000 - 400) / 800 = 75 %
    expect(handle().getAttribute('aria-valuenow')).toBe('75');
    expect(localStorage.getItem(DOCK_KEY)).toBeNull(); // not while dragging
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 980 }); // 2.5 % → clamped
    expect(handle().getAttribute('aria-valuenow')).toBe('25');
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 600 }); // 50 %
    expect(handle().getAttribute('aria-valuenow')).toBe('50');
    expect(stored()).toEqual({ open: true, size: 50 });
    expect(main().style.getPropertyValue('--pnl-dock-size')).toBe('50%');
  });

  it('a drag writes the height straight to the dock and renders only when it ends', async () => {
    let commits = 0;
    await open('/', {}, () => commits++);
    const centre = document.querySelector('.pnl-centre') as HTMLElement;
    centre.getBoundingClientRect = () =>
      ({ top: 200, bottom: 1000, height: 800, left: 0, right: 800, width: 800 }) as DOMRect;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    commits = 0;
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 640 });
    for (let i = 0; i < 40; i++) {
      fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 640 - i * 5 });
    }
    // On screen at once, without a single React render.
    expect(main().style.getPropertyValue('--pnl-dock-size')).toBe('69%'); // (1000 - 445) / 800
    expect(handle().getAttribute('aria-valuenow')).toBe('69');
    expect(commits).toBe(0);
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 440 }); // 70 %
    // One state update (the dock height), then at most one follow-up commit; never one per move.
    expect(commits).toBeGreaterThan(0);
    expect(commits).toBeLessThanOrEqual(2);
    expect(setItem.mock.calls.filter(([key]) => key === DOCK_KEY)).toHaveLength(1);
    expect(stored()).toEqual({ open: true, size: 70 });
    expect(main().style.getPropertyValue('--pnl-dock-size')).toBe('70%');
    expect(handle().getAttribute('aria-valuenow')).toBe('70');
    setItem.mockRestore();
  });

  it('a drag back to where it started still leaves the dock at that height', async () => {
    await open('/');
    const centre = document.querySelector('.pnl-centre') as HTMLElement;
    centre.getBoundingClientRect = () =>
      ({ top: 200, bottom: 1000, height: 800, left: 0, right: 800, width: 800 }) as DOMRect;
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientY: 640 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientY: 400 });
    fireEvent.pointerUp(handle(), { pointerId: 1, clientY: 640 }); // 45 %, the stored value
    expect(main().style.getPropertyValue('--pnl-dock-size')).toBe(`${DOCK_DEFAULT}%`);
    expect(handle().getAttribute('aria-valuenow')).toBe(String(DOCK_DEFAULT));
  });

  it('keeps the thread’s scroll position across minimise and restore', async () => {
    // jsdom has no layout: a ResizeObserver stub and a thread with a measured box.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly cb: () => void) {
          observers.push(() => this.cb());
        }
        observe() {}
        disconnect() {}
      },
    );
    await open('/');
    const thread = screen.getByRole('log', { name: 'conversation with Harmonizer' });
    let clientHeight = 300;
    Object.defineProperty(thread, 'clientHeight', { configurable: true, get: () => clientHeight });
    Object.defineProperty(thread, 'scrollHeight', { configurable: true, get: () => 2000 });
    const resized = () => observers.forEach((notify) => notify());

    thread.scrollTop = 500; // the user scrolled up, away from the bottom
    fireEvent.scroll(thread);
    fireEvent.click(minimise());
    expect(collapsed()).toBe(true);
    // Collapsed: no height; the browser may reset the box's position meanwhile.
    clientHeight = 0;
    resized();
    thread.scrollTop = 0;
    fireEvent.scroll(thread);
    fireEvent.click(restore());
    expect(collapsed()).toBe(false);
    clientHeight = 300;
    resized();
    expect(thread.scrollTop).toBe(500);
    // Same element all along: nothing was unmounted.
    expect(screen.getByRole('log', { name: 'conversation with Harmonizer' })).toBe(thread);
  });

  it('the minimise button’s aria-expanded follows the dock', async () => {
    await open('/');
    const button = minimise();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-label')).toBe('Restore the conversation');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Minimise the conversation');
  });

  it('names the dock after who it is about', async () => {
    await open('/');
    expect(screen.getByRole('main', { name: 'Conversation with Harmonizer' })).toBe(main());
    await reload('/waykeeper/a-waykeeper-1');
    expect(screen.getByRole('main', { name: /^Conversation with Waykeeper · / })).toBe(main());
    await reload('/steward/a-steward-1');
    expect(screen.getByRole('main', { name: /^Steward · / })).toBe(main());
  });

  it('keeps a draft when the chat remounts (a reload of the view, the breakpoint)', async () => {
    await open('/');
    fireEvent.change(screen.getByRole('textbox', { name: 'message to Harmonizer' }), {
      target: { value: 'half a thought' },
    });
    // Crossing 1100 px renders the other layout's tree: the chat mounts afresh.
    cleanup();
    narrow();
    await open('/');
    expect(grid().classList.contains('pnl-grid-stacked')).toBe(true);
    expect(
      (screen.getByRole('textbox', { name: 'message to Harmonizer' }) as HTMLTextAreaElement).value,
    ).toBe('half a thought');
  });

  it('keeps each agent’s draft when switching between them, and clears it when sent', async () => {
    await open('/');
    const box = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLTextAreaElement;
    fireEvent.change(box(/^message to Harmonizer$/), { target: { value: 'for the Harmonizer' } });
    act(() => useAppStore.getState().select({ kind: 'waykeeper', id: 'a-waykeeper-1' }));
    expect(box(/^message to Waykeeper/).value).toBe('');
    fireEvent.change(box(/^message to Waykeeper/), { target: { value: 'for the Waykeeper' } });
    act(() => useAppStore.getState().select({ kind: 'harmonizer' }));
    expect(box(/^message to Harmonizer$/).value).toBe('for the Harmonizer');
    act(() => useAppStore.getState().select({ kind: 'waykeeper', id: 'a-waykeeper-1' }));
    expect(box(/^message to Waykeeper/).value).toBe('for the Waykeeper');

    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).includes('/send')
        ? new Response(JSON.stringify({ messageId: 'm-1' }))
        : new Response(JSON.stringify({ entries: [], hasMore: false, lastSeq: 0 })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await vi.waitFor(() => expect(box(/^message to Waykeeper/).value).toBe(''));
    expect(useConversationStore.getState().drafts).toEqual({
      'a-harmonizer': 'for the Harmonizer',
    });
  });

  it('clamps and validates what the browser stored', () => {
    expect(clampDockSize(10)).toBe(DOCK_MIN);
    expect(clampDockSize(90)).toBe(DOCK_MAX);
    expect(clampDockSize(52.4)).toBe(52);
    expect(clampDockSize(Number.NaN)).toBe(DOCK_DEFAULT);
    localStorage.setItem(DOCK_KEY, '{not json');
    expect(readDockPrefs()).toEqual({ open: true, size: DOCK_DEFAULT });
    localStorage.setItem(DOCK_KEY, JSON.stringify({ open: false, size: 99 }));
    expect(readDockPrefs()).toEqual({ open: false, size: DOCK_MAX });
    localStorage.setItem(DOCK_KEY, JSON.stringify({ size: 'big' }));
    expect(readDockPrefs()).toEqual({ open: true, size: DOCK_DEFAULT });
  });

  it('survives a browser without storage', async () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === DOCK_KEY) throw new Error('denied');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === DOCK_KEY) throw new Error('denied');
      setItem.call(this, key, value);
    };
    try {
      await open('/');
      fireEvent.click(minimise());
      expect(main().classList.contains('is-minimised')).toBe(true); // for this page only
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });

  it('keeps the scene’s overlays inside the scene area, above the dock', async () => {
    await open('/');
    const scene = sceneRegion()!;
    for (const overlay of ['.pnl-scene-crumbs', '.pnl-scene-scale', '.scene-labels']) {
      const el = document.querySelector(overlay);
      expect(el, overlay).toBeTruthy();
      expect(scene.contains(el), overlay).toBe(true);
      expect(main().contains(el), overlay).toBe(false);
    }
    expect(scene.contains(main())).toBe(false);
    expect(main().contains(scene)).toBe(false);
  });

  it('a Waykeeper’s bar carries its controls; a Steward’s says when it is blocked on you', async () => {
    await open('/waykeeper/a-waykeeper-1');
    const bar = main().querySelector('.pnl-dock-bar') as HTMLElement;
    expect(within(bar).getByRole('group', { name: /^controls of / })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Minimise the conversation' })).toBeTruthy();

    // The snapshot's user-held question comes from this Steward.
    await reload('/steward/a-steward-1');
    const stewardBar = main().querySelector('.pnl-dock-bar') as HTMLElement;
    expect(within(stewardBar).getByText('blocked on you')).toBeTruthy();
    expect(within(main()).getByRole('region', { name: /^view of / })).toBeTruthy();
  });
});

describe('layouts (P4-10)', () => {
  const combos = [true, false].flatMap((scene) =>
    [true, false].flatMap((agents) => [true, false].map((open) => ({ scene, agents, open }))),
  );

  it.each(combos)('wide: scene $scene, agents $agents, dock open $open', async (c) => {
    await open('/', { scene: c.scene, agents: c.agents, dock: { open: c.open, size: 40 } });
    const cls = grid().classList;
    expect(cls.contains('pnl-grid-scene')).toBe(c.scene);
    expect(cls.contains('pnl-grid-no-agents')).toBe(!c.agents);
    expect(cls.contains('pnl-grid-stacked')).toBe(false);
    expect(Boolean(sceneRegion())).toBe(c.scene);
    expect(Boolean(screen.queryByRole('region', { name: 'managed agents' }))).toBe(c.agents);
    // The inbox is always there, in the side column, never in the centre.
    const inbox = screen.getByRole('region', { name: 'inbox' });
    expect(inbox.closest('.pnl-side')).toBeTruthy();
    expect(document.querySelector('.pnl-centre')!.contains(inbox)).toBe(false);
    if (c.scene) {
      expect(cls.contains(c.open ? 'pnl-grid-dock-open' : 'pnl-grid-dock-min')).toBe(true);
      expect(main().classList.contains(c.open ? 'is-open' : 'is-minimised')).toBe(true);
      expect(Boolean(screen.queryByRole('separator'))).toBe(c.open);
    } else {
      // List mode: the conversation is the centre; nothing to minimise it for.
      expect(cls.contains('pnl-grid-dock-open') || cls.contains('pnl-grid-dock-min')).toBe(false);
      expect(main().classList.contains('is-open')).toBe(true);
      expect(main().classList.contains('is-collapsible')).toBe(false);
      expect(screen.queryByRole('button', { name: /the conversation$/ })).toBeNull();
      expect(screen.queryByRole('separator')).toBeNull();
      expect(collapsed()).toBe(false);
    }
  });

  it.each(combos)('stacked: scene $scene, agents $agents, dock open $open', async (c) => {
    narrow();
    await open('/', { scene: c.scene, agents: c.agents, dock: { open: c.open, size: 40 } });
    const cls = grid().classList;
    expect(cls.contains('pnl-grid-stacked')).toBe(true);
    expect(cls.contains(c.open ? 'pnl-grid-dock-open' : 'pnl-grid-dock-min')).toBe(true);
    // One scrolling stack (scene, navigation, side column), the dock under it.
    const stack = grid().querySelector('.pnl-stack')!;
    expect([...grid().children]).toEqual([stack, main()]);
    const parts = [...stack.children].map((el) => el.className.split(' ')[0]);
    expect(parts).toEqual(c.scene ? ['pnl-scene', 'pnl-nav', 'pnl-side'] : ['pnl-nav', 'pnl-side']);
    expect(Boolean(screen.queryByRole('region', { name: 'managed agents' }))).toBe(c.agents);
    // The bar minimises here in list mode too.
    const toggle = c.open ? minimise() : restore();
    expect(toggle.getAttribute('aria-expanded')).toBe(String(c.open));
    expect(collapsed()).toBe(!c.open);
  });

  it('on the phone, the compact top bar and the stacked dock work together', async () => {
    narrow(true);
    await open('/', { scene: false });
    expect(screen.getByRole('button', { name: 'Menu' })).toBeTruthy();
    // P8-18: in list mode the chat has the whole screen — nothing to minimise it for, no inbox in
    // the stack (the top bar's Inbox button opens it full screen).
    expect(screen.queryByRole('button', { name: 'Minimise the conversation' })).toBeNull();
    expect(main().classList.contains('is-open')).toBe(true);
    expect(document.getElementById('pnl-inbox')).toBeNull();
    expect(screen.getByRole('button', { name: /^Inbox/ })).toBeTruthy();
  });
});

/** The rules jsdom cannot apply, read from the stylesheets. */
describe('the shell fits the viewport (P4-10)', () => {
  const read = (file: string) =>
    readFileSync(resolve(import.meta.dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const panel = read('panel.css');
  const chat = read('chat/chat.css');
  /** Every declaration block whose selector list is exactly `selector`, merged in order. */
  function rule(sheet: string, selector: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (m[1]!.trim() !== selector) continue;
      for (const d of m[2]!.split(';')) {
        const i = d.indexOf(':');
        if (i < 0) continue;
        (out[d.slice(0, i).trim()] ??= []).push(d.slice(i + 1).trim());
      }
    }
    return out;
  }

  it('the shell is exactly the viewport, and hides any overflow', () => {
    const shell = rule(panel, '.pnl');
    expect(shell['height']).toEqual(['100vh', '100dvh']);
    expect(shell['overflow']).toEqual(['hidden']);
    expect(shell['min-height']).toBeUndefined();
    // No later rule lets the shell grow again (the old list mode and the stacked layout did).
    expect(panel).not.toMatch(/\.pnl(\.pnl-with-scene)?\s*\{[^}]*height:\s*auto/);
    expect(panel).not.toMatch(/min-height:\s*100d?vh/);
  });

  it('the body and the grid fill what the top bar leaves, and only scroll inside', () => {
    const body = rule(panel, '.pnl-body');
    expect(body['flex']).toEqual(['1 1 0']);
    expect(body['min-height']).toEqual(['0']);
    expect(body['overflow-y']).toEqual(['auto']);
    const g = rule(panel, '.pnl-grid');
    expect(g['flex']).toEqual(['1 1 0']);
    expect(g['min-height']).toEqual(['0']);
  });

  it('no grid has a fixed row that could push past the viewport', () => {
    const rows = [...panel.matchAll(/grid-template-rows:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r, r).not.toMatch(/\d(px|vh|dvh|svh|lvh|em|rem)\b/);
  });

  it('on the phone the bar starts under the handle, so the handle takes no tap from its buttons', () => {
    const handleHeights = rule(panel, '.pnl-dock-handle')['height']!.map((h) => parseFloat(h));
    const pad = rule(panel, '.pnl-dock-handle + .pnl-dock-bar')['padding-top'];
    expect(pad).toBeDefined();
    expect(parseFloat(pad!.at(-1)!)).toBeGreaterThanOrEqual(Math.max(...handleHeights));
  });

  it('the open dock has a pixel floor, within its largest share', () => {
    const height = rule(panel, '.pnl-dock.is-collapsible.is-open')['height']!;
    expect(height).toEqual(['max(var(--pnl-dock-size, 45%), min(160px, 75%))']);
  });

  it('minimised, the body collapses but stays laid out (no display: none)', () => {
    const body = rule(panel, '.pnl-dock.is-minimised > .pnl-dock-body');
    expect(body['height']).toEqual(['0']);
    expect(body['visibility']).toEqual(['hidden']);
    expect(body['display']).toBeUndefined();
    expect(panel).not.toMatch(/\.pnl-dock-body\[hidden\]/);
  });

  it('the "More" menu is not forced upwards in every dock bar (it measures where it fits)', () => {
    expect(panel).not.toMatch(/\.pnl-dock-bar \.ctl-menu/);
    const cards = read('agent-cards.css');
    expect(rule(cards, ".ctl-menu[data-placement='above']")['bottom']).toEqual(['100%']);
    expect(rule(cards, '.ctl-menu')['top']).toEqual(['100%']);
  });

  it('the chat thread fills the dock instead of a viewport-sized cap', () => {
    const t = rule(chat, '.pnl-thread');
    expect(t['max-height']).toBeUndefined();
    expect(t['min-height']).toEqual(['0']);
    expect(t['flex']).toEqual(['1 1 0']);
    expect(chat).not.toMatch(/calc\(100vh/);
  });
});
