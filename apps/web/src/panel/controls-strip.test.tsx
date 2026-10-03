// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  AgentState,
  Project,
  ServerMessage,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { MANAGED_AGENTS_VISIBLE_KEY } from './managed-agents-visibility.js';

/*
 * P4-09: the main area's controls strip keeps a Waykeeper's project and agent controls, and a
 * Steward's task controls, reachable whether or not the managed-agents cards are shown.
 */

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const steward: Agent = {
  ...fx.agent,
  id: 'a-steward-1',
  taskId: 't-1',
  supervisorId: waykeeper.id,
};
const status = (agentId: string, state: AgentState = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});

function snapshot(
  w: { project?: Partial<Project>; task?: Partial<Task>; waykeeperState?: AgentState } = {},
): ServerMessage {
  return {
    type: 'snapshot',
    logId: 'log-a',
    seq: 10,
    agents: [fx.harmonizer, waykeeper, steward],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [{ ...fx.project, ...w.project }],
    tasks: [{ ...fx.task, ...w.task }],
    questions: [],
    proposals: [],
    statuses: [status('a-harmonizer'), status(waykeeper.id, w.waykeeperState), status(steward.id)],
  };
}

/** The bodies posted to `/api/control`; `refuse` makes the next one a 409. */
let controls: unknown[];
let refuse: string | undefined;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  // The cards are hidden: the strip is the only panel surface left for these controls.
  localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, '0');
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
          return new Response(JSON.stringify({ error: 'rejected', message }), { status: 409 });
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

async function open(path: string, initial: ServerMessage = snapshot()) {
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

const main = () => within(screen.getByRole('main', { name: 'main area' }));
const strip = (name: string) => within(main().getByRole('group', { name: `controls of ${name}` }));
const more = () => within(main().getByRole('group', { name: 'more controls' }));
/** Waits for the strip's last action to settle (its buttons are disabled while one runs). */
const settled = (name: string) =>
  vi.waitFor(() =>
    expect(
      main()
        .getByRole('group', { name: `controls of ${name}` })
        .querySelector('button:disabled'),
    ).toBeNull(),
  );
const WAYKEEPER = 'Waykeeper · Auth refactor';
const STEWARD = 'Steward · Replace the session middleware';

describe('controls strip in a Waykeeper’s conversation (P4-09)', () => {
  it('offers the project’s and the Waykeeper’s controls with the cards hidden', async () => {
    await open('/waykeeper/a-waykeeper-1');
    expect(screen.queryByRole('region', { name: 'managed agents' })).toBeNull();

    // Pause / resume inline, one per target.
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'Pause the project' }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        { target: { kind: 'project', id: 'p-1' }, action: { action: 'pause' } },
      ]),
    );
    await settled(WAYKEEPER);
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'Pause the agent' }));
    await vi.waitFor(() =>
      expect(controls[1]).toEqual({
        target: { kind: 'agent', id: 'a-waykeeper-1' },
        action: { action: 'pause' },
      }),
    );
    await settled(WAYKEEPER);

    // The rest sits in "More", grouped by target.
    const toggle = strip(WAYKEEPER).getByRole('button', { name: 'More' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const project = within(more().getByRole('group', { name: 'project controls' }));
    for (const name of ['Stop', 'Cancel', 'Close', 'Pin', 'Edit'])
      expect(project.getByRole('button', { name })).toBeTruthy();
    const agent = within(more().getByRole('group', { name: 'agent controls' }));
    expect(agent.getByRole('button', { name: 'Stop' })).toBeTruthy();

    // Pin goes straight out and closes the menu.
    fireEvent.click(project.getByRole('button', { name: 'Pin' }));
    expect(main().queryByRole('group', { name: 'more controls' })).toBeNull();
    await vi.waitFor(() =>
      expect(controls[2]).toEqual({
        target: { kind: 'project', id: 'p-1' },
        action: { action: 'pin', pinned: true },
      }),
    );
  });

  it('asks before the destructive ones, as the cards do, and Keep sends nothing', async () => {
    await open('/waykeeper/a-waykeeper-1');
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'More' }));
    fireEvent.click(
      within(more().getByRole('group', { name: 'project controls' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    const confirm = within(main().getByRole('group', { name: 'confirm' }));
    expect(
      confirm.getByText('Cancel the project? Its agents are stopped and it is marked failed.'),
    ).toBeTruthy();
    fireEvent.click(confirm.getByRole('button', { name: 'Keep' }));
    expect(main().queryByRole('group', { name: 'confirm' })).toBeNull();
    expect(controls).toEqual([]);

    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'More' }));
    fireEvent.click(
      within(more().getByRole('group', { name: 'agent controls' })).getByRole('button', {
        name: 'Stop',
      }),
    );
    fireEvent.click(main().getByRole('button', { name: 'Yes, stop' }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        { target: { kind: 'agent', id: 'a-waykeeper-1' }, action: { action: 'stop' } },
      ]),
    );
  });

  it('shows a refusal inline', async () => {
    await open('/waykeeper/a-waykeeper-1', snapshot({ project: { state: 'failed' } }));
    refuse = 'project p-1 cannot be archived while agents run';
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'More' }));
    fireEvent.click(more().getByRole('button', { name: 'Archive now' }));
    fireEvent.click(main().getByRole('button', { name: 'Yes, archive now' }));
    const alert = await main().findByText('project p-1 cannot be archived while agents run');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.closest('.ctl')).toBeTruthy();
  });

  it('opens the edit form for the project', async () => {
    await open('/waykeeper/a-waykeeper-1');
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'More' }));
    fireEvent.click(more().getByRole('button', { name: 'Edit' }));
    expect(main().getByDisplayValue('Auth refactor')).toBeTruthy();
  });

  it('offers Resume and Resume session for a paused project and an interrupted Waykeeper', async () => {
    await open(
      '/waykeeper/a-waykeeper-1',
      snapshot({ project: { state: 'paused' }, waykeeperState: 'interrupted' }),
    );
    expect(strip(WAYKEEPER).getByRole('button', { name: 'Resume the project' })).toBeTruthy();
    expect(strip(WAYKEEPER).getByRole('button', { name: 'Resume session' })).toBeTruthy();
    // An ended agent takes no pause or stop.
    expect(strip(WAYKEEPER).queryByRole('button', { name: 'Pause the agent' })).toBeNull();
  });

  it('shows with the cards shown too, and not for the Harmonizer', async () => {
    localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, '1');
    await open('/waykeeper/a-waykeeper-1');
    expect(screen.getByRole('region', { name: 'managed agents' })).toBeTruthy();
    expect(strip(WAYKEEPER).getByRole('button', { name: 'Pause the project' })).toBeTruthy();

    cleanup();
    await open('/');
    expect(main().queryByRole('group', { name: /^controls of/ })).toBeNull();
  });
});

