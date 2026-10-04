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

const main = () => within(screen.getByRole('main'));
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

  it('shows with the cards shown too; the Harmonizer gets its own controls, not this strip', async () => {
    localStorage.setItem(MANAGED_AGENTS_VISIBLE_KEY, '1');
    await open('/waykeeper/a-waykeeper-1');
    expect(screen.getByRole('region', { name: 'managed agents' })).toBeTruthy();
    expect(strip(WAYKEEPER).getByRole('button', { name: 'Pause the project' })).toBeTruthy();

    cleanup();
    await open('/');
    // P5-06 (decision 82) replaced P4-09's "no controls for the Harmonizer": pause / resume and
    // a confirmed restart; no work actions, no plain Stop, no More menu.
    const hq = strip('Harmonizer');
    expect(hq.getByRole('button', { name: 'Pause the Harmonizer' })).toBeTruthy();
    expect(hq.getByRole('button', { name: 'Restart Harmonizer' })).toBeTruthy();
    expect(hq.queryByRole('button', { name: /stop/i })).toBeNull();
    expect(hq.queryByRole('button', { name: 'More' })).toBeNull();
    expect(main().getAllByRole('group', { name: /^controls of/ })).toHaveLength(1);
  });
});

describe('the Harmonizer’s controls in its dock bar (P5-06, decision 82)', () => {
  const HQ = 'Harmonizer';
  const posted = (suffix: string) =>
    vi
      .mocked(fetch)
      .mock.calls.filter(([url, init]) => String(url).endsWith(suffix) && init?.method === 'POST');
  const withHq = (state: AgentState) => {
    const snap = snapshot() as Extract<ServerMessage, { type: 'snapshot' }>;
    return {
      ...snap,
      statuses: snap.statuses.map((s) =>
        s.agentId === 'a-harmonizer' ? status(s.agentId, state) : s,
      ),
    };
  };

  it('pauses and resumes the Harmonizer like any agent', async () => {
    await open('/');
    fireEvent.click(strip(HQ).getByRole('button', { name: 'Pause the Harmonizer' }));
    await vi.waitFor(() =>
      expect(controls).toEqual([
        { target: { kind: 'agent', id: 'a-harmonizer' }, action: { action: 'pause' } },
      ]),
    );
    cleanup();
    await open('/', withHq('paused'));
    expect(strip(HQ).queryByRole('button', { name: 'Pause the Harmonizer' })).toBeNull();
    fireEvent.click(strip(HQ).getByRole('button', { name: 'Resume the Harmonizer' }));
    await vi.waitFor(() =>
      expect(controls[1]).toEqual({
        target: { kind: 'agent', id: 'a-harmonizer' },
        action: { action: 'resume' },
      }),
    );
    expect(strip(HQ).queryByRole('button', { name: 'Resume session' })).toBeNull();
  });

  it('offers "Resume session" only for an interrupted Harmonizer', async () => {
    await open('/', withHq('interrupted'));
    expect(strip(HQ).queryByRole('button', { name: /^(Pause|Resume) the Harmonizer$/ })).toBeNull();
    fireEvent.click(strip(HQ).getByRole('button', { name: 'Resume session' }));
    await vi.waitFor(() => expect(posted('/api/agents/a-harmonizer/recover')).toHaveLength(1));
    // Restart stays offered: the user is never left without a Harmonizer.
    expect(strip(HQ).getByRole('button', { name: 'Restart Harmonizer' })).toBeTruthy();
  });

  it('asks before restarting, starting on Keep; Escape and Keep do nothing', async () => {
    await open('/');
    const button = strip(HQ).getByRole('button', { name: 'Restart Harmonizer' });
    fireEvent.click(button);
    const confirm = within(main().getByRole('group', { name: 'confirm' }));
    expect(
      confirm.getByText(/Restart the Harmonizer\? It is stopped and a fresh one starts/),
    ).toBeTruthy();
    expect(document.activeElement).toBe(confirm.getByRole('button', { name: 'Keep' }));
    fireEvent.keyDown(confirm.getByRole('button', { name: 'Keep' }), { key: 'Escape' });
    expect(main().queryByRole('group', { name: 'confirm' })).toBeNull();
    // Escape keeps, and focus goes back to the button that opened the question.
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);
    fireEvent.click(main().getByRole('button', { name: 'Keep' }));
    expect(main().queryByRole('group', { name: 'confirm' })).toBeNull();
    expect(posted('/api/harmonizer/restart')).toHaveLength(0);

    fireEvent.click(button);
    fireEvent.click(main().getByRole('button', { name: 'Yes, restart' }));
    await vi.waitFor(() => expect(posted('/api/harmonizer/restart')).toHaveLength(1));
    expect(controls).toEqual([]);
  });

  it('keeps focus across a restart: the dock bar’s heading, then the new one’s Restart', async () => {
    await open('/');
    fireEvent.click(strip(HQ).getByRole('button', { name: 'Restart Harmonizer' }));
    fireEvent.click(main().getByRole('button', { name: 'Yes, restart' }));
    // While it runs the Restart button is disabled: focus waits on the heading, never on <body>.
    expect(document.activeElement).toBe(main().getByRole('heading', { level: 1 }));
    await vi.waitFor(() => expect(posted('/api/harmonizer/restart')).toHaveLength(1));

    // The stream brings the new Harmonizer: its controls mount and take focus on Restart.
    const before = snapshot() as Extract<ServerMessage, { type: 'snapshot' }>;
    const old = before.agents.find((a) => a.id === 'a-harmonizer')!;
    const fresh = { ...old, id: 'a-harmonizer-2', createdAt: '2999-01-01T00:00:00.000Z' };
    const socket = FakeWebSocket.instances.at(-1)!;
    await act(async () =>
      socket.serverSends({
        ...before,
        seq: 20,
        agents: [...before.agents, fresh],
        statuses: [
          ...before.statuses.map((r) =>
            r.agentId === 'a-harmonizer' ? { ...r, state: 'stopped' as const } : r,
          ),
          status(fresh.id),
        ],
      }),
    );
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        strip(HQ).getByRole('button', { name: 'Restart Harmonizer' }),
      ),
    );
    expect(strip(HQ).getByRole('button', { name: 'Pause the Harmonizer' })).toBeTruthy();
  });

  it('a restart that fails gives focus back to Restart, with the reason', async () => {
    const fetchMock = vi.mocked(fetch);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url, init) =>
      String(url).endsWith('/api/harmonizer/restart')
        ? new Response(JSON.stringify({ error: 'refused', message: 'try again in 4 min' }), {
            status: 429,
          })
        : base(url, init),
    );
    await open('/');
    const button = strip(HQ).getByRole('button', { name: 'Restart Harmonizer' });
    fireEvent.click(button);
    fireEvent.click(main().getByRole('button', { name: 'Yes, restart' }));
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
    expect(
      main()
        .getAllByRole('alert')
        .some((a) => /try again in 4 min/.test(a.textContent ?? '')),
    ).toBe(true);
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

