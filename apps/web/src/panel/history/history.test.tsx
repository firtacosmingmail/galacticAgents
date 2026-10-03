// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  ControlBody,
  HistoryQuestion,
  HistoryQuestionsResponse,
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

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 10,
  agents: [fx.harmonizer, oldSteward, waykeeper],
  bodies: [fx.body, fx.asteroid],
  projects: [doneProject],
  tasks: [archivedTask],
  questions: [pastQuestion, withdrawn],
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
      // Two pages: the task, then (before its cursor) the project.
      const all = [workItem(archivedTask), workItem(doneProject)].filter(
        (i) =>
          !q || (i.kind === 'task' ? i.item.description : i.item.name).toLowerCase().includes(q),
      );
      const before = u.searchParams.get('before');
      const from = before ? all.findIndex((i) => i.cursor === before) + 1 : 0;
      const page = all.slice(from, from + 1);
      return json({ items: page, hasMore: from + 1 < all.length } satisfies HistoryWorkResponse);
    }
    if (u.pathname === '/api/history/questions') {
      const all = [questionItem(pastQuestion), questionItem(withdrawn, 'no longer needed')].filter(
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
