// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliverablesResponse } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';
import { DOCK_VIEW_KEY, useDockView } from '../status/dock-view.js';
import { openApp, quietFetch } from '../../a11y/a11y-fixtures.js';

/**
 * P9-09 — the Waykeeper dock's third view ("Chat | Status | Deliverables", remembered per browser
 * like decision 80's switch, so it survives a reload), the Harmonizer's two, the Steward view's
 * section, and the navigation row's "⋯ Deliverables".
 */

const json = (body: unknown) => new Response(JSON.stringify(body));
const deliverables = (url: string): Response | undefined => {
  const u = new URL(url, 'http://localhost');
  if (u.pathname !== '/api/deliverables') return undefined;
  const rows =
    u.searchParams.get('taskId') === 't-1'
      ? [fx.deliverable]
      : u.searchParams.get('projectId') === 'p-1'
        ? [fx.deliverable, fx.commandDeliverable]
        : [];
  return json({ deliverables: rows } satisfies DeliverablesResponse);
};

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  useDockView.getState().reload();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', quietFetch(deliverables));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const main = () => screen.getByRole('main');

describe("the Waykeeper dock's Deliverables view (P9-09)", () => {
  it('is the third view of a project, remembered across a reload; the Harmonizer has two', async () => {
    await openApp('/waykeeper/a-waykeeper-1');
    const toggle = within(main()).getByRole('group', {
      name: 'show the chat, the status or the deliverables',
    });
    fireEvent.click(within(toggle).getByRole('button', { name: 'Deliverables' }));
    await flush();
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('deliverables');
    const view = await screen.findByTestId('deliverables-project');
    expect(within(view).getByText('Login screen')).toBeTruthy();
    expect(within(view).getByText('pnpm run dev')).toBeTruthy();
    // The chat stays mounted under it, out of reach.
    expect(document.querySelector('.sts-pane-chat')!.hasAttribute('inert')).toBe(true);

    // A reload: the stored choice comes back.
    cleanup();
    useAppStore.getState().reset();
    useDockView.getState().reload();
    await openApp('/waykeeper/a-waykeeper-1');
    expect(await screen.findByTestId('deliverables-project')).toBeTruthy();

    // The Harmonizer has no Deliverables view: its chat shows, its switch has two options.
    cleanup();
    useAppStore.getState().reset();
    await openApp('/');
    const two = within(main()).getByRole('group', { name: 'show the chat or the status' });
    expect(
      within(two)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Chat', 'Status']);
    expect(within(two).getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByTestId('deliverables-project')).toBeNull();
  });

  it("shows the task's deliverables in the Steward view", async () => {
    await openApp('/steward/a-steward-1');
    const section = await screen.findByTestId('deliverables-task');
    expect(within(section).getByText('Login screen')).toBeTruthy();
    expect(within(section).getByText('added by', { exact: false })).toBeTruthy();
  });

  it('opens them from a navigation row’s "⋯ Deliverables"', async () => {
    await openApp('/');
    const nav = screen.getByRole('navigation', { name: 'navigation' });
    fireEvent.click(within(nav).getByRole('button', { name: 'Actions for Auth refactor' }));
    fireEvent.click(within(nav).getByRole('button', { name: 'Deliverables' }));
    await flush();
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    const view = await screen.findByTestId('deliverables-project');
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        within(view).getByRole('heading', { name: /Deliverables of Auth refactor/ }),
      ),
    );
  });
});
