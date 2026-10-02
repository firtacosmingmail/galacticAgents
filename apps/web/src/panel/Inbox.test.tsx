// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Event,
  Proposal,
  Question,
  ServerMessage,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { createApi } from '../console/api.js';
import { ApiContext } from '../console/hierarchy/shared.js';
import { useAppStore } from '../state/store.js';
import { CardLinksContext, ProposalView, QuestionView } from './cards/index.js';

/** P25-06: the panel's inbox and the shared cards, over the fake socket and a mocked `/api`. */

const NOW = fx.NOW;
const later = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const working = (agentId: string): StatusRecord => ({ ...fx.status, agentId });

const { answer: _a, answeredBy: _b, ...permissionBase } = fx.permissionQuestion;
/** A clarification the user holds, the oldest open question. */
const clarification: Question = { ...fx.question, holder: { type: 'user' }, version: 3 };
/** A permission, created after it, still listed first: a Steward is stopped on a tool call. */
const permission: Question = {
  ...permissionBase,
  status: 'open',
  version: 0,
  createdAt: later(5),
  updatedAt: later(5),
};
const supervisorHeld: Question = {
  ...fx.question,
  id: 'q-3',
  context: { ...fx.question.context, text: 'Which date format?' },
  createdAt: later(-60),
};
const supervisorAnswered: Question = {
  ...fx.question,
  id: 'q-4',
  context: { ...fx.question.context, text: 'Tabs or spaces?' },
  status: 'answered',
  answer: 'spaces',
  answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
  version: 1,
};
const card: Proposal = { ...fx.proposal, createdAt: later(-120) };
const parkedCard: Proposal = {
  ...fx.proposal,
  id: 'pr-2',
  requestText: 'Build a billing service',
  kind: 'planet',
  proposedBody: { kind: 'planet', name: 'Billing' },
  state: 'parked',
  createdAt: later(-300),
  meta: {
    parked: {
      reason: 'no free planet',
      waitingFor: 'planet',
      occupied: [
        {
          bodyId: 'b-kepler',
          bodyName: 'Kepler',
          host: { kind: 'project', id: 'p-1' },
          occupant: 'Auth refactor',
          state: 'in_progress',
        },
      ],
      offers: ['downsize_moon', 'close_early'],
    },
  },
};
const planTask: Task = { ...fx.task, id: 't-a', description: 'parse the CSV', state: 'proposed' };
const planCard: Proposal = {
  ...fx.proposal,
  id: 'pr-plan',
  requestText: 'Two steps',
  createdAt: later(10),
  meta: { plan: { projectId: 'p-1', waykeeperId: 'a-waykeeper-1', taskIds: ['t-a'] } },
};

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
const calls: Call[] = [];
let replies: Record<string, { status: number; body: unknown }> = {};
const posts = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);

