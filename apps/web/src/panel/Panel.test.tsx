// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Project, ServerMessage, StatusRecord, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';

const LATER = '2026-09-30T11:00:00.000Z';

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const billingWaykeeper: Agent = { ...waykeeper, id: 'a-waykeeper-2', projectId: 'p-2' };
const asteroidSteward: Agent = {
  ...fx.agent,
  id: 'a-steward-2',
  taskId: 't-2',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-ast-1',
};
/** Created after "Auth refactor" but blocked on the user: it must be listed first. */
const billing: Project = {
  ...fx.project,
  id: 'p-2',
  name: 'Billing export',
  bodyId: 'b-kepler',
  state: 'blocked_on_user',
  createdAt: LATER,
};
const quietAsteroid: Task = {
  ...fx.asteroidTask,
  id: 't-3',
  description: 'Bump the lint rules',
  state: 'in_progress',
  blockedBy: [],
  createdAt: '2026-09-30T09:00:00.000Z',
};
const working = (agentId: string): StatusRecord => ({ ...fx.status, agentId });

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, billingWaykeeper, fx.agent, asteroidSteward],
  bodies: [fx.body, fx.moon, fx.asteroid],
  projects: [fx.project, billing],
  tasks: [fx.task, fx.asteroidTask, quietAsteroid],
  questions: [],
  proposals: [],
  statuses: [
    working('a-harmonizer'),
    working('a-waykeeper-1'),
    working('a-waykeeper-2'),
    working('a-steward-1'),
    working('a-steward-2'),
  ],
};

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

/** Renders the app at a URL and feeds it the snapshot over the (fake) socket. */
async function open(path: string, initial: ServerMessage = snapshot) {
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(initial);
  });
}

const main = () => screen.getByRole('main', { name: 'main area' });
const nav = () => screen.getByRole('navigation', { name: 'navigation' });

