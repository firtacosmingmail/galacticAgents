// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Project, ServerMessage, StatusRecord, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { emptyWorld, type WorldState } from '../state/reduce.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY } from './use-media-query.js';
import { MANAGED_AGENTS_VISIBLE_KEY } from './managed-agents-visibility.js';
import { INBOX_VISIBLE_KEY } from './inbox-visibility.js';
import { revealQuestion, REVEALED_CLASS } from './inbox-reveal.js';
import { SHOW_CLOSED_KEY } from './Navigation.js';
import { buildNav } from './nav-model.js';
import { openTasksNote } from './nav-row-actions.js';

/*
 * P4-12: the inbox hides and comes back like the managed agents (the side column goes when both
 * are hidden); closed work leaves the navigation behind "Show closed"; a navigation row's "⋯"
 * offers the work actions, so leftover projects can be closed, cancelled and archived from there.
 */

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const status = (agentId: string, state: StatusRecord['state'] = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});

/** Two closed projects (csv2parquet with a closed task, tally archived), a demo project. */
const csv: Project = { ...fx.project, id: 'p-csv', name: 'csv2parquet', state: 'completed' };
const tally: Project = { ...fx.project, id: 'p-tally', name: 'tally', state: 'archived' };
const demo: Project = { ...fx.project, id: 'p-demo', name: 'Demo project 1', state: 'in_progress' };
const csvTask: Task = {
  ...fx.task,
  id: 't-csv',
  projectId: 'p-csv',
  description: 'Write the converter',
  state: 'completed',
};
const demoTask: Task = {
  ...fx.task,
  id: 't-demo',
  projectId: 'p-demo',
  description: 'Demo task',
  state: 'in_progress',
};
const doneAsteroid: Task = {
  ...fx.asteroidTask,
  id: 't-done',
  description: 'Bump a dependency',
  state: 'completed',
};
const csvSteward: Agent = { ...fx.agent, id: 'a-steward-csv', taskId: 't-csv' };
const csvWaykeeper: Agent = { ...waykeeper, id: 'a-waykeeper-csv', projectId: 'p-csv' };

const snapshot: Extract<ServerMessage, { type: 'snapshot' }> = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, fx.agent, csvWaykeeper, csvSteward],
  bodies: [fx.body, fx.moon, fx.asteroid],
  projects: [fx.project, csv, tally, demo],
  tasks: [fx.task, fx.asteroidTask, csvTask, demoTask, doneAsteroid],
  questions: [{ ...fx.question, id: 'q-user', holder: { type: 'user' } }],
  proposals: [],
  statuses: [
    status('a-harmonizer'),
    status('a-waykeeper-1'),
    status('a-steward-1'),
    status('a-waykeeper-csv', 'stopped'),
    status('a-steward-csv', 'finished'),
  ],
};

function worldOf(snap = snapshot): WorldState {
  const by = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
  return {
    ...emptyWorld(),
    agents: by(snap.agents),
    projects: by(snap.projects),
    tasks: by(snap.tasks),
    statuses: Object.fromEntries(snap.statuses.map((s) => [s.agentId, s])),
  };
}

/** The bodies posted to `/api/control`; `refuse` makes the next one a 409. */
let controls: unknown[];
let refuse: string | undefined;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  controls = [];
  refuse = undefined;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/control')) {
        controls.push(JSON.parse(String(init?.body)));
        if (refuse) {
          const message = refuse;
          refuse = undefined;
          return new Response(JSON.stringify({ error: 'conflict', message }), { status: 409 });
        }
        return new Response(JSON.stringify({ ok: true }));
      }
      return url.endsWith('/messages')
        ? new Response(JSON.stringify({ messages: [] }))
        : new Response('{}');
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(path = '/', initial: ServerMessage = snapshot) {
  FakeWebSocket.instances = [];
  useAppStore.getState().reset();
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(initial);
  });
}

async function reload(path = '/') {
  cleanup();
  await open(path);
}

