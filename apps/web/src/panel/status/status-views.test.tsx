// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type Agent,
  type Question,
  type ServerMessage,
  type SettingsResponse,
  type StatusRecord,
  type Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { useConversationStore } from '../../state/conversation.js';
import { SettingsProvider } from '../settings/SettingsData.js';
import { App } from '../../App.js';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { SCENE_VISIBLE_KEY } from '../../scene/visibility.js';
import { DOCK_VIEW_KEY, readDockView, useDockView } from './dock-view.js';
import { ProjectStatusView, SystemStatusView, TaskStatusFacts } from './StatusViews.js';

/*
 * P5-02: the status views — the system (Harmonizer), a project (Waykeeper) and the task facts of
 * the Steward view — rendered from the store, blocked on you first and amber, every entry a link
 * that selects its agent; the dock's "Chat | Status" switch remembered per browser; and the one
 * LLM path, "Ask the Harmonizer", a plain chat message.
 */

vi.mock('../../scene/SolarScene.js', () => ({
  default: function StubScene() {
    return <div data-testid="solar-scene" />;
  },
}));
vi.mock('../../scene/webgl.js', () => ({ webglAvailable: () => true }));

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const blockedSteward: Agent = { ...fx.agent, id: 'a-blocked', taskId: 't-3' };
const blockedTask: Task = {
  ...fx.task,
  id: 't-3',
  description: 'Rotate the signing keys',
  state: 'blocked_on_user',
};
const userQuestion: Question = {
  ...fx.question,
  id: 'q-user',
  kind: 'permission',
  originAgentId: 'a-blocked',
  holder: { type: 'user' },
};
const st = (agentId: string, extra: Partial<StatusRecord> = {}): StatusRecord => ({
  ...fx.status,
  agentId,
  // a fresh session: its running wall clock is far from the cap
  startedAt: new Date().toISOString(),
  ...extra,
});

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, waykeeper, fx.agent, blockedSteward],
  bodies: [fx.body, fx.moon],
  projects: [fx.project],
  tasks: [fx.task, blockedTask],
  questions: [userQuestion, fx.question],
  proposals: [],
  statuses: [
    st('a-harmonizer', { state: 'idle', costSoFar: { usd: 1 } }),
    st('a-waykeeper-1'),
    st('a-steward-1', { state: 'stalled' }),
    st('a-blocked', { state: 'waiting_for_input' }),
  ],
};

const settings: SettingsResponse = {
  settings: {
    projectsRoot: '/Users/me/GalacticProjects',
    defaultPermissionPolicy: structuredClone(DEFAULT_PERMISSION_POLICY),
    retentionDays: 7,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
      maxWallClockMs: 7_200_000,
      maxToolCalls: 500,
    },
    qualityTier: 'high',
    stewardsLoadUserSettings: true,
  },
  envOverrides: [],
  restartRequired: [],
};

let send: ReturnType<typeof vi.fn>;
let api: Api;

function load() {
  useAppStore.getState().reset();
  useAppStore.getState().apply(snapshot);
}

function show(node: React.ReactNode) {
  return render(
    <ApiContext.Provider value={api}>
      <SettingsProvider api={api}>{node}</SettingsProvider>
    </ApiContext.Provider>,
  );
}