describe('controls strip in a Steward’s view (P4-09)', () => {
  it('adds the task’s controls next to the agent’s, without repeating the agent’s', async () => {
    await open('/steward/a-steward-1');
    // The view's own agent controls stay as they were.
    const agentControls = within(main().getByRole('group', { name: 'controls' }));
    expect(agentControls.getByRole('button', { name: 'Pause' })).toBeTruthy();

    fireEvent.click(strip(STEWARD).getByRole('button', { name: 'Pause the task' }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        { target: { kind: 'task', id: 't-1' }, action: { action: 'pause' } },
      ]),
    );
    await settled(STEWARD);
    expect(strip(STEWARD).queryByRole('button', { name: 'Pause the agent' })).toBeNull();
    fireEvent.click(strip(STEWARD).getByRole('button', { name: 'More' }));
    expect(main().queryByRole('group', { name: 'agent controls' })).toBeNull();
    const task = within(more().getByRole('group', { name: 'task controls' }));
    fireEvent.click(task.getByRole('button', { name: 'Close' }));
    expect(main().getByText('Close the task now? Its agents are stopped.')).toBeTruthy();
    fireEvent.click(main().getByRole('button', { name: 'Yes, close' }));
    await vi.waitFor(() =>
      expect(controls[1]).toEqual({
        target: { kind: 'task', id: 't-1' },
        action: { action: 'close' },
      }),
    );
  });

  it('closes its menu on Escape', async () => {
    await open('/steward/a-steward-1');
    const toggle = strip(STEWARD).getByRole('button', { name: 'More' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(main().queryByRole('group', { name: 'more controls' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});