describe('where the "More" menu opens (P4-10)', () => {
  const menu = () => main().getByRole('group', { name: 'more controls' });
  /** Fakes the layout jsdom does not have: the strip's row and the menu's boxes. */
  function boxes(row: Partial<DOMRect>, menuHeight: number) {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('ctl-row'))
        return { left: 600, right: 1000, width: 400, ...row } as DOMRect;
      if (this.classList.contains('ctl-menu'))
        return {
          top: 0,
          bottom: menuHeight,
          height: menuHeight,
          left: 700,
          right: 1000,
        } as DOMRect;
      return original.call(this);
    });
  }
  afterEach(() => vi.restoreAllMocks());

  it('opens downwards in list mode, where the bar is at the top of the centre', async () => {
    await open('/waykeeper/a-waykeeper-1');
    expect(document.querySelector('.pnl-grid-scene')).toBeNull(); // list mode
    boxes({ top: 60, bottom: 90, height: 30 }, 160);
    const more = strip(WAYKEEPER).getByRole('button', { name: 'More' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(menu().dataset['placement']).toBe('below');
    // Capped to the room below it (jsdom's window is 768 px tall), less the margin.
    expect(menu().style.maxHeight).toBe(`${768 - 90 - 8}px`);
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens upwards when the bar is low on the screen and there is more room above', async () => {
    await open('/waykeeper/a-waykeeper-1');
    boxes({ top: 700, bottom: 740, height: 40 }, 160);
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'More' }));
    expect(menu().dataset['placement']).toBe('above');
    expect(menu().style.maxHeight).toBe(`${700 - 8}px`);
  });

  it('stays below when it fits there, even low-ish on the screen', async () => {
    await open('/waykeeper/a-waykeeper-1');
    boxes({ top: 500, bottom: 530, height: 30 }, 160);
    fireEvent.click(strip(WAYKEEPER).getByRole('button', { name: 'More' }));
    expect(menu().dataset['placement']).toBe('below');
  });
});