describe('the status views', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    useDockView.getState().reload();
    send = vi.fn(async () => ({ ok: true, messageId: 'm-1' }));
    api = { send, settings: vi.fn(async () => settings) } as unknown as Api;
    load();
  });
  afterEach(() => cleanup());

  it('shows the system: blocked on you first and amber, counts, cost and caps', async () => {
    show(<SystemStatusView />);
    const view = screen.getByRole('region', { name: 'system status' });
    expect(within(view).getByText('1 waiting for you')).toBeTruthy();
    const attention = within(view).getByRole('list', { name: 'needs attention' });
    const rows = within(attention).getAllByRole('listitem');
    // blocked task first (the beacon), then the stalled Steward
    expect(rows[0]!.className).toMatch(/tone-blocked/);
    expect(within(rows[0]!).getByText('blocked on you').className).toBe('pnl-beacon');
    expect(within(rows[0]!).getByRole('link', { name: 'Rotate the signing keys' })).toBeTruthy();
    expect(rows.at(-1)!.className).toMatch(/tone-stalled/);
    // tasks by state: blocked on you leads, as an amber chip
    const tasks = within(view).getByRole('list', { name: 'tasks by state' });
    expect(within(tasks).getAllByRole('listitem')[0]!.textContent).toBe('1 blocked on you');
    expect(within(tasks).getAllByRole('listitem')[0]!.className).toMatch(/is-blocked/);
    // questions by kind and holder
    expect(within(view).getByText(/2 open: 1 permission, 1 clarification/)).toBeTruthy();
    // cost: $1 + 3 × $0.42
    expect(within(view).getAllByText('$2.26').length).toBeGreaterThan(0);
    // caps from the settings: live Stewards against the concurrency cap
    expect(await within(view).findByText('2 / 4')).toBeTruthy();
  });

  it('words the costs and the caps without overclaiming (wave-1 review)', async () => {
    show(<SystemStatusView />);
    const view = screen.getByRole('region', { name: 'system status' });
    expect(within(view).getByText('agents active today (lifetime cost)')).toBeTruthy();
    expect(within(view).queryByText('active today')).toBeNull();
    expect(within(view).getByText(/live, or ended in the\s+last 24 h/)).toBeTruthy();
    const spawns = within(view).getByText('spawns in the last hour').closest('dt')!;
    expect(spawns.title).toMatch(/in-memory window/);
    cleanup();
    show(<ProjectStatusView projectId="p-1" />);
    const project = screen.getByRole('region', { name: 'status of Auth refactor' });
    expect(within(project).getByText(/ended in the last 24 h/)).toBeTruthy();
    const cap = within(project).getByText('live Stewards (Waykeeper cap)').closest('dt')!;
    expect(cap.title).toMatch(/by supervisor/);
    cleanup();
    show(<TaskStatusFacts agentId="a-steward-1" />);
    expect(screen.getByText('(runs live or ended in the last 24 h)')).toBeTruthy();
  });

  it('keeps "task last changed" ticking for an ended Steward', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      vi.setSystemTime(Date.parse('2026-10-04T12:00:00.000Z'));
      useAppStore.setState((s) => ({
        world: {
          ...s.world,
          tasks: {
            ...s.world.tasks,
            [fx.task.id]: { ...fx.task, updatedAt: '2026-10-04T11:59:00.000Z' },
          },
          statuses: {
            ...s.world.statuses,
            'a-steward-1': st('a-steward-1', { state: 'finished' }),
          },
        },
      }));
      show(<TaskStatusFacts agentId="a-steward-1" />);
      const changed = () =>
        screen.getByText('task last changed').closest('.sts-fact')!.querySelector('dd')!
          .textContent;
      const before = changed();
      act(() => void vi.advanceTimersByTime(120_000));
      expect(changed()).not.toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('selects the agent of an attention entry with one click', () => {
    show(<SystemStatusView />);
    fireEvent.click(screen.getByRole('link', { name: 'Rotate the signing keys' }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-blocked' });
    expect(window.location.pathname).toBe('/steward/a-blocked');
  });

  it('shows a project: its tasks blocked first, Stewards, questions, cost, the narrative button', () => {
    show(<ProjectStatusView projectId="p-1" />);
    const view = screen.getByRole('region', { name: 'status of Auth refactor' });
    const tasks = within(view).getByRole('list', { name: 'tasks' });
    const rows = within(tasks).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual([
      'Rotate the signing keys',
      'Replace the session middleware',
    ]);
    expect(rows[0]!.className).toMatch(/is-blocked/);
    expect(within(view).getByText('2 active, 2 in total')).toBeTruthy();
    fireEvent.click(within(rows[1]!).getByRole('link'));
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-steward-1' });
  });

  it('asks the Harmonizer for a narrative only on the button, then opens its chat', async () => {
    useAppStore.getState().select({ kind: 'waykeeper', id: 'a-waykeeper-1' });
    useDockView.getState().setView('status');
    show(<ProjectStatusView projectId="p-1" />);
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Ask the Harmonizer for a narrative status' }),
      );
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe('a-harmonizer');
    expect(send.mock.calls[0]![1]).toMatch(/project "Auth refactor" \(p-1\)/);
    expect(send.mock.calls[0]![2]).toBe(false);
    expect(useAppStore.getState().selection).toEqual({ kind: 'harmonizer' });
    expect(useDockView.getState().view).toBe('chat');
  });

  it('adds the task facts to the Steward view', () => {
    show(<TaskStatusFacts agentId="a-steward-1" />);
    const facts = document.querySelector<HTMLElement>('dl[aria-label="task status"]')!;
    expect(within(facts).getByText('normal')).toBeTruthy();
    expect(within(facts).getByText('$0.4200')).toBeTruthy();
    expect(within(facts).getByText('0 permission, 1 clarification')).toBeTruthy();
  });
});

