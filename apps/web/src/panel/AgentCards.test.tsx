// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_POLICY_PRESETS,
  type Agent,
  type AgentState,
  type ControlBody,
  type Project,
  type Question,
  type StatusRecord,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../console/api.js';
import { ApiContext } from '../console/hierarchy/shared.js';
import { useAppStore } from '../state/store.js';
import { ManagedAgentCards } from './AgentCards.js';

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-wk',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const steward: Agent = {
  ...fx.agent,
  id: 'a-st',
  taskId: 't-2',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-ast-1',
};
const STEWARD = 'Steward · Fix the flaky date test';
const WAYKEEPER = 'Waykeeper · Auth refactor';

interface World {
  stewardState?: AgentState;
  waykeeperState?: AgentState;
  task?: Partial<Task>;
  project?: Partial<Project>;
  questions?: Question[];
  extraAgents?: Agent[];
  extraProjects?: Project[];
  extraTasks?: Task[];
}

function load(w: World = {}) {
  const status = (agentId: string, state: AgentState = 'working'): StatusRecord => ({
    ...fx.status,
    agentId,
    state,
  });
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq: 5,
    agents: [fx.harmonizer, waykeeper, steward, ...(w.extraAgents ?? [])],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [{ ...fx.project, ...w.project }, ...(w.extraProjects ?? [])],
    tasks: [
      { ...fx.asteroidTask, state: 'in_progress', ...w.task },
      fx.task,
      ...(w.extraTasks ?? []),
    ],
    questions: w.questions ?? [],
    proposals: [],
    statuses: [
      status('a-harmonizer'),
      status('a-wk', w.waykeeperState),
      status('a-st', w.stewardState),
      ...(w.extraAgents ?? []).map((a) => status(a.id)),
    ],
  });
}

let control: ReturnType<typeof vi.fn>;
let recover: ReturnType<typeof vi.fn>;
let api: Api;

beforeEach(() => {
  useAppStore.getState().reset();
  control = vi.fn(async () => ({ ok: true, seq: 6 }));
  recover = vi.fn(async () => ({ ok: true }));
  api = { control, recover } as unknown as Api;
});
afterEach(() => cleanup());

function show(supervisorId = 'a-harmonizer') {
  const supervisor = useAppStore.getState().world.agents[supervisorId];
  return render(
    <ApiContext.Provider value={api}>
      <ManagedAgentCards supervisor={supervisor} />
    </ApiContext.Provider>,
  );
}

const card = (name: string) => screen.getByRole('article', { name: `card of ${name}` });
const group = (name: string, scope: 'agent' | 'task' | 'project') =>
  within(card(name)).getByRole('group', { name: new RegExp(`^${scope} controls of`) });

type Row = {
  name: string;
  world: World;
  card: string;
  scope: 'agent' | 'task' | 'project';
  button: string;
  confirm?: boolean;
  showArchived?: boolean;
  sent: ControlBody;
};

const agentT = (id: string) => ({ kind: 'agent' as const, id });
const taskT = { kind: 'task' as const, id: 't-2' };
const projectT = { kind: 'project' as const, id: 'p-1' };
const task = (state: WorkState, pinned?: boolean): World => ({
  task: { state, ...(pinned !== undefined ? { pinned } : {}) },
  stewardState: state === 'completed' || state === 'archived' ? 'finished' : 'working',
});
const project = (state: WorkState, pinned?: boolean): World => ({
  project: { state, ...(pinned !== undefined ? { pinned } : {}) },
  waykeeperState: state === 'completed' || state === 'failed' ? 'stopped' : 'working',
});