describe('panel shell and selection (P25-02)', () => {
  it('navigates between the Harmonizer, a Waykeeper and a Steward', async () => {
    await open('/');
    expect(useAppStore.getState().selection).toEqual({ kind: 'harmonizer' });
    expect(main().dataset['selection']).toBe('harmonizer');
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();

    // A project row opens its Waykeeper's conversation.
    fireEvent.click(within(nav()).getByRole('link', { name: /Auth refactor/ }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    expect(window.location.pathname).toBe('/waykeeper/a-waykeeper-1');
    expect(
      within(main()).getByRole('region', { name: 'chat with Waykeeper · Auth refactor' }),
    ).toBeTruthy();

    // Its task (shown nested while the project is selected) opens the Steward's read-only view.
    fireEvent.click(within(nav()).getByRole('link', { name: /Replace the session middleware/ }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-steward-1' });
    expect(window.location.pathname).toBe('/steward/a-steward-1');
    expect(
      within(main()).getByRole('region', {
        name: 'view of Steward · Replace the session middleware',
      }),
    ).toBeTruthy();
    expect(within(main()).queryByRole('textbox')).toBeNull(); // no message box (decision 13)
    expect(screen.getByRole('region', { name: 'managed agents' }).textContent).toMatch(
      /Reports to.*Waykeeper · Auth refactor/,
    );

    // The Harmonizer is one click away; back goes to the Steward again.
    fireEvent.click(within(nav()).getByRole('link', { name: /Harmonizer/ }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'harmonizer' });
    expect(window.location.pathname).toBe('/');
    expect(within(main()).getByRole('region', { name: 'chat with Harmonizer' })).toBeTruthy();
    await act(async () => {
      window.history.back();
      await vi.waitFor(() => expect(window.location.pathname).toBe('/steward/a-steward-1'));
    });
    expect(main().dataset['selection']).toBe('steward:a-steward-1');
  });

  it('lists the Harmonizer’s managed agents: Waykeepers and asteroid Stewards', async () => {
    await open('/');
    const managed = screen.getByRole('region', { name: 'managed agents' });
    expect(within(managed).getByText('Waykeeper · Auth refactor')).toBeTruthy();
    expect(within(managed).getByText('Waykeeper · Billing export')).toBeTruthy();
    expect(within(managed).getByText('Steward · Fix the flaky date test')).toBeTruthy();
    expect(within(managed).queryByText(/Replace the session middleware/)).toBeNull();
    fireEvent.click(within(managed).getByText('Waykeeper · Billing export'));
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-2' });
  });

  it('restores the selection from a deep link (a reload)', async () => {
    await open('/waykeeper/a-waykeeper-1');
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    expect(
      within(main()).getByRole('region', { name: 'chat with Waykeeper · Auth refactor' }),
    ).toBeTruthy();
    const current = within(nav()).getByRole('link', { current: 'page' });
    expect(current.textContent).toMatch(/Auth refactor/);
  });

  it('restores a Steward deep link and says so when the agent is unknown', async () => {
    await open('/steward/a-steward-2');
    expect(
      within(main()).getByRole('region', { name: 'view of Steward · Fix the flaky date test' }),
    ).toBeTruthy();
    cleanup();
    FakeWebSocket.instances = [];
    useAppStore.getState().reset();
    await open('/steward/a-gone');
    expect(main().textContent).toMatch(/not in the current log/);
  });

  it('rewrites a link whose kind is not the agent’s role (/waykeeper/<a Steward>)', async () => {
    const entries = window.history.length;
    await open('/waykeeper/a-steward-1');
    await vi.waitFor(() => expect(window.location.pathname).toBe('/steward/a-steward-1'));
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-steward-1' });
    expect(main().dataset['selection']).toBe('steward:a-steward-1');
    expect(
      within(main()).getByRole('region', {
        name: 'view of Steward · Replace the session middleware',
      }),
    ).toBeTruthy();
    // Replaced, not pushed: back does not return to the wrong URL.
    expect(window.history.length).toBe(entries);
  });

  it('forgets the token from the panel’s top bar', async () => {
    await open('/');
    fireEvent.click(screen.getByRole('button', { name: 'Forget token' }));
    expect(localStorage.getItem('galactic.token')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'navigation' })).toBeNull();
  });

  it('shows the ops console at /debug, and links back to the panel', async () => {
    await open('/debug');
    expect(useAppStore.getState().route).toBe('debug');
    expect(screen.queryByRole('navigation', { name: 'navigation' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Hierarchy' })).toBeTruthy();
    expect(screen.getByText('seq 10')).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'back to the panel' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('navigation', { name: 'navigation' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Ops console' }));
    expect(window.location.pathname).toBe('/debug');
    expect(screen.getByRole('tab', { name: 'Hierarchy' })).toBeTruthy();
  });

  it('badges blocked-on-user items and sorts them first', async () => {
    await open('/');
    const rows = (section: 'Projects' | 'Asteroids') => {
      const lists = within(nav()).getAllByRole('list');
      const list = section === 'Projects' ? lists[0]! : lists.at(-1)!;
      return Array.from(list.querySelectorAll(':scope > li')).map((li) => ({
        label: li.getAttribute('aria-label'),
        badge: li.querySelector('.pnl-row-line .pnl-beacon')?.textContent ?? null,
      }));
    };
    expect(rows('Projects')).toEqual([
      { label: 'project Billing export', badge: 'blocked on you' },
      { label: 'project Auth refactor', badge: null },
    ]);
    expect(rows('Asteroids')).toEqual([
      { label: 'task Fix the flaky date test', badge: 'blocked on you' },
      { label: 'task Bump the lint rules', badge: null },
    ]);
  });

  it('counts the same "waiting for you" in the top bar and the inbox header', async () => {
    await open('/', {
      ...(snapshot as Extract<ServerMessage, { type: 'snapshot' }>),
      questions: [
        { ...fx.question, id: 'q-user', holder: { type: 'user' } },
        // Held by a supervisor: not waiting for the user.
        { ...fx.question, id: 'q-wk' },
      ],
      proposals: [fx.proposal, { ...fx.proposal, id: 'pr-2', state: 'rejected' }],
    });
    const top = screen.getByLabelText('summary');
    const inbox = screen.getByRole('region', { name: 'question inbox' });
    expect(within(top).getByText('2 waiting for you')).toBeTruthy();
    expect(within(inbox).getByText('2 waiting for you')).toBeTruthy();
  });
});
