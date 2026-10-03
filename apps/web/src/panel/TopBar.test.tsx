// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { COMPACT_TOP_BAR_QUERY } from './use-media-query.js';

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
      return query === COMPACT_TOP_BAR_QUERY && narrow;
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

describe('the compact top bar (P3-12)', () => {
  beforeEach(() => {
    stubWidth(true);
  });

  it('shows only the essentials in one row: brand, connection, waiting count, menu button', async () => {
    await open('/steward/a-steward-1');
    const bar = top();
    expect(bar.classList.contains('pnl-top-compact')).toBe(true);
    expect(within(bar).getByRole('link', { name: 'GalacticAgents' }).getAttribute('href')).toBe(
      '/',
    );
    expect(within(bar).getByRole('img', { name: 'connection: live' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '2 waiting for you' })).toBeTruthy();
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
    await open();
    openMenu();
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    const m = menu();
    expect(m.hidden).toBe(false);
    expect(m.getAttribute('aria-label')).toBe('menu');
    const items = Array.from(m.querySelectorAll('a, button')).map((el) => el.textContent);
    // jsdom has no WebGL: the scene control is the "unavailable" note (no Retry there).
    expect(within(m).getByRole('note').textContent).toBe('3D scene unavailable — list mode');
    expect(items).toEqual([
      'Notifications: unavailable', // jsdom has no Notification API
      'History',
      'Settings',
      'Forget token',
      'Ops console',
    ]);
    expect(within(m).getByLabelText('summary').textContent).toBe('live2 open questions1 blocked');
    expect(document.activeElement).toBe(within(m).getByRole('button', { name: /^Notifications/ }));
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
    fireEvent.pointerDown(screen.getByRole('main', { name: 'main area' }));
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
    fireEvent.blur(last, { relatedTarget: screen.getByRole('main', { name: 'main area' }) });
    expect(menu().hidden).toBe(true);
  });

  it('closes on navigation: a menu link, and a selection made elsewhere', async () => {
    await open();
    openMenu();
    fireEvent.click(within(menu()).getByRole('link', { name: 'History' }));
    expect(useAppStore.getState().route).toBe('history');
    expect(window.location.pathname).toBe('/history');
    expect(menu().hidden).toBe(true);
    expect(document.activeElement).toBe(menuButton());

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

  it('takes the waiting count to the inbox, from the panel and from another page', async () => {
    await open();
    fireEvent.click(within(top()).getByRole('button', { name: '2 waiting for you' }));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'inbox' })),
    );

    act(() =>
      useAppStore.getState().navigate({ route: 'settings', selection: { kind: 'harmonizer' } }),
    );
    expect(screen.queryByRole('region', { name: 'inbox' })).toBeNull();
    fireEvent.click(within(top()).getByRole('button', { name: '2 waiting for you' }));
    expect(useAppStore.getState().route).toBe('panel');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'inbox' })),
    );
  });
});