const grid = () => document.querySelector('.pnl-grid')!;
const top = () => document.querySelector<HTMLElement>('header.pnl-top')!;
const nav = () => screen.getByRole('navigation', { name: 'navigation' });
const inbox = () => screen.queryByRole('region', { name: 'question inbox' });
const managed = () => screen.queryByRole('region', { name: 'managed agents' });
const side = () => document.querySelector('aside.pnl-side');
const row = (kind: 'project' | 'task', name: string) =>
  within(nav()).queryByRole('listitem', { name: `${kind} ${name}` });

describe('hidable inbox (P4-12)', () => {
  it('hides from its header, keeps the managed agents and the waiting count, reflows the grid', async () => {
    await open('/');
    expect(inbox()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show inbox' })).toBeNull();

    fireEvent.click(within(inbox()!).getByRole('button', { name: 'Hide inbox' }));
    expect(inbox()).toBeNull();
    expect(localStorage.getItem(INBOX_VISIBLE_KEY)).toBe('0');
    expect(managed()).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'managed agents column' })).toBeTruthy();
    expect(grid().classList.contains('pnl-grid-no-inbox')).toBe(true);
    // "N waiting for you" stays in the top bar, and the bar offers the way back.
    expect(within(top()).getByRole('button', { name: '1 waiting for you' })).toBeTruthy();
    expect(within(top()).getByRole('button', { name: 'Show inbox' })).toBeTruthy();
  });

  it('drops the side column when the managed agents are hidden too, and stays so after a reload', async () => {
    await open('/');
    fireEvent.click(screen.getByRole('button', { name: 'Hide inbox' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide managed agents' }));
    expect(side()).toBeNull();
    expect(grid().classList.contains('pnl-grid-no-side')).toBe(true);
    expect(grid().classList.contains('pnl-grid-no-agents')).toBe(false);
    expect(grid().classList.contains('pnl-grid-no-inbox')).toBe(false);
    expect(localStorage.getItem(MANAGED_AGENTS_VISIBLE_KEY)).toBe('0');

    await reload('/');
    expect(side()).toBeNull();
    expect(grid().classList.contains('pnl-grid-no-side')).toBe(true);

    fireEvent.click(within(top()).getByRole('button', { name: 'Show inbox' }));
    expect(inbox()).toBeTruthy();
    expect(managed()).toBeNull();
    expect(screen.getByRole('complementary', { name: 'inbox column' })).toBeTruthy();
    expect(localStorage.getItem(INBOX_VISIBLE_KEY)).toBe('1');
    expect(within(top()).queryByRole('button', { name: 'Show inbox' })).toBeNull();
  });

  it('comes back when the waiting count is clicked, focused', async () => {
    localStorage.setItem(INBOX_VISIBLE_KEY, '0');
    await open('/');
    expect(inbox()).toBeNull();
    fireEvent.click(within(top()).getByRole('button', { name: '1 waiting for you' }));
    expect(inbox()).toBeTruthy();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('region', { name: 'inbox' })),
    );
    expect(localStorage.getItem(INBOX_VISIBLE_KEY)).toBe('1');
  });

  it('comes back when a question is revealed (a beacon), with the card focused', async () => {
    localStorage.setItem(INBOX_VISIBLE_KEY, '0');
    localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, '0');
    await open('/');
    expect(side()).toBeNull();
    act(() => void revealQuestion('q-user'));
    expect(inbox()).toBeTruthy();
    await vi.waitFor(() => {
      const card = document.activeElement as HTMLElement;
      expect(card.dataset['questionId']).toBe('q-user');
      expect(card.classList.contains(REVEALED_CLASS)).toBe(true);
    });
  });

  it('is not hidden or shown from the phone menu: the bar opens it full screen (P8-18)', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COMPACT_TOP_BAR_QUERY || query === STACKED_LAYOUT_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await open('/');
    const menuButton = () => screen.getByRole('button', { name: 'Menu' });
    const menu = () => document.getElementById('pnl-top-menu')!;
    fireEvent.click(menuButton());
    expect(within(menu()).queryByRole('button', { name: /inbox/i })).toBeNull();
    expect(within(top()).getByRole('button', { name: 'Inbox, 1 waiting' })).toBeTruthy();
  });

  it('survives a browser without storage', async () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === INBOX_VISIBLE_KEY) throw new Error('denied');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === INBOX_VISIBLE_KEY) throw new Error('denied');
      setItem.call(this, key, value);
    };
    try {
      await open('/');
      expect(inbox()).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Hide inbox' }));
      expect(inbox()).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show inbox' }));
      expect(inbox()).toBeTruthy();
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });
});

