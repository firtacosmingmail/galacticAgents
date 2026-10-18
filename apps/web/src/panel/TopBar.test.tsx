// @vitest-environment jsdom
// The page as a remote device loads it: a loopback page is never on a slow connection (P7-03).
// @vitest-environment-options {"url": "https://mymac.tail1234.ts.net/"}
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY } from './use-media-query.js';

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, fx.agent],
  bodies: [fx.body, fx.moon, fx.asteroid],
  projects: [fx.project],
  tasks: [fx.task, fx.asteroidTask],
  questions: [{ ...fx.question, id: 'q-user', holder: { type: 'user' } }, { ...fx.question }],
  proposals: [fx.proposal],
  statuses: [{ ...fx.status, agentId: 'a-harmonizer' }],
};

/** A `matchMedia` whose compact query matches while `narrow` is true; `resize` flips it. */
function stubWidth(initiallyNarrow: boolean) {
  let narrow = initiallyNarrow;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      // A phone's width is compact and stacked (760 px < 1100 px).
      return (query === COMPACT_TOP_BAR_QUERY || query === STACKED_LAYOUT_QUERY) && narrow;
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    resize(toNarrow: boolean) {
      narrow = toNarrow;
      act(() => listeners.forEach((fn) => fn()));
    },
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/messages')
        ? new Response(JSON.stringify({ messages: [] }))
        : new Response('{}'),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(path = '/') {
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
}

const top = () => document.querySelector<HTMLElement>('header.pnl-top')!;
const menuButton = () => within(top()).getByRole('button', { name: 'Menu' });
const menu = () => document.getElementById(menuButton().getAttribute('aria-controls')!)!;
const openMenu = () => fireEvent.click(menuButton());

describe('the wide top bar (desktop layout, unchanged by P3-12)', () => {
  it('keeps every control in the bar, in the same order, with no menu button', async () => {
    await open();
    const bar = top();
    expect(within(bar).queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(Array.from(bar.children).map((c) => c.className)).toEqual([
      'pnl-skip', // P5-04: the skip link, shown only while focused
      'pnl-link pnl-brand',
      'pnl-conn pnl-conn-live',
      'pnl-top-counts',
      'pnl-spacer',
      'pnl-scene-off',
      'ntf-control',
      'pnl-link pnl-history-link',
      'pnl-link pnl-settings-link',
      'pnl-link pnl-debug-link',
      'pnl-forget',
    ]);
    expect(within(bar).getByLabelText('summary').textContent).toBe(
      '2 waiting for you2 open questions1 blocked',
    );
  });

  it('shows the connection without a live region, so reconnect retries are not announced', async () => {
    await open();
    const bar = top();
    const conn = within(bar).getByRole('img', { name: 'connection: live' });
    expect(conn.textContent).toBe('live');
    expect(within(bar).queryByRole('status')).toBeNull();
    expect(within(bar).queryByRole('alert')).toBeNull();
    expect(within(bar).queryByRole('log')).toBeNull();
    expect(bar.querySelector('[aria-live]')).toBeNull();
  });

  it('switches to the compact bar when the window narrows, and back', async () => {
    const width = stubWidth(false);
    await open();
    expect(within(top()).getByRole('link', { name: 'History' })).toBeTruthy();
    width.resize(true);
    expect(menuButton()).toBeTruthy();
    expect(within(top()).queryByRole('link', { name: 'History' })).toBeNull();
    width.resize(false);
    expect(within(top()).queryByRole('button', { name: 'Menu' })).toBeNull();
  });
});

describe('list mode on a slow connection (P7-03)', () => {
  it('starts in list mode on a wide screen too, the bar offering the scene', async () => {
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(navigator), { connection: { saveData: true } }),
    );
    await open();
    expect(document.querySelector('.pnl-scene')).toBeNull();
    expect(within(top()).getByRole('button', { name: 'Show scene' })).toBeTruthy();
    // The one-tap row is the phone's: the wide bar already has the toggle.
    expect(screen.queryByRole('region', { name: 'solar system' })).toBeNull();
  });
});