describe('the dock’s Chat | Status switch', () => {
  beforeEach(() => {
    useConversationStore.getState().reset();
    localStorage.clear();
    localStorage.setItem('galactic.token', 'tok');
    localStorage.setItem(SCENE_VISIBLE_KEY, '1');
    useDockView.getState().reload();
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

  const toggle = () => screen.getByRole('group', { name: 'show the chat or the status' });
  const chatPane = () => document.querySelector('.sts-pane-chat')!;

  it('switches the Harmonizer’s dock to the system status and back, keeping the chat mounted', async () => {
    await open('/');
    expect(
      within(toggle()).getByRole('button', { name: 'Chat' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(screen.queryByRole('region', { name: 'system status' })).toBeNull();
    fireEvent.click(within(toggle()).getByRole('button', { name: 'Status' }));
    expect(screen.getByRole('region', { name: 'system status' })).toBeTruthy();
    // the conversation is still there, collapsed and out of reach
    expect(chatPane().className).toMatch(/is-hidden/);
    expect(chatPane().hasAttribute('inert')).toBe(true);
    expect(chatPane().getAttribute('aria-hidden')).toBe('true');
    expect(chatPane().querySelector('textarea')).not.toBeNull();
    fireEvent.click(within(toggle()).getByRole('button', { name: 'Chat' }));
    expect(screen.queryByRole('region', { name: 'system status' })).toBeNull();
    expect(chatPane().className).not.toMatch(/is-hidden/);
  });

  it('remembers the choice per browser and shows a Waykeeper its project', async () => {
    await open('/');
    fireEvent.click(within(toggle()).getByRole('button', { name: 'Status' }));
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('status');
    expect(readDockView()).toBe('status');
    cleanup();
    useDockView.getState().reload();
    await open('/waykeeper/a-waykeeper-1');
    expect(screen.getByRole('region', { name: 'status of Auth refactor' })).toBeTruthy();
  });

  it('offers the switch and the system status with no Harmonizer row (decision 44)', async () => {
    FakeWebSocket.instances = [];
    useAppStore.getState().reset();
    window.history.replaceState(null, '', '/');
    render(<App />);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.serverOpens();
      socket.serverSends({
        ...snapshot,
        agents: [waykeeper, fx.agent, blockedSteward],
        statuses: snapshot.type === 'snapshot' ? snapshot.statuses.slice(1) : [],
      } as ServerMessage);
    });
    expect(screen.getByText(/No Harmonizer is running/)).toBeTruthy();
    fireEvent.click(within(toggle()).getByRole('button', { name: 'Status' }));
    const view = screen.getByRole('region', { name: 'system status' });
    expect(within(view).getByRole('link', { name: 'Rotate the signing keys' })).toBeTruthy();
    expect(
      (
        within(view).getByRole('button', {
          name: 'Ask the Harmonizer for a narrative status',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByText(/No Harmonizer is running\. Start/)).toBeNull();
  });

  it('offers no switch on a Steward: its view is its status', async () => {
    await open('/steward/a-steward-1');
    expect(screen.queryByRole('group', { name: 'show the chat or the status' })).toBeNull();
    expect(document.querySelector('.stw dl[aria-label="task status"]')).not.toBeNull();
  });
});