describe('closed work in the navigation (P4-12)', () => {
  it('leaves completed and archived work out unless closed work is shown', () => {
    const world = worldOf();
    const names = (items: { label: string }[]) => items.map((i) => i.label);
    const hidden = buildNav(world);
    expect(names(hidden.projects)).toEqual(['Auth refactor', 'Demo project 1']);
    expect(names(hidden.asteroids)).toEqual(['Fix the flaky date test']);
    // csv2parquet (its task with it), tally, the done asteroid.
    expect(hidden.hiddenClosed).toBe(3);

    const shown = buildNav(world, { showClosed: true });
    expect(names(shown.projects)).toEqual([
      'Auth refactor',
      'Demo project 1',
      'csv2parquet',
      'tally',
    ]);
    expect(shown.projects.find((p) => p.label === 'csv2parquet')?.closed).toBe(true);
    expect(shown.projects.find((p) => p.label === 'csv2parquet')?.children[0]?.closed).toBe(true);
    expect(names(shown.asteroids)).toEqual(['Fix the flaky date test', 'Bump a dependency']);
    expect(shown.hiddenClosed).toBe(0);
  });

  it('keeps the selected closed work listed, with the path to it', () => {
    const world = worldOf();
    const nav = buildNav(world, { selectedAgent: 'a-steward-csv' });
    const csvItem = nav.projects.find((p) => p.label === 'csv2parquet');
    expect(csvItem?.children.map((c) => c.label)).toEqual(['Write the converter']);
    expect(nav.projects.find((p) => p.label === 'tally')).toBeUndefined();
    expect(buildNav(world, { selectedAgent: 'a-waykeeper-csv' }).projects).toHaveLength(3);
  });

  it('a "Show closed" toggle at the bottom brings them back, dimmed, remembered per browser', async () => {
    await open('/');
    expect(row('project', 'csv2parquet')).toBeNull();
    expect(row('project', 'tally')).toBeNull();
    expect(row('task', 'Bump a dependency')).toBeNull();
    expect(row('project', 'Demo project 1')).toBeTruthy();
    const toggle = within(nav()).getByRole('checkbox', { name: /Show closed/ });
    expect(toggle.closest('label')?.textContent).toContain('(3 hidden)');

    fireEvent.click(toggle);
    expect(localStorage.getItem(SHOW_CLOSED_KEY)).toBe('1');
    expect(row('project', 'csv2parquet')?.classList.contains('is-closed')).toBe(true);
    expect(row('project', 'tally')?.classList.contains('is-closed')).toBe(true);
    expect(row('task', 'Bump a dependency')?.classList.contains('is-closed')).toBe(true);
    expect(row('project', 'Demo project 1')?.classList.contains('is-closed')).toBe(false);

    await reload('/');
    expect(row('project', 'csv2parquet')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('checkbox', { name: /Show closed/ }));
    expect(row('project', 'csv2parquet')).toBeNull();
    expect(localStorage.getItem(SHOW_CLOSED_KEY)).toBe('0');
  });

  it('a deep link to closed work still shows it in the navigation', async () => {
    await open('/steward/a-steward-csv');
    const project = row('project', 'csv2parquet')!;
    expect(project).toBeTruthy();
    const link = within(project).getByRole('link', { name: /Write the converter/ });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(row('project', 'tally')).toBeNull();
  });
});