describe('the compact top bar (P3-12)', () => {
  beforeEach(() => {
    stubWidth(true);
  });

  it('shows only the essentials in one row: brand, connection, agents, inbox, menu button', async () => {
    await open('/steward/a-steward-1');
    const bar = top();
    expect(bar.classList.contains('pnl-top-compact')).toBe(true);
    expect(within(bar).getByRole('link', { name: 'GalacticAgents' }).getAttribute('href')).toBe(
      '/',
    );
    expect(within(bar).getByRole('img', { name: 'connection: live' })).toBeTruthy();
    // P8-18: the inbox and the managed agents are full screens on a phone, one tap away.
    expect(within(bar).getByRole('button', { name: 'Inbox, 2 waiting' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Managed agents' })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: '2 waiting for you' })).toBeNull();
    const button = menuButton();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(menu().hidden).toBe(true);
    for (const name of ['History', 'Settings', 'Ops console'])
      expect(within(bar).queryByRole('link', { name })).toBeNull();
    expect(within(bar).queryByRole('button', { name: 'Forget token' })).toBeNull();
    expect(within(bar).queryByRole('button', { name: /^Notifications/ })).toBeNull();

    // The brand goes back to the Harmonizer.
    fireEvent.click(within(bar).getByRole('link', { name: 'GalacticAgents' }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'harmonizer' });
  });

  it('opens a menu with every other action, moving focus into it', async () => {
    // Shown by choice: a phone with no choice starts in list mode (P7-03, below).
    localStorage.setItem('galactic.scene.visible', '1');
    await open();
    openMenu();
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    const m = menu();
    expect(m.hidden).toBe(false);
    expect(m.getAttribute('aria-label')).toBe('menu');
    const items = Array.from(m.querySelectorAll('a, button')).map((el) => el.textContent);
    // jsdom has no WebGL: the scene control is the "unavailable" note (no Retry there).
    expect(within(m).getByRole('note').textContent).toBe('3D scene unavailable — list mode');
    // P8-18: no Hide / Show inbox or managed agents — the bar's buttons open them full screen.
    expect(items).toEqual([
      'Notifications: unavailable', // jsdom has no Notification API
      'History',
      'Settings',
      'Forget token',
      'Ops console',
    ]);
    expect(within(m).getByLabelText('summary').textContent).toBe('live2 open questions1 blocked');
    expect(document.activeElement).toBe(
      within(m).getByRole('button', { name: 'Notifications: unavailable' }),
    );
  });

  it('offers Hide / Show scene from the menu where the scene can run', async () => {
    const canvas = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
    try {
      localStorage.setItem('galactic.scene.visible', '0');
      await open();
      openMenu();
      fireEvent.click(within(menu()).getByRole('button', { name: 'Show scene' }));
      expect(localStorage.getItem('galactic.scene.visible')).toBe('1');
      expect(menu().hidden).toBe(true);
      expect(document.activeElement).toBe(menuButton());
    } finally {
      HTMLCanvasElement.prototype.getContext = canvas;
    }
  });

  it('starts in list mode with no choice made and offers the scene with one tap (P7-03)', async () => {
    await open();
    expect(document.querySelector('.pnl-scene')).toBeNull();
    const offer = screen.getByRole('region', { name: 'solar system' });
    expect(offer.textContent).toContain('List mode, for a small screen.');
    // Nothing remembered until the user chooses.
    expect(localStorage.getItem('galactic.scene.visible')).toBeNull();
    fireEvent.click(within(offer).getByRole('button', { name: 'Show scene' }));
    expect(localStorage.getItem('galactic.scene.visible')).toBe('1');
    // Shown (jsdom has no WebGL, so the menu says the scene is unavailable instead of a canvas).
    expect(screen.queryByRole('region', { name: 'solar system' })).toBeNull();
    openMenu();
    expect(within(menu()).getByRole('note').textContent).toBe('3D scene unavailable — list mode');
  });

  it('keeps the one-tap offer in list mode chosen from the menu, without a reason', async () => {
    localStorage.setItem('galactic.scene.visible', '0');
    await open();
    const offer = screen.getByRole('region', { name: 'solar system' });
    expect(offer.textContent).toBe('List mode.Show scene');
  });

  it('shows the scene on a phone that chose it, with no offer', async () => {
    localStorage.setItem('galactic.scene.visible', '1');
    await open();
    expect(screen.queryByRole('region', { name: 'solar system' })).toBeNull();
  });

  it('closes on the button, on Escape and on an outside tap, returning focus as it should', async () => {
    await open();
    openMenu();
    fireEvent.click(menuButton());
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(menuButton());

    openMenu();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(menu().hidden).toBe(true);
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menuButton());

    openMenu();
    fireEvent.pointerDown(screen.getByRole('main'));
    expect(menu().hidden).toBe(true);

    // A tap inside the menu keeps it open.
    openMenu();
    fireEvent.pointerDown(within(menu()).getByLabelText('summary'));
    expect(menu().hidden).toBe(false);
  });

  it('closes when focus is tabbed out of it', async () => {
    await open();
    openMenu();
    const last = within(menu()).getByRole('link', { name: 'Ops console' });
    fireEvent.blur(last, { relatedTarget: screen.getByRole('main') });
    expect(menu().hidden).toBe(true);
  });

  it('closes on navigation: a menu link, and a selection made elsewhere', async () => {
    await open();
    openMenu();
    fireEvent.click(within(menu()).getByRole('link', { name: 'History' }));
    expect(useAppStore.getState().route).toBe('history');
    expect(window.location.pathname).toBe('/history');
    expect(menu().hidden).toBe(true);
    // A link to another page puts the focus on that page's heading (P5-04), not back on the menu.
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'History' }));

    openMenu();
    expect(within(menu()).getByRole('link', { name: 'History' }).getAttribute('aria-current')).toBe(
      'page',
    );
    act(() =>
      useAppStore.getState().navigate({ route: 'settings', selection: { kind: 'harmonizer' } }),
    );
    expect(menu().hidden).toBe(true);

    openMenu();
    fireEvent.click(within(menu()).getByRole('link', { name: 'Ops console' }));
    expect(useAppStore.getState().route).toBe('debug');
  });

  it('unfolds the notification settings inside the menu', async () => {
    await open();
    openMenu();
    const toggle = within(menu()).getByRole('button', { name: /^Notifications: / });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const region = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(region.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region.hidden).toBe(false);
    expect(within(region).getByText(/each device chooses its own/)).toBeTruthy();
    // Using it does not close the menu.
    expect(menu().hidden).toBe(false);
  });

  it('forgets the token from the menu', async () => {
    await open();
    openMenu();
    fireEvent.click(within(menu()).getByRole('button', { name: 'Forget token' }));
    expect(localStorage.getItem('galactic.token')).toBeNull();
  });

  it('the Inbox button opens the inbox view and closes it again (P8-18)', async () => {
    await open();
    const inbox = () => within(top()).getByRole('button', { name: /^Inbox/ });
    expect(inbox().getAttribute('aria-pressed')).toBe('false');
    expect(inbox().querySelector('.pnl-phone-dot')).not.toBeNull();
    fireEvent.click(inbox());
    expect(inbox().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(inbox());
    expect(inbox().getAttribute('aria-pressed')).toBe('false');
  });

  it('the managed-agents button opens its view; it is not the navigation sheet button', async () => {
    await open();
    const agents = within(top()).getByRole('button', { name: 'Managed agents' });
    expect(agents.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(agents);
    expect(agents.getAttribute('aria-pressed')).toBe('true');
    // The sheet's button keeps its own name.
    expect(within(top()).getByRole('button', { name: /^Agents/ })).not.toBe(agents);
  });

  it('lights no dot for questions a supervisor holds', async () => {
    window.history.replaceState(null, '', '/');
    render(<App />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.serverOpens();
      socket.serverSends({ ...snapshot, questions: [{ ...fx.question }], proposals: [] });
    });
    const inbox = within(top()).getByRole('button', { name: 'Inbox' });
    expect(inbox.querySelector('.pnl-phone-dot')).toBeNull();
  });

  it('from another page the Inbox button comes back to the panel with the inbox open', async () => {
    await open();
    act(() =>
      useAppStore.getState().navigate({ route: 'settings', selection: { kind: 'harmonizer' } }),
    );
    fireEvent.click(within(top()).getByRole('button', { name: /^Inbox/ }));
    expect(useAppStore.getState().route).toBe('panel');
    await vi.waitFor(() =>
      expect(
        within(top())
          .getByRole('button', { name: /^Inbox/ })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
  });
});
