// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  ControlBody,
  HistoryQuestion,
  HistoryQuestionsResponse,
  HistoryWorkDetail,
  HistoryWorkItem,
  HistoryWorkResponse,
  Project,
  Question,
  ServerMessage,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../../App.js';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';
import { emptyWorld } from '../../state/reduce.js';
import { openOnTrail, trailName } from './parts.js';

const TOKEN = 'tok-0123456789abcdefWXYZ';

const archivedTask: Task = {
  ...fx.asteroidTask,
  id: 't-old',
  description: 'Fix the flaky date test',
  blockedBy: [],
  state: 'archived',
  updatedAt: '2026-10-01T09:00:00.000Z',
};
const doneProject: Project = {
  ...fx.project,
  id: 'p-done',
  name: 'CSV tool',
  bodyId: 'b-kepler',
  state: 'completed',
  pinned: true,
  updatedAt: '2026-10-01T08:00:00.000Z',
};
const oldSteward: Agent = { ...fx.agent, id: 'a-st-old', taskId: 't-old', bodyId: 'b-ast-1' };
const waykeeper: Agent = {
  ...fx.agent,
  id: 'a-wk-done',
  role: 'waykeeper',
  taskId: undefined,
  projectId: 'p-done',
  bodyId: 'b-kepler',
} as Agent;
const pastQuestion: Question = {
  ...fx.question,
  id: 'q-past',
  originAgentId: 'a-st-old',
  holder: { type: 'agent', id: fx.harmonizer.id },
  status: 'answered',
  answeredBy: { type: 'agent', id: fx.harmonizer.id },
  answer: 'Keep it, the mobile app reads it',
  version: 2,
  updatedAt: '2026-10-01T09:30:00.000Z',
};
const withdrawn: Question = {
  ...fx.question,
  id: 'q-gone',
  originAgentId: 'a-st-old',
  context: { text: 'Which timezone for the fixtures?' },
  status: 'cancelled',
  version: 1,
  updatedAt: '2026-10-01T07:00:00.000Z',
};

// P5-03: an archived project with a task, a Waykeeper and an escalated question.
const oldSite: Project = {
  ...fx.project,
  id: 'p-arch',
  name: 'Old site',
  bodyId: 'b-kepler',
  state: 'archived',
  createdAt: '2026-09-20T08:00:00.000Z',
  updatedAt: '2026-09-28T08:00:00.000Z',
};
const oldSiteTask: Task = {
  ...fx.asteroidTask,
  id: 't-arch',
  projectId: 'p-arch',
  bodyId: 'b-kepler',
  description: 'Port the landing page',
  blockedBy: [],
  state: 'completed',
};
const oldSiteKeeper: Agent = {
  ...fx.agent,
  id: 'a-wk-arch',
  role: 'waykeeper',
  taskId: undefined,
  projectId: 'p-arch',
  bodyId: 'b-kepler',
} as Agent;
const oldSiteQuestion: Question = {
  ...fx.question,
  id: 'q-arch',
  originAgentId: 'a-wk-arch',
  context: { text: 'Keep the old URLs?' },
  holder: { type: 'user' },
  status: 'answered',
  answeredBy: { type: 'user' },
  answer: 'Yes, with redirects',
  version: 2,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T11:00:00.000Z',
};
const CLOSED_AT = '2026-09-25T16:00:00.000Z';
const ARCHIVED_AT = '2026-09-28T08:00:00.000Z';

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, oldSteward, waykeeper, oldSiteKeeper],
  bodies: [fx.body, fx.asteroid],
  projects: [doneProject, oldSite],
  tasks: [archivedTask, oldSiteTask],
  questions: [pastQuestion, withdrawn, oldSiteQuestion],
  proposals: [],
  statuses: [{ ...fx.status, agentId: fx.harmonizer.id }],
};

const workItem = (item: Task | Project): HistoryWorkItem =>
  'description' in item
    ? { kind: 'task', item, cursor: `${item.updatedAt}~t${item.id}` }
    : { kind: 'project', item, cursor: `${item.updatedAt}~p${item.id}` };
const questionItem = (question: Question, reason?: string): HistoryQuestion => ({
  question,
  ...(reason ? { reason } : {}),
  cursor: `${question.updatedAt}~q${question.id}`,
});

/** What a test adds to the fake server's lists, and the details it serves (P5-03). */
const extra: {
  work: HistoryWorkItem[];
  questions: HistoryQuestion[];
  details: Record<string, HistoryWorkDetail>;
} = { work: [], questions: [], details: {} };