// Every control action of SPEC §4.3 ("stop, cancel, pause or resume a task, project or agent; …
// close a project; archive early, pin, or reopen finished work"), as a card offers it.
const ROWS: Row[] = [
  // the agent itself
  {
    name: 'pause an agent',
    world: {},
    card: STEWARD,
    scope: 'agent',
    button: 'Pause',
    sent: { target: agentT('a-st'), action: { action: 'pause' } },
  },
  {
    name: 'resume an agent',
    world: { stewardState: 'paused' },
    card: STEWARD,
    scope: 'agent',
    button: 'Resume',
    sent: { target: agentT('a-st'), action: { action: 'resume' } },
  },
  {
    name: 'stop an agent',
    world: {},
    card: STEWARD,
    scope: 'agent',
    button: 'Stop',
    confirm: true,
    sent: { target: agentT('a-st'), action: { action: 'stop' } },
  },
  {
    name: 'pause a Waykeeper',
    world: {},
    card: WAYKEEPER,
    scope: 'agent',
    button: 'Pause',
    sent: { target: agentT('a-wk'), action: { action: 'pause' } },
  },
  // a task
  {
    name: 'pause a task',
    world: task('in_progress'),
    card: STEWARD,
    scope: 'task',
    button: 'Pause',
    sent: { target: taskT, action: { action: 'pause' } },
  },
  {
    name: 'resume a task',
    world: task('paused'),
    card: STEWARD,
    scope: 'task',
    button: 'Resume',
    sent: { target: taskT, action: { action: 'resume' } },
  },
  {
    name: 'stop a task',
    world: task('in_progress'),
    card: STEWARD,
    scope: 'task',
    button: 'Stop',
    confirm: true,
    sent: { target: taskT, action: { action: 'stop' } },
  },
  {
    name: 'cancel a task',
    world: task('blocked_on_user'),
    card: STEWARD,
    scope: 'task',
    button: 'Cancel',
    confirm: true,
    sent: { target: taskT, action: { action: 'cancel' } },
  },
  {
    name: 'close a task',
    world: task('awaiting_closure'),
    card: STEWARD,
    scope: 'task',
    button: 'Close',
    confirm: true,
    sent: { target: taskT, action: { action: 'close' } },
  },
  {
    name: 'archive a task early',
    world: task('completed'),
    card: STEWARD,
    scope: 'task',
    button: 'Archive now',
    confirm: true,
    sent: { target: taskT, action: { action: 'archive' } },
  },
  {
    name: 'pin a task',
    world: task('completed', false),
    card: STEWARD,
    scope: 'task',
    button: 'Pin',
    sent: { target: taskT, action: { action: 'pin', pinned: true } },
  },
  {
    name: 'unpin a task',
    world: task('completed', true),
    card: STEWARD,
    scope: 'task',
    button: 'Unpin',
    sent: { target: taskT, action: { action: 'pin', pinned: false } },
  },
  {
    name: 'reopen a task',
    world: task('completed'),
    card: STEWARD,
    scope: 'task',
    button: 'Reopen',
    sent: { target: taskT, action: { action: 'reopen' } },
  },
  {
    name: 'reopen an archived task',
    world: task('archived'),
    showArchived: true,
    card: STEWARD,
    scope: 'task',
    button: 'Reopen',
    sent: { target: taskT, action: { action: 'reopen' } },
  },
  // a project
  {
    name: 'pause a project',
    world: project('in_progress'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Pause',
    sent: { target: projectT, action: { action: 'pause' } },
  },
  {
    name: 'resume a project',
    world: project('paused'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Resume',
    sent: { target: projectT, action: { action: 'resume' } },
  },
  {
    name: 'stop a project',
    world: project('in_progress'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Stop',
    confirm: true,
    sent: { target: projectT, action: { action: 'stop' } },
  },
  {
    name: 'cancel a project',
    world: project('in_progress'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Cancel',
    confirm: true,
    sent: { target: projectT, action: { action: 'cancel' } },
  },
  {
    name: 'close a project',
    world: project('awaiting_closure'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Close',
    confirm: true,
    sent: { target: projectT, action: { action: 'close' } },
  },
  {
    name: 'archive a project early',
    world: project('failed'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Archive now',
    confirm: true,
    sent: { target: projectT, action: { action: 'archive' } },
  },
  {
    name: 'pin a project',
    world: project('completed'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Pin',
    sent: { target: projectT, action: { action: 'pin', pinned: true } },
  },
  {
    name: 'reopen a project',
    world: project('completed'),
    card: WAYKEEPER,
    scope: 'project',
    button: 'Reopen',
    sent: { target: projectT, action: { action: 'reopen' } },
  },
];

describe('managed-agents cards: every control action of SPEC §4.3 (P25-04)', () => {
  it.each(ROWS)('$name', async (row) => {
    load(row.world);
    show();
    if (row.showArchived) fireEvent.click(screen.getByLabelText('show archived work'));
    fireEvent.click(within(group(row.card, row.scope)).getByRole('button', { name: row.button }));
    if (row.confirm) {
      // Destructive: nothing is sent until the inline confirm is accepted.
      expect(control).not.toHaveBeenCalled();
      const confirm = within(card(row.card)).getByRole('group', { name: 'confirm' });
      fireEvent.click(
        within(confirm).getByRole('button', { name: `Yes, ${row.button.toLowerCase()}` }),
      );
    } else {
      expect(within(card(row.card)).queryByRole('group', { name: 'confirm' })).toBeNull();
    }
    await waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    expect(control).toHaveBeenCalledWith(row.sent);
  });

  it('edits a task’s description and priority', async () => {
    load();
    show();
    fireEvent.click(within(group(STEWARD, 'task')).getByRole('button', { name: 'Edit' }));
    const c = card(STEWARD);
    fireEvent.change(within(c).getByLabelText('description'), {
      target: { value: 'Fix the flaky date test for good' },
    });
    fireEvent.change(within(c).getByLabelText('priority'), { target: { value: 'low' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith({
        target: taskT,
        action: {
          action: 'edit',
          changes: { description: 'Fix the flaky date test for good', priority: 'low' },
        },
      }),
    );
    await waitFor(() => expect(within(c).queryByRole('button', { name: 'Save' })).toBeNull());
  });

  it('edits a project’s trust level (decision 49)', async () => {
    load();
    show();
    fireEvent.click(within(group(WAYKEEPER, 'project')).getByRole('button', { name: 'Edit' }));
    const c = card(WAYKEEPER);
    fireEvent.change(within(c).getByLabelText('trust level'), { target: { value: 'trusted' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith({
        target: projectT,
        action: {
          action: 'edit',
          changes: { permissionPolicy: PERMISSION_POLICY_PRESETS.trusted },
        },
      }),
    );
  });

  it('opens (selects) the agent from its card', () => {
    load();
    show();
    fireEvent.click(within(card(STEWARD)).getByRole('link', { name: STEWARD }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-st' });
    fireEvent.click(within(card(WAYKEEPER)).getByRole('link', { name: WAYKEEPER }));
    expect(useAppStore.getState().selection).toEqual({ kind: 'waykeeper', id: 'a-wk' });
  });

  it('resumes an interrupted agent’s session', async () => {
    load({ stewardState: 'interrupted' });
    show();
    fireEvent.click(
      within(group(STEWARD, 'agent')).getByRole('button', { name: 'Resume session' }),
    );
    await waitFor(() => expect(recover).toHaveBeenCalledWith('a-st'));
  });

  it('“Keep” withdraws a confirm without sending anything', () => {
    load();
    show();
    fireEvent.click(within(group(STEWARD, 'task')).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(card(STEWARD)).getByRole('button', { name: 'Keep' }));
    expect(within(card(STEWARD)).queryByRole('group', { name: 'confirm' })).toBeNull();
    expect(control).not.toHaveBeenCalled();
  });

  it('shows a refusal (409) inline on the card', async () => {
    control.mockRejectedValueOnce(
      new ApiError(409, 'project p-1 cannot be archived while agents run', 'rejected'),
    );
    load(project('failed'));
    show();
    fireEvent.click(
      within(group(WAYKEEPER, 'project')).getByRole('button', { name: 'Archive now' }),
    );
    fireEvent.click(within(card(WAYKEEPER)).getByRole('button', { name: 'Yes, archive now' }));
    const alert = await within(card(WAYKEEPER)).findByRole('alert');
    expect(alert.textContent).toBe('project p-1 cannot be archived while agents run');
    expect(within(card(STEWARD)).queryByRole('alert')).toBeNull();
  });
});

describe('managed-agents cards: what they show (P25-04)', () => {
  it('shows state, activity, cost, caps and the open-question badge', () => {
    load({
      questions: [
        {
          ...fx.question,
          id: 'q-a',
          originAgentId: 'a-st',
          holder: { type: 'agent', id: 'a-harmonizer' },
        },
      ],
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(fx.status.startedAt) + 5 * 60_000);
    show();
    vi.useRealTimers();
    const c = within(card(STEWARD));
    expect(c.getByText('working')).toBeTruthy();
    expect(c.getByText('Editing src/session.ts')).toBeTruthy();
    expect(c.getByLabelText('cost so far').textContent).toBe('$0.4200');
    expect(c.getByLabelText('tool calls').textContent).toMatch(/^17 \/ 500/);
    expect(c.getByLabelText('wall clock').textContent).toBe('5 min / 1 h');
    expect(c.getByLabelText('open questions').textContent).toBe('1 open question');
    // Held by a supervisor: not blocked on the user.
    expect(c.queryByText('blocked on you')).toBeNull();
  });

  it('puts “blocked on you” first and loudest', () => {
    load({
      task: { state: 'in_progress' },
      project: { state: 'in_progress' },
      questions: [{ ...fx.question, id: 'q-u', originAgentId: 'a-wk', holder: { type: 'user' } }],
    });
    show();
    const cards = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    // The Waykeeper was created at the same time; the user-held question puts it first.
    expect(cards[0]).toBe(`card of ${WAYKEEPER}`);
    expect(within(card(WAYKEEPER)).getByText('blocked on you')).toBeTruthy();
    expect(card(WAYKEEPER).className).toMatch(/is-blocked/);
    expect(within(card(STEWARD)).queryByText('blocked on you')).toBeNull();
  });

  it('a Waykeeper’s cards: its Stewards and its sub-projects’ Waykeepers', () => {
    const sub: Project = {
      ...fx.project,
      id: 'p-sub',
      name: 'Token storage',
      parentProjectId: 'p-1',
      bodyId: 'b-moon',
    };
    const subWaykeeper: Agent = {
      ...waykeeper,
      id: 'a-wk-sub',
      projectId: 'p-sub',
      supervisorId: 'a-wk',
    };
    const projectSteward: Agent = { ...fx.agent, id: 'a-st-1' };
    load({ extraAgents: [subWaykeeper, projectSteward], extraProjects: [sub] });
    show('a-wk');
    const names = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual([
      'card of Steward · Replace the session middleware',
      'card of Waykeeper · Token storage',
    ]);
  });

  it('keeps a stopped agent’s card so its work can be resumed, and hides archived work', () => {
    load({ stewardState: 'stopped', task: { state: 'paused' } });
    show();
    expect(within(group(STEWARD, 'task')).getByRole('button', { name: 'Resume' })).toBeTruthy();
    // An ended agent takes no agent controls.
    expect(within(card(STEWARD)).queryByRole('group', { name: /^agent controls/ })).toBeNull();
    cleanup();
    load({ stewardState: 'finished', task: { state: 'archived' } });
    show();
    expect(screen.queryByRole('article', { name: `card of ${STEWARD}` })).toBeNull();
    fireEvent.click(screen.getByLabelText('show archived work'));
    expect(card(STEWARD)).toBeTruthy();
  });

  it('gives work no agent runs yet a work-only card with the work controls', async () => {
    const queued: Task = {
      ...fx.asteroidTask,
      id: 't-q',
      description: 'Queued task',
      state: 'approved',
    };
    const unspawned: Project = {
      ...fx.project,
      id: 'p-new',
      name: 'New project',
      state: 'approved',
    };
    const proposed: Task = {
      ...fx.asteroidTask,
      id: 't-p',
      description: 'Proposed task',
      state: 'proposed',
    };
    load({ extraTasks: [queued, proposed], extraProjects: [unspawned] });
    show();
    const q = card('Task · Queued task');
    expect(within(q).getByText('queued: no agent yet')).toBeTruthy();
    // No agent row: no agent controls, no link, no agent figures.
    expect(within(q).queryByRole('group', { name: /^agent controls/ })).toBeNull();
    expect(within(q).queryByRole('link')).toBeNull();
    expect(within(q).queryByLabelText('cost so far')).toBeNull();
    expect(card('Project · New project')).toBeTruthy();
    // Proposed work stays on its plan card.
    expect(screen.queryByRole('article', { name: 'card of Task · Proposed task' })).toBeNull();

    const controls = within(q).getByRole('group', { name: /^task controls of/ });
    for (const b of ['Pause', 'Stop', 'Cancel', 'Close', 'Pin', 'Edit'])
      expect(within(controls).getByRole('button', { name: b })).toBeTruthy();
    fireEvent.click(within(controls).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(q).getByRole('button', { name: 'Yes, cancel' }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith({
        target: { kind: 'task', id: 't-q' },
        action: { action: 'cancel' },
      }),
    );

    fireEvent.click(within(controls).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(q).getByLabelText('priority'), { target: { value: 'low' } });
    fireEvent.click(within(q).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(control).toHaveBeenCalledWith({
        target: { kind: 'task', id: 't-q' },
        action: { action: 'edit', changes: { priority: 'low' } },
      }),
    );
  });
});
