// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Project, ServerMessage, StatusRecord, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { emptyWorld, type WorldState } from '../state/reduce.js';
import { COMPACT_TOP_BAR_QUERY } from './use-media-query.js';
import { MANAGED_AGENTS_VISIBLE_KEY } from './managed-agents-visibility.js';
import { buildNav, stewardCount } from './nav-model.js';

/*
 * P4-09: the managed-agents section hides (per browser) with the inbox kept, and a project's
 * navigation row stays compact when its Waykeeper is selected while showing its Steward count.
 */

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const subWaykeeper: Agent = {
  ...waykeeper,
  id: 'a-waykeeper-3',
  projectId: 'p-3',
  supervisorId: 'a-waykeeper-1',
};
/** p-3 is a sub-project of p-1: its tasks count on its own row. */
const subProject: Project = {
  ...fx.project,
  id: 'p-3',
  name: 'Token store',
  parentProjectId: 'p-1',
};
const secondTask: Task = { ...fx.task, id: 't-4', description: 'Rotate the signing keys' };
const archivedTask: Task = { ...fx.task, id: 't-6', description: 'Old spike', state: 'archived' };
const subTask: Task = { ...fx.task, id: 't-5', projectId: 'p-3', description: 'Add a store' };
const steward = (id: string, taskId: string, supervisorId = 'a-waykeeper-1'): Agent => ({
  ...fx.agent,
  id,
  taskId,
  supervisorId,
});
const stewards = [
  steward('a-steward-1', 't-1'), // working
  steward('a-steward-4', 't-4'), // working
  steward('a-steward-9', 't-4'), // an earlier Steward on t-4, finished
  steward('a-steward-6', 't-6'), // on an archived task: counted only with archived work shown
  steward('a-steward-5', 't-5', 'a-waykeeper-3'), // the sub-project's
  steward('a-steward-2', 't-2', 'a-harmonizer'), // an asteroid's
];
const status = (agentId: string, state: StatusRecord['state'] = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});
const statuses = [
  status('a-harmonizer'),
  status('a-waykeeper-1'),
  status('a-waykeeper-3'),
  status('a-steward-1'),
  status('a-steward-4'),
  status('a-steward-9', 'finished'),
  status('a-steward-6', 'stopped'),
  status('a-steward-5'),
  status('a-steward-2'),
];

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, subWaykeeper, ...stewards],
  bodies: [fx.body, fx.moon, fx.asteroid],
  projects: [fx.project, subProject],
  tasks: [fx.task, fx.asteroidTask, secondTask, archivedTask, subTask],
  questions: [{ ...fx.question, id: 'q-user', holder: { type: 'user' } }],
  proposals: [],
  statuses,
};

function worldOf(): WorldState {
  const by = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));
  const snap = snapshot as Extract<ServerMessage, { type: 'snapshot' }>;
  return {
    ...emptyWorld(),
    agents: by(snap.agents),
    projects: by(snap.projects),
    tasks: by(snap.tasks),
    statuses: Object.fromEntries(snap.statuses.map((s) => [s.agentId, s])),
  };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
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

/** Renders the app at a URL, as a fresh page load, and feeds it the snapshot. */
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

/** A reload: the page goes away and comes back with the same localStorage. */
async function reload(path = '/') {
  cleanup();
  await open(path);
}

const grid = () => document.querySelector('.pnl-grid')!;
const nav = () => screen.getByRole('navigation', { name: 'navigation' });
const managed = () => screen.queryByRole('region', { name: 'managed agents' });
const inbox = () => screen.queryByRole('region', { name: 'question inbox' });
const projectRow = (name: string) =>
  within(nav()).getByRole('listitem', { name: `project ${name}` });

describe('hidable managed agents (P4-09)', () => {
  it('hides from the column header, keeps the inbox, and reflows the grid', async () => {
    await open('/');
    expect(managed()).toBeTruthy();
    expect(grid().classList.contains('pnl-grid-no-agents')).toBe(false);
    // The wide bar offers only the way back, so nothing shows there yet.
    expect(screen.queryByRole('button', { name: 'Show managed agents' })).toBeNull();

    fireEvent.click(within(managed()!).getByRole('button', { name: 'Hide managed agents' }));
    expect(managed()).toBeNull();
    expect(screen.queryByText('Managed agents')).toBeNull();
    expect(grid().classList.contains('pnl-grid-no-agents')).toBe(true);
    expect(localStorage.getItem(MANAGED_AGENTS_VISIBLE_KEY)).toBe('0');
    // The inbox stays, with what waits for the user.
    expect(inbox()).toBeTruthy();
    expect(within(inbox()!).getByText('1 waiting for you')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'inbox column' })).toBeTruthy();
  });

  it('stays hidden after a reload, also for a Steward, until the top bar brings it back', async () => {
    await open('/');
    fireEvent.click(screen.getByRole('button', { name: 'Hide managed agents' }));

    await reload('/');
    expect(managed()).toBeNull();
    expect(inbox()).toBeTruthy();
    expect(grid().classList.contains('pnl-grid-no-agents')).toBe(true);

    // A Steward's "Reports to" lives in the same section: hidden too; its controls stay in its view.
    await reload('/steward/a-steward-1');
    expect(managed()).toBeNull();
    expect(screen.queryByText('Reports to')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show managed agents' }));
    expect(managed()).toBeTruthy();
    expect(grid().classList.contains('pnl-grid-no-agents')).toBe(false);
    expect(localStorage.getItem(MANAGED_AGENTS_VISIBLE_KEY)).toBe('1');
    expect(screen.queryByRole('button', { name: 'Show managed agents' })).toBeNull();

    await reload('/');
    expect(managed()).toBeTruthy();
  });

  it('can be hidden and shown again from the phone menu', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === COMPACT_TOP_BAR_QUERY,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await open('/');
    const menuButton = () => screen.getByRole('button', { name: 'Menu' });
    const menu = () => document.getElementById('pnl-top-menu')!;

    fireEvent.click(menuButton());
    fireEvent.click(within(menu()).getByRole('button', { name: 'Hide managed agents' }));
    expect(managed()).toBeNull();
    expect(menu().hidden).toBe(true); // the menu closes, as after the scene toggle
    expect(document.activeElement).toBe(menuButton());
    expect(inbox()).toBeTruthy();

    fireEvent.click(menuButton());
    fireEvent.click(within(menu()).getByRole('button', { name: 'Show managed agents' }));
    expect(managed()).toBeTruthy();
  });

  it('survives a browser without storage', async () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string) {
      if (key === MANAGED_AGENTS_VISIBLE_KEY) throw new Error('denied');
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === MANAGED_AGENTS_VISIBLE_KEY) throw new Error('denied');
      setItem.call(this, key, value);
    };
    try {
      await open('/');
      expect(managed()).toBeTruthy(); // shown by default
      fireEvent.click(screen.getByRole('button', { name: 'Hide managed agents' }));
      expect(managed()).toBeNull(); // for this page only
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });
});