/** A stand-in Mission Control for the history endpoints (and `/api/control`). */
function fakeServer() {
  const calls: string[] = [];
  const controls: ControlBody[] = [];
  /** While set, the history endpoints wait for it before answering. */
  const gate: { wait?: Promise<void> | undefined } = {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url);
    const u = new URL(url, 'http://x');
    const q = u.searchParams.get('q')?.toLowerCase();
    if (u.pathname.startsWith('/api/history/') && gate.wait) await gate.wait;
    if (u.pathname === '/api/history/work') {
      // Two pages: the task, then (before its cursor) the project; a test's rows replace them by id.
      const base = [workItem(archivedTask), workItem(doneProject)];
      const all = [
        ...base.map((i) => extra.work.find((e) => e.item.id === i.item.id) ?? i),
        ...extra.work.filter((e) => !base.some((i) => i.item.id === e.item.id)),
      ].filter(
        (i) =>
          !q || (i.kind === 'task' ? i.item.description : i.item.name).toLowerCase().includes(q),
      );
      const before = u.searchParams.get('before');
      const from = before ? all.findIndex((i) => i.cursor === before) + 1 : 0;
      const page = all.slice(from, from + 1);
      return json({ items: page, hasMore: from + 1 < all.length } satisfies HistoryWorkResponse);
    }
    const detail = /^\/api\/history\/work\/(project|task)\/([^/]+)$/.exec(u.pathname);
    if (detail) {
      const d = extra.details[`${detail[1]}:${decodeURIComponent(detail[2]!)}`];
      return d ? json(d) : json({ error: 'not_found' }, 404);
    }
    if (u.pathname === '/api/history/questions') {
      const all = [
        questionItem(pastQuestion),
        questionItem(withdrawn, 'no longer needed'),
        ...extra.questions,
      ].filter(
        (i) =>
          (!q ||
            i.question.context.text.toLowerCase().includes(q) ||
            i.question.answer?.toLowerCase().includes(q)) &&
          (!u.searchParams.get('status') || i.question.status === u.searchParams.get('status')),
      );
      return json({ items: all, hasMore: false } satisfies HistoryQuestionsResponse);
    }
    if (u.pathname === '/api/control') {
      controls.push(JSON.parse(String(init?.body)) as ControlBody);
      return json({ ok: true });
    }
    if (url.endsWith('/messages')) return json({ messages: [] });
    return json({});
  });
  return { calls, controls, gate, fetchImpl };
}

let server: ReturnType<typeof fakeServer>;
let socket: FakeWebSocket;