beforeEach(() => {
  calls.length = 0;
  replies = {};
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        ...(init?.body ? { body: JSON.parse(init.body as string) as unknown } : {}),
      });
      const reply = replies[`${method} ${url}`];
      if (reply) return new Response(JSON.stringify(reply.body), { status: reply.status });
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
      return new Response(JSON.stringify({ ok: true, seq: 11, state: 'approved' }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

let seq = 10;
/** Renders the panel and feeds it a snapshot with these questions and cards. */
async function open(questions: Question[], proposals: Proposal[] = []) {
  seq = 10;
  window.history.replaceState(null, '', '/');
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const snapshot: ServerMessage = {
    type: 'snapshot',
    logId: 'log-a',
    seq,
    agents: [fx.harmonizer, waykeeper, fx.agent],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [fx.project],
    tasks: [fx.task, fx.asteroidTask, planTask],
    questions,
    proposals,
    statuses: [working('a-harmonizer'), working('a-waykeeper-1'), working('a-steward-1')],
  };
  await act(async () => {
    FakeWebSocket.instances[0]!.serverOpens();
    FakeWebSocket.instances[0]!.serverSends(snapshot);
  });
}

/** The stream delivers one committed event. */
async function stream(event: Event) {
  seq += 1;
  await act(async () => {
    FakeWebSocket.instances[0]!.serverSends({ type: 'event', seq, at: later(seq), event });
  });
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const inbox = () => screen.getByRole('region', { name: 'question inbox' });
const waiting = () => within(inbox()).getByRole('region', { name: 'Waiting for you' });

/** A chat thread elsewhere on the page (P25-03's), rendering the same exported card by id. */
function renderThread(children: React.ReactNode) {
  return render(
    <ApiContext.Provider value={createApi('tok')}>
      <CardLinksContext.Provider value={true}>
        <section aria-label="thread">{children}</section>
      </CardLinksContext.Provider>
    </ApiContext.Provider>,
  );
}
const thread = () => screen.getByRole('region', { name: 'thread' });

describe('panel inbox (P25-06)', () => {
  it('lists blocked-on-user items first: permissions, clarifications, then cards', async () => {
    await open(
      [supervisorAnswered, supervisorHeld, clarification, permission],
      [parkedCard, card, planCard],
    );
    const groups = Array.from(inbox().querySelectorAll('.pnl-inbox-group')).map((g) =>
      g.getAttribute('aria-label'),
    );
    expect(groups).toEqual([
      'Waiting for you',
      'Parked — no free body',
      'Held by supervisors',
      'Answered by supervisors',
    ]);
    const cards = Array.from(waiting().querySelectorAll('article')).map((a) =>
      a.getAttribute('aria-label'),
    );
    expect(cards).toEqual([
      'permission question Run `git push origin task/t-1`?',
      'clarification question Keep the legacy cookie name?',
      'proposal Add dark mode to the settings page',
      'plan Two steps',
    ]);
    expect(within(inbox()).getByText('4 waiting for you')).toBeTruthy();
  });

  it('shows kind, holder, origin agent, task and body, and opens the agent', async () => {
    await open([clarification]);
    const el = within(waiting()).getByLabelText(
      'clarification question Keep the legacy cookie name?',
    );
    expect(within(el).getByText('clarification')).toBeTruthy();
    expect(within(el).getByText('held by you')).toBeTruthy();
    expect(el.textContent).toMatch(
      /from Steward · Replace the session middleware.*task "Replace the session middleware" · project Auth refactor · on Luna/,
    );
    expect(within(el).getByRole('button', { name: 'yes' })).toBeTruthy();
    await click(
      within(el).getByRole('link', { name: 'open Steward · Replace the session middleware' }),
    );
    expect(useAppStore.getState().selection).toEqual({ kind: 'steward', id: 'a-steward-1' });
    expect(window.location.pathname).toBe('/steward/a-steward-1');
  });

  it('answering in the inbox resolves the question in the chat thread too', async () => {
    await open([clarification]);
    renderThread(<QuestionView questionId="q-1" />);
    // Both places show the same open question.
    expect(
      within(thread()).getByLabelText('clarification question Keep the legacy cookie name?'),
    ).toBeTruthy();

    const el = within(waiting()).getByLabelText(
      'clarification question Keep the legacy cookie name?',
    );
    await click(within(el).getByRole('button', { name: 'yes' }));
    await flush();
    expect(posts('/api/questions/q-1/answer').map((c) => c.body)).toEqual([
      { answer: 'yes', version: 3 },
    ]);

    // The server commits the answer; the stream carries it to the store, and from there everywhere.
    await stream({
      type: 'question.answered',
      questionId: 'q-1',
      answer: 'yes',
      answeredBy: { type: 'user' },
      version: 4,
    });
    expect(useAppStore.getState().world.questions['q-1']).toMatchObject({
      status: 'answered',
      answer: 'yes',
    });
    expect(within(waiting()).getByText('Nothing waits for you.')).toBeTruthy();
    const answered = within(thread()).getByLabelText(
      'answered question Keep the legacy cookie name?',
    );
    expect(answered.textContent).toMatch(/you answered: “yes”/);
    expect(within(thread()).queryByLabelText('answer')).toBeNull();
    expect(within(thread()).queryByLabelText('override')).toBeNull(); // the user's own answer
    expect(screen.getByLabelText('summary').textContent).not.toMatch(/waiting/);
  });

  it('an answer in the thread leaves the inbox too', async () => {
    await open([clarification]);
    renderThread(<QuestionView questionId="q-1" />);
    fireEvent.change(within(thread()).getByLabelText('answer'), { target: { value: 'rename it' } });
    await click(within(thread()).getByRole('button', { name: 'Answer' }));
    await flush();
    expect(posts('/api/questions/q-1/answer')[0]?.body).toEqual({
      answer: 'rename it',
      version: 3,
    });
    await stream({
      type: 'question.answered',
      questionId: 'q-1',
      answer: 'rename it',
      answeredBy: { type: 'user' },
      version: 4,
    });
    expect(within(inbox()).queryByLabelText(/clarification question/)).toBeNull();
  });

  it('says "already answered by …" on a stale answer, in the inbox and in the thread', async () => {
    await open([clarification]);
    renderThread(<QuestionView questionId="q-1" />);
    replies['POST /api/questions/q-1/answer'] = {
      status: 409,
      body: { error: 'stale', message: 'question q-1 was already answered by agent a-waykeeper-1' },
    };
    // The user answers in both places before the stream catches up.
    fireEvent.change(within(waiting()).getByLabelText('answer'), { target: { value: 'no' } });
    await click(within(waiting()).getByRole('button', { name: 'Answer' }));
    await click(within(thread()).getByRole('button', { name: 'no' }));
    await flush();
    expect(posts('/api/questions/q-1/answer').map((c) => c.body)).toEqual([
      { answer: 'no', version: 3 },
      { answer: 'no', version: 3 },
    ]);
    // Meanwhile the Waykeeper answered it from context.
    await stream({
      type: 'question.answered',
      questionId: 'q-1',
      answer: 'yes',
      answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
      version: 4,
    });
    const said = /Not sent: already answered by Waykeeper · Auth refactor: "yes"/;
    expect(within(inbox()).getAllByRole('alert')[0]!.textContent).toMatch(said);
    expect(within(thread()).getByRole('alert').textContent).toMatch(said);
    // The thread's card is now the read-only answered card, with the Override (decision 48).
    expect(within(thread()).getByLabelText('override')).toBeTruthy();
    // And the inbox lists it under the supervisors' answers.
    expect(
      within(inbox()).getByRole('region', { name: 'Answered by supervisors' }).textContent,
    ).toMatch(/Waykeeper · Auth refactor answered: “yes”/);
  });

  it('shows a permission card with the action and the tool call; allow and refuse', async () => {
    await open([permission]);
    const el = within(waiting()).getByLabelText(
      'permission question Run `git push origin task/t-1`?',
    );
    expect(within(el).getByText('push:')).toBeTruthy();
    expect(within(el).getByText(/Bash .*git push origin task\/t-1/)).toBeTruthy();
    expect(within(el).queryByLabelText('answer')).toBeNull();
    await click(within(el).getByRole('button', { name: 'Allow' }));
    await click(within(el).getByRole('button', { name: 'Refuse' }));
    await flush();
    expect(posts('/api/questions/q-2/answer').map((c) => c.body)).toEqual([
      { answer: 'allow', version: 0 },
      { answer: 'no', version: 0 },
    ]);
  });

  it('shows supervisor-held questions answerable and supervisor answers read-only with Override', async () => {
    await open([supervisorHeld, supervisorAnswered]);
    const held = within(inbox()).getByRole('region', { name: 'Held by supervisors' });
    expect(within(held).getByText('held by Waykeeper · Auth refactor')).toBeTruthy();
    expect(within(held).getByLabelText('answer')).toBeTruthy();
    const answered = within(inbox()).getByLabelText('answered question Tabs or spaces?');
    expect(answered.textContent).toMatch(/Waykeeper · Auth refactor answered: “spaces”/);
    fireEvent.change(within(answered).getByLabelText('override'), { target: { value: 'tabs' } });
    await click(within(answered).getByRole('button', { name: 'Override' }));
    await flush();
    expect(posts('/api/agents/a-waykeeper-1/send')[0]?.body).toEqual({
      text: 'Override of your answer to question q-4 ("Tabs or spaces?"): tabs',
      interrupt: false,
    });
  });
});

describe('proposal and plan cards (P25-06)', () => {
  it('approves, edits inline (size, body, workspace, git init, trust) and rejects with a reason', async () => {
    await open([], [card]);
    const el = within(waiting()).getByLabelText('proposal Add dark mode to the settings page');
    expect(within(el).getByLabelText('trust level').textContent).toMatch(/default/);
    await click(within(el).getByRole('button', { name: 'Approve' }));
    await click(within(el).getByRole('button', { name: 'Edit' }));
    const form = within(el).getByLabelText('edit card');
    fireEvent.change(within(form).getByLabelText('workspace'), { target: { value: '/w/dark' } });
    fireEvent.click(within(form).getByLabelText(/git init this folder/));
    fireEvent.change(within(form).getByLabelText('trust level'), { target: { value: 'cautious' } });
    await click(within(form).getByRole('button', { name: 'Save' }));
    fireEvent.change(within(el).getByLabelText('reason'), { target: { value: 'too big' } });
    await click(within(el).getByRole('button', { name: 'Reject' }));
    await flush();
    expect(posts('/api/proposals/pr-1/decide').map((c) => c.body)).toEqual([
      { decision: 'approve' },
      { decision: 'edit', changes: { workspace: '/w/dark', initGit: true, trust: 'cautious' } },
      { decision: 'reject', reason: 'too big' },
    ]);
  });

  it('shows a parked card with the occupied planets and the downsize / close-early offers', async () => {
    await open([], [parkedCard]);
    const el = within(inbox()).getByLabelText('proposal Build a billing service');
    expect(within(el).getByText(/no free planet/).textContent).toMatch(
      /resumes by itself when a planet frees/,
    );
    expect(within(el).getByLabelText('occupied bodies').textContent).toMatch(
      /Kepler: Auth refactor \(in progress\)/,
    );
    expect(within(el).getByText(/close a completed project early/)).toBeTruthy();
    await click(within(el).getByRole('button', { name: 'make it a moon project' }));
    await flush();
    expect(posts('/api/proposals/pr-2/decide')[0]?.body).toEqual({
      decision: 'edit',
      changes: { kind: 'moon', proposedBody: { kind: 'moon', name: 'Billing' } },
    });
  });

  it('a plan card: approve, edit through its tasks, reject; read-only once approved', async () => {
    await open([], [planCard]);
    renderThread(<ProposalView proposalId="pr-plan" />);
    const el = within(waiting()).getByLabelText('plan Two steps');
    expect(within(el).getByText('Plan for Auth refactor')).toBeTruthy();
    expect(within(el).queryByLabelText('edit card')).toBeNull();
    expect(within(el).getByLabelText('controls of parse the CSV')).toBeTruthy();
    await click(within(el).getByRole('button', { name: 'Approve plan' }));
    await flush();
    expect(posts('/api/proposals/pr-plan/decide')[0]?.body).toEqual({ decision: 'approve' });
    await stream({ type: 'proposal.approved', proposalId: 'pr-plan' });
    // The inbox no longer waits on it; the thread's card turned read-only.
    expect(within(inbox()).queryByLabelText('plan Two steps')).toBeNull();
    const approved = within(thread()).getByLabelText('plan Two steps');
    expect(approved.textContent).toMatch(/approved.*Plan for Auth refactor.*1 tasks/);
    expect(within(approved).queryByRole('button')).toBeNull();
  });
});