describe('work actions on a navigation row (P4-12)', () => {
  const actions = (name: string) => within(row('project', name)!);

  it('closes a project from its row, after the confirmation', async () => {
    await open('/');
    fireEvent.click(
      actions('Demo project 1').getByRole('button', { name: 'Actions for Demo project 1' }),
    );
    const group = within(
      actions('Demo project 1').getByRole('group', { name: 'actions for Demo project 1' }),
    );
    // No edit here (the strip and the cards have it); the rest of the strip's project actions.
    expect(group.queryByRole('button', { name: 'Edit' })).toBeNull();
    fireEvent.click(group.getByRole('button', { name: 'Close' }));
    expect(controls).toEqual([]);
    expect(group.getByText(/Close the project now\?/)).toBeTruthy();
    fireEvent.click(group.getByRole('button', { name: 'Yes, close' }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        { target: { kind: 'project', id: 'p-demo' }, action: { action: 'close' } },
      ]),
    );
  });

  it('says what keeps a project with open tasks from being archived', async () => {
    await open('/');
    fireEvent.click(
      actions('Demo project 1').getByRole('button', { name: 'Actions for Demo project 1' }),
    );
    expect(
      actions('Demo project 1').getByText(
        '1 unfinished task: Cancel marks them failed so the project can then be archived; Close leaves them open.',
      ),
    ).toBeTruthy();
    const world = worldOf();
    expect(openTasksNote(world, { ...demo, state: 'completed' })).toBe(
      '1 unfinished task keep this project from being archived: cancel or close them first.',
    );
    expect(openTasksNote(world, csv)).toBeUndefined();
  });

  it('cancels, then archives a cancelled project; shows the server’s refusal', async () => {
    const failed: Project = { ...demo, state: 'failed' };
    await open('/', {
      ...snapshot,
      projects: [fx.project, csv, tally, failed],
      tasks: [fx.task, fx.asteroidTask, { ...demoTask, state: 'failed' }],
    });
    fireEvent.click(
      actions('Demo project 1').getByRole('button', { name: 'Actions for Demo project 1' }),
    );
    const group = () =>
      within(actions('Demo project 1').getByRole('group', { name: 'actions for Demo project 1' }));
    expect(group().queryByRole('button', { name: 'Close' })).toBeNull();
    refuse = 'project p-demo has 1 unfinished task(s)';
    fireEvent.click(group().getByRole('button', { name: 'Archive now' }));
    fireEvent.click(group().getByRole('button', { name: 'Yes, archive now' }));
    expect(await group().findByText('project p-demo has 1 unfinished task(s)')).toBeTruthy();
    fireEvent.click(group().getByRole('button', { name: 'Archive now' }));
    fireEvent.click(group().getByRole('button', { name: 'Yes, archive now' }));
    await vi.waitFor(() => expect(controls).toHaveLength(2));
    expect(controls).toEqual([
      { target: { kind: 'project', id: 'p-demo' }, action: { action: 'archive' } },
      { target: { kind: 'project', id: 'p-demo' }, action: { action: 'archive' } },
    ]);
  });

  it('cancels a task from its row; Escape closes the actions and returns focus', async () => {
    await open('/');
    const asteroid = within(row('task', 'Fix the flaky date test')!);
    const more = asteroid.getByRole('button', { name: 'Actions for Fix the flaky date test' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const group = asteroid.getByRole('group', { name: 'actions for Fix the flaky date test' });
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Yes, cancel' }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        { target: { kind: 'task', id: 't-2' }, action: { action: 'cancel' } },
      ]),
    );
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(
      asteroid.queryByRole('group', { name: 'actions for Fix the flaky date test' }),
    ).toBeNull();
    expect(document.activeElement).toBe(more);
  });
});