describe('Steward counts (P4-09)', () => {
  it('counts the project’s own tasks with a Steward, sub-projects on their own row', () => {
    const world = worldOf();
    // t-1 and t-4 (respawned: two Stewards, counted once); t-6 is archived.
    expect(stewardCount(world, 'p-1')).toEqual({ active: 2, total: 2 });
    expect(stewardCount(world, 'p-1', { showArchived: true })).toEqual({ active: 2, total: 3 });
    expect(stewardCount(world, 'p-3')).toEqual({ active: 1, total: 1 });
    expect(stewardCount(world, 'p-unknown')).toEqual({ active: 0, total: 0 });

    const [auth] = buildNav(world).projects;
    expect(auth?.stewards).toEqual({ active: 2, total: 2 });
    expect(auth?.children.find((c) => c.kind === 'project')?.stewards).toEqual({
      active: 1,
      total: 1,
    });
    expect(auth?.children.find((c) => c.kind === 'task')?.stewards).toBeUndefined();
  });

  it('a respawned task is active by its newest live Steward, and counts once', () => {
    const world = worldOf();
    // Both t-4 Stewards live: still one task, one active.
    world.statuses['a-steward-9'] = status('a-steward-9');
    expect(stewardCount(world, 'p-1')).toEqual({ active: 2, total: 2 });
    // Both ended: the task still counts in the total, not as active.
    world.statuses['a-steward-4'] = status('a-steward-4', 'stopped');
    world.statuses['a-steward-9'] = status('a-steward-9', 'finished');
    expect(stewardCount(world, 'p-1')).toEqual({ active: 1, total: 2 });
  });

  it('paused is not active; waiting for the user is', () => {
    const world = worldOf();
    world.statuses['a-steward-1'] = status('a-steward-1', 'paused');
    world.statuses['a-steward-4'] = status('a-steward-4', 'waiting_for_input');
    expect(stewardCount(world, 'p-1')).toEqual({ active: 1, total: 2 });
  });

  it('a Steward without a status is not active', () => {
    const world = worldOf();
    delete world.statuses['a-steward-4'];
    expect(stewardCount(world, 'p-1')).toEqual({ active: 1, total: 2 });
  });
});

describe('compact project rows (P4-09)', () => {
  it('keeps the selected Waykeeper’s row collapsed and shows its Steward count', async () => {
    await open('/waykeeper/a-waykeeper-1');
    const row = projectRow('Auth refactor');
    const link = within(row).getAllByRole('link')[0]!;
    expect(link.getAttribute('aria-current')).toBe('page');
    // Compact: no nested tasks or sub-projects until opened.
    const toggle = within(row).getByRole('button', { name: 'Show the work in Auth refactor' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(row).queryByRole('link', { name: /Rotate the signing keys/ })).toBeNull();
    // The count, by task: visible "2 active, 2 in total", the Stewards named for screen readers.
    const badge = row.querySelector(':scope > .pnl-row-line .pnl-nav-stewards')!;
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe('2 active, 2 in total');
    expect(badge.getAttribute('title')).toBe('Stewards: 2 active, 2 in total');
    expect(link.textContent).toContain('Stewards: 2 active, 2 in total');

    // The expand toggle still works, both ways.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(row).getByRole('link', { name: /Rotate the signing keys/ })).toBeTruthy();
    const sub = projectRow('Token store');
    expect(within(sub).getByText('Stewards: 1 active, 1 in total')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Hide the work in Auth refactor' }));
    expect(within(row).queryByRole('link', { name: /Rotate the signing keys/ })).toBeNull();
  });

  it('still opens the path to selected work inside a project', async () => {
    await open('/steward/a-steward-5');
    const row = projectRow('Auth refactor');
    expect(
      within(row)
        .getByRole('button', { name: 'Hide the work in Auth refactor' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    const sub = projectRow('Token store');
    expect(
      within(sub)
        .getByRole('link', { name: /Add a store/ })
        .getAttribute('aria-current'),
    ).toBe('page');
  });

  it('shows no count on a project without Stewards', async () => {
    const snap = snapshot as Extract<ServerMessage, { type: 'snapshot' }>;
    await open('/', { ...snap, agents: [fx.harmonizer, waykeeper] });
    const row = projectRow('Auth refactor');
    expect(row.querySelector('.pnl-nav-stewards')).toBeNull();
  });
});