beforeEach(() => {
  extra.work = [];
  extra.questions = [];
  extra.details = {};
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', TOKEN);
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(path: string) {
  server = fakeServer();
  vi.stubGlobal('fetch', server.fetchImpl);
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
}

const page = () => screen.getByRole('main', { name: 'history' });
const work = () => screen.getByRole('region', { name: 'past work' });
const questions = () => screen.getByRole('region', { name: 'past questions' });
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const search = async (text: string) => {
  fireEvent.change(within(page()).getByRole('searchbox', { name: 'Search the history' }), {
    target: { value: text },
  });
  await act(async () => {
    fireEvent.submit(within(page()).getByRole('search'));
  });
};

describe('history view (P25-10)', () => {
  it('opens at /history in the panel frame, linked from the top bar, and leaves to the panel', async () => {
    await open('/');
    await click(screen.getByRole('link', { name: 'History' }));
    expect(window.location.pathname).toBe('/history');
    expect(page()).toBeTruthy();
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('aria-current')).toBe('page');
    await click(within(page()).getByRole('link', { name: '← Back to the panel' }));
    expect(window.location.pathname).toBe('/');
    expect(screen.queryByRole('main', { name: 'history' })).toBeNull();
  });

  it('finds an archived task by text and reopens it', async () => {
    await open('/history');
    await within(work()).findByRole('listitem', { name: 'Fix the flaky date test' });
    await search('flaky');
    expect(server.calls).toContain('/api/history/work?q=flaky&limit=25');
    const row = await within(work()).findByRole('listitem', {
      name: 'Fix the flaky date test',
    });
    expect(within(work()).queryByRole('listitem', { name: 'CSV tool' })).toBeNull();
    expect(within(row).getByText('archived')).toBeTruthy();
    expect(within(row).getByText('Ceres-1')).toBeTruthy(); // its body

    // Its Steward's read-only view is one click away (decision 53).
    expect(within(row).getByRole('link', { name: 'Steward view' }).getAttribute('href')).toBe(
      '/steward/a-st-old',
    );

    await click(within(row).getByRole('button', { name: 'Reopen' }));
    expect(server.controls).toEqual([
      { target: { kind: 'task', id: 't-old' }, action: { action: 'reopen' } },
    ]);
    // The stream reports the reopen: the row shows the live state, and no longer offers it.
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 11,
        at: '2026-10-03T10:00:00.000Z',
        event: {
          type: 'task.state_changed',
          taskId: 't-old',
          from: 'archived',
          to: 'in_progress',
          by: { type: 'user' },
        },
      });
    });
    expect(within(row).getByText('in progress')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('pages back through the work, and unpins finished work', async () => {
    await open('/history');
    await within(work()).findByRole('listitem', { name: 'Fix the flaky date test' });
    expect(within(work()).queryByRole('listitem', { name: 'CSV tool' })).toBeNull();
    await click(within(work()).getByRole('button', { name: 'Show older' }));
    const row = await within(work()).findByRole('listitem', { name: 'CSV tool' });
    expect(server.calls).toContain(
      `/api/history/work?${new URLSearchParams({ before: '2026-10-01T09:00:00.000Z~tt-old', limit: '25' })}`,
    );
    expect(within(work()).queryByRole('button', { name: 'Show older' })).toBeNull();
    expect(within(row).getByRole('link', { name: 'Waykeeper chat' }).getAttribute('href')).toBe(
      '/waykeeper/a-wk-done',
    );
    await click(within(row).getByRole('button', { name: 'Unpin' }));
    expect(server.controls.at(-1)).toEqual({
      target: { kind: 'project', id: 'p-done' },
      action: { action: 'pin', pinned: false },
    });
    // Archive now asks first.
    await click(within(row).getByRole('button', { name: 'Archive now' }));
    expect(server.controls).toHaveLength(1);
    await click(within(row).getByRole('button', { name: 'Yes, archive now' }));
    expect(server.controls.at(-1)).toEqual({
      target: { kind: 'project', id: 'p-done' },
      action: { action: 'archive' },
    });
  });

  it('finds a past question with its answer, who answered, and a link to the agent that asked', async () => {
    await open('/history');
    await search('cookie');
    const row = await within(questions()).findByRole('listitem', {
      name: 'Keep the legacy cookie name?',
    });
    expect(server.calls).toContain('/api/history/questions?q=cookie&limit=25');
    expect(within(row).getByText('clarification')).toBeTruthy();
    expect(within(row).getByText('answered', { selector: '.his-tag' })).toBeTruthy();
    expect(within(row).getByLabelText('answer').textContent).toBe(
      'Keep it, the mobile app reads it',
    );
    expect(within(row).getByText('Harmonizer')).toBeTruthy(); // answered by
    expect(
      within(questions()).queryByRole('listitem', {
        name: 'Which timezone for the fixtures?',
      }),
    ).toBeNull();
    await click(within(row).getByRole('link', { name: /^open Steward/ }));
    expect(window.location.pathname).toBe('/steward/a-st-old');
  });

  it('filters past questions to the withdrawn ones, with the reason', async () => {
    await open('/history');
    await within(questions()).findByRole('listitem', {
      name: 'Keep the legacy cookie name?',
    });
    fireEvent.change(within(questions()).getByRole('combobox', { name: 'Question status' }), {
      target: { value: 'cancelled' },
    });
    const row = await within(questions()).findByRole('listitem', {
      name: 'Which timezone for the fixtures?',
    });
    expect(server.calls).toContain('/api/history/questions?status=cancelled&limit=25');
    expect(within(row).getByText('withdrawn or ended', { selector: '.his-tag' })).toBeTruthy();
    expect(within(row).getByText('Why: no longer needed')).toBeTruthy();
    expect(
      within(questions()).queryByRole('listitem', {
        name: 'Keep the legacy cookie name?',
      }),
    ).toBeNull();
  });

  it('offers a refresh when work finishes, and keeps the rows on screen while it reads', async () => {
    await open('/history');
    const row = await within(work()).findByRole('listitem', { name: 'Fix the flaky date test' });
    expect(within(work()).queryByRole('status')).toBeNull();
    const taskMoves = async (seq: number, from: Task['state'], to: Task['state']) => {
      await act(async () => {
        socket.serverSends({
          type: 'event',
          seq,
          at: `2026-10-03T10:0${seq - 10}:00.000Z`,
          event: { type: 'task.state_changed', taskId: 't-old', from, to, by: { type: 'user' } },
        });
      });
    };
    // Leaving the history is not new history.
    await taskMoves(11, 'archived', 'in_progress');
    expect(within(work()).queryByRole('status')).toBeNull();
    await taskMoves(12, 'in_progress', 'completed');
    const hint = within(work()).getByRole('status');
    expect(hint.textContent).toContain('New items');
    expect(within(questions()).queryByRole('status')).toBeNull();

    // The refresh reads the newest page again; the rows stay until it arrives.
    let release!: () => void;
    server.gate.wait = new Promise<void>((r) => (release = r));
    const reads = server.calls.filter((c) => c === '/api/history/work?limit=25').length;
    await click(within(hint).getByRole('button', { name: 'refresh' }));
    expect(server.calls.filter((c) => c === '/api/history/work?limit=25')).toHaveLength(reads + 1);
    expect(within(work()).getByRole('listitem', { name: 'Fix the flaky date test' })).toBe(row);
    expect(within(work()).queryByText('Loading…')).toBeNull();
    server.gate.wait = undefined;
    await act(async () => {
      release();
    });
    await vi.waitFor(() => expect(within(work()).queryByRole('status')).toBeNull());
    expect(within(work()).getByRole('listitem', { name: 'Fix the flaky date test' })).toBeTruthy();
  });

  it('offers a refresh when a question resolves', async () => {
    await open('/history');
    await within(questions()).findByRole('listitem', { name: 'Keep the legacy cookie name?' });
    const asked: Question = {
      ...fx.question,
      id: 'q-new',
      context: { text: 'Squash the commits?' },
      status: 'open',
      version: 0,
    };
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 11,
        at: '2026-10-03T10:00:00.000Z',
        event: { type: 'question.opened', question: asked },
      });
    });
    expect(within(questions()).queryByRole('status')).toBeNull();
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 12,
        at: '2026-10-03T10:01:00.000Z',
        event: {
          type: 'question.answered',
          questionId: 'q-new',
          answer: 'yes',
          answeredBy: { type: 'user' },
          version: 1,
        },
      });
    });
    expect(within(questions()).getByRole('status').textContent).toContain('New items');
    expect(within(work()).queryByRole('status')).toBeNull();
  });
});

describe('history inspector (P5-03)', () => {
  const oldSiteDetail: HistoryWorkDetail = {
    work: { kind: 'project', item: oldSite },
    bodyName: 'Kepler',
    trail: {
      closedAt: CLOSED_AT,
      archivedAt: ARCHIVED_AT,
      moves: [
        {
          at: '2026-09-22T09:00:00.000Z',
          fromBodyId: 'b-luna',
          fromBodyName: 'Luna',
          toBodyId: 'b-kepler',
          toBodyName: 'Kepler',
        },
      ],
    },
    states: [
      { at: '2026-09-20T09:00:00.000Z', from: 'approved', to: 'in_progress' },
      { at: CLOSED_AT, from: 'awaiting_closure', to: 'completed', by: { type: 'user' } },
      { at: ARCHIVED_AT, from: 'completed', to: 'archived' },
    ],
    tasks: [oldSiteTask],
    subProjects: [],
    agents: [oldSiteKeeper],
    questions: [
      {
        question: oldSiteQuestion,
        cursor: `${oldSiteQuestion.updatedAt}~qq-arch`,
        holders: [
          {
            holder: { type: 'agent', id: fx.harmonizer.id },
            at: oldSiteQuestion.createdAt,
            via: 'asked',
          },
          { holder: { type: 'user' }, at: '2026-09-21T10:05:00.000Z', via: 'escalated' },
        ],
      },
    ],
    moreQuestions: false,
  };
  const oldSiteItem = {
    ...workItem(oldSite),
    bodyName: 'Kepler',
    trail: oldSiteDetail.trail,
  } as HistoryWorkItem;
  const inspector = (name: string) => screen.getByRole('region', { name: `details of ${name}` });
  const timeOf = (scope: HTMLElement, term: string) =>
    within(scope).getByText(term, { selector: 'dt' }).nextElementSibling!.querySelector('time')!
      .dateTime;

  it('finds an archived project, inspects it and reopens it (acceptance)', async () => {
    extra.work = [oldSiteItem];
    extra.details = { 'project:p-arch': oldSiteDetail };
    await open('/history');
    await search('old site');
    const row = await within(work()).findByRole('listitem', { name: 'Old site' });
    // Its closure dates and its move, right on the row.
    expect(timeOf(row, 'closed')).toBe(CLOSED_AT);
    expect(timeOf(row, 'archived')).toBe(ARCHIVED_AT);
    expect(within(row).getByRole('list', { name: 'moves of Old site' }).textContent).toContain(
      'from Luna to Kepler',
    );

    await click(within(row).getByRole('button', { name: 'Inspect Old site' }));
    expect(server.calls).toContain('/api/history/work/project/p-arch');
    const panel = await vi.waitFor(() => inspector('Old site'));
    const steps = await within(panel).findByRole('list', { name: 'state changes of Old site' });
    expect(within(panel).getByText('lived on').nextElementSibling!.textContent).toBe('Kepler');
    expect(timeOf(panel, 'closed')).toBe(CLOSED_AT);
    expect(timeOf(panel, 'archived')).toBe(ARCHIVED_AT);
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('in progress'),
      expect.stringMatching(/completed.*by you/),
      expect.stringContaining('archived'),
    ]);
    // Its task opens here; its Waykeeper's chat is one click away.
    expect(
      within(panel).getByRole('button', { name: 'inspect task Port the landing page' }),
    ).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Waykeeper chat' }).getAttribute('href')).toBe(
      '/waykeeper/a-wk-arch',
    );
    // Its question, with who held it and who answered.
    const q = within(panel).getByRole('listitem', { name: 'Keep the old URLs?' });
    const chain = within(q).getByRole('list', { name: 'holder chain' });
    expect(
      within(chain)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Harmonizer', 'you']);
    expect(within(q).getByText('answered by').nextElementSibling!.textContent).toBe('you');

    await click(within(panel).getByRole('button', { name: 'Reopen' }));
    expect(server.controls).toEqual([
      { target: { kind: 'project', id: 'p-arch' }, action: { action: 'reopen' } },
    ]);
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 11,
        at: '2026-10-04T10:00:00.000Z',
        event: {
          type: 'project.state_changed',
          projectId: 'p-arch',
          from: 'archived',
          to: 'approved',
          by: { type: 'user' },
        },
      });
    });
    expect(within(inspector('Old site')).queryByRole('button', { name: 'Reopen' })).toBeNull();
    expect(within(row).getByText('approved')).toBeTruthy();
  });

  it('follows a moved-to link to the project the task joined, and back', async () => {
    const movedTask = {
      ...workItem(archivedTask),
      trail: {
        archivedAt: '2026-10-01T09:00:00.000Z',
        moves: [
          {
            at: '2026-09-30T12:00:00.000Z',
            fromBodyId: 'b-ast-1',
            fromBodyName: 'Ceres-1',
            toBodyId: 'b-kepler',
            toBodyName: 'Kepler',
            intoProjectId: 'p-done',
            intoProjectName: 'CSV tool',
          },
        ],
      },
    } as HistoryWorkItem;
    extra.details = {
      'project:p-done': {
        work: { kind: 'project', item: doneProject },
        bodyName: 'Kepler',
        trail: { moves: [] },
        states: [],
        tasks: [archivedTask],
        subProjects: [],
        agents: [waykeeper],
        questions: [],
        moreQuestions: false,
      },
      'task:t-old': {
        work: { kind: 'task', item: archivedTask },
        bodyName: 'Ceres-1',
        trail: movedTask.trail!,
        states: [],
        project: doneProject,
        tasks: [],
        subProjects: [],
        agents: [oldSteward],
        questions: [],
        moreQuestions: false,
      },
    };
    // The moved task is the only work row.
    extra.work = [movedTask];
    await open('/history');
    await search('flaky');
    const moved = await vi.waitFor(() => {
      const rows = within(work()).getAllByRole('listitem', { name: 'Fix the flaky date test' });
      const withMove = rows.find((r) => within(r).queryByRole('list', { name: /^moves of/ }));
      if (!withMove) throw new Error('no moved row yet');
      return withMove;
    });
    const moves = within(moved).getByRole('list', { name: 'moves of Fix the flaky date test' });
    expect(moves.textContent).toContain('from Ceres-1 to Kepler, into project CSV tool');
    await click(within(moves).getByRole('button', { name: 'inspect project CSV tool' }));
    const project = await vi.waitFor(() => inspector('CSV tool'));
    await within(project).findByRole('list', { name: 'work of CSV tool' });

    // From the project to its task, then back.
    await click(
      within(project).getByRole('button', { name: 'inspect task Fix the flaky date test' }),
    );
    const task = await vi.waitFor(() => inspector('Fix the flaky date test'));
    await within(task).findByRole('list', { name: 'moves of Fix the flaky date test' });
    // Its project (a fact) and the move into it both lead back to the project.
    expect(within(task).getAllByRole('button', { name: 'inspect project CSV tool' })).toHaveLength(
      2,
    );
    // Following it (A → B → A) goes back to the project's entry: no duplicate, no "Back".
    await click(within(task).getAllByRole('button', { name: 'inspect project CSV tool' })[0]!);
    const again = await vi.waitFor(() => inspector('CSV tool'));
    expect(within(again).queryByRole('button', { name: /^← Back to/ })).toBeNull();
    await click(
      within(await within(again).findByRole('list', { name: 'work of CSV tool' })).getByRole(
        'button',
        { name: 'inspect task Fix the flaky date test' },
      ),
    );
    const task2 = await vi.waitFor(() => inspector('Fix the flaky date test'));
    await click(within(task2).getByRole('button', { name: '← Back to CSV tool' }));
    await vi.waitFor(() => inspector('CSV tool'));
    await click(within(inspector('CSV tool')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: /^details of/ })).toBeNull();
  });

  it('shows each past question’s holder chain, escalations and reassignments in order', async () => {
    extra.questions = [
      {
        question: oldSiteQuestion,
        cursor: `${oldSiteQuestion.updatedAt}~qq-arch`,
        holders: [
          {
            holder: { type: 'agent', id: 'a-wk-done' },
            at: '2026-09-21T10:00:00.000Z',
            via: 'asked',
          },
          {
            holder: { type: 'agent', id: fx.harmonizer.id },
            at: '2026-09-21T10:02:00.000Z',
            via: 'reassigned',
            reason: 'holder a-wk-done ended',
          },
          { holder: { type: 'user' }, at: '2026-09-21T10:05:00.000Z', via: 'escalated' },
        ],
      },
    ];
    await open('/history');
    await search('old urls');
    const row = await within(questions()).findByRole('listitem', { name: 'Keep the old URLs?' });
    const chain = within(row).getByRole('list', { name: 'holder chain' });
    expect(
      within(chain)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Waykeeper · CSV tool', 'Harmonizer (reassigned: holder a-wk-done ended)', 'you']);
    expect(within(row).getByText('answered by').nextElementSibling!.textContent).toBe('you');
  });

  it('says so when the item cannot be read', async () => {
    extra.work = [oldSiteItem];
    await open('/history');
    await search('old site');
    const row = await within(work()).findByRole('listitem', { name: 'Old site' });
    await click(within(row).getByRole('button', { name: 'Inspect Old site' }));
    const panel = await vi.waitFor(() => screen.getByRole('region', { name: /^details of/ }));
    expect(await within(panel).findByRole('alert')).toBeTruthy();
  });
});

describe('the inspector trail (wave-1 review)', () => {
  const a = { kind: 'project' as const, id: 'p-a' };
  const b = { kind: 'task' as const, id: 't-b' };

  it('names an entry by its known name, else the stream, else "…" — never the raw id', () => {
    const world = emptyWorld();
    expect(trailName({ target: a, name: undefined }, world)).toBe('…');
    expect(trailName({ target: a, name: 'Alpha' }, world)).toBe('Alpha');
    world.projects['p-a'] = { ...fx.project, id: 'p-a', name: 'From the stream' };
    expect(trailName({ target: a, name: undefined }, world)).toBe('From the stream');
  });

  it('goes back to an entry already on the trail instead of pushing a duplicate', () => {
    let trail = openOnTrail([], a, 'Alpha');
    trail = openOnTrail(trail, b, 'Beta');
    expect(trail.map((e) => e.target.id)).toEqual(['p-a', 't-b']);
    expect(openOnTrail(trail, b)).toBe(trail);
    expect(openOnTrail(trail, a).map((e) => e.target.id)).toEqual(['p-a']);
  });
});
