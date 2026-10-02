// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Body,
  Project,
  Proposal,
  Question,
  ServerMessage,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import { PERMISSION_POLICY_PRESETS } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { useAppStore } from '../../state/store.js';
import { HierarchyConsole } from './HierarchyConsole.js';

/** P2-18: each part of the hierarchy console against a mocked `/api` and a hand-fed store. */

interface Call {
  method: string;
  url: string;
  body?: unknown;
}
const calls: Call[] = [];
/** Replies by `METHOD url`; the default is `{ok: true}`. */
let replies: Record<string, { status: number; body: unknown }> = {};
const subscribed: string[] = [];

const NOW = fx.NOW;
const later = (s: number) => new Date(Date.parse(NOW) + s * 1000).toISOString();

const { taskId: _taskId, ...agentBase } = fx.agent;
const waykeeper: Agent = {
  ...agentBase,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
};
const { answer: _answer, answeredBy: _by, ...permissionBase } = fx.permissionQuestion;
const steward: Agent = fx.agent; // a-steward-1 on t-1
const status = (agentId: string, state: StatusRecord['state'] = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});
const kepler: Body = { ...fx.body };
const mars: Body = { id: 'b-mars', kind: 'planet', name: 'Mars' };
const titan: Body = { id: 'b-titan', kind: 'moon', parentId: 'b-saturn', name: 'Titan' };

function seed(
  extra: {
    projects?: Project[];
    tasks?: Task[];
    proposals?: Proposal[];
    questions?: Question[];
    agents?: Agent[];
    statuses?: StatusRecord[];
  } = {},
) {
  const snapshot: ServerMessage = {
    type: 'snapshot',
    logId: 'log-1',
    seq: 10,
    bodies: [kepler, fx.moon, fx.asteroid, mars, titan],
    projects: extra.projects ?? [fx.project],
    tasks: extra.tasks ?? [fx.task, fx.asteroidTask],
    agents: extra.agents ?? [fx.harmonizer, waykeeper, steward],
    questions: extra.questions ?? [],
    proposals: extra.proposals ?? [],
    statuses: extra.statuses ?? [
      status('a-harmonizer', 'idle'),
      status('a-waykeeper-1', 'idle'),
      status('a-steward-1'),
    ],
  };
  act(() => useAppStore.getState().apply(snapshot));
}

beforeEach(() => {
  calls.length = subscribed.length = 0;
  replies = {};
  useAppStore.getState().reset();
  useAppStore.setState({
    status: 'live',
    subscribeTranscript: (id) => subscribed.push(id),
    unsubscribeTranscript: () => {},
  });
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
});

const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === path);
const flush = () => act(async () => {});
/** A click, then the action it started settles (a widget runs one action at a time). */
const click = async (el: Element) => {
  fireEvent.click(el);
  await flush();
};
const ui = () => render(<HierarchyConsole token="t" />);

describe('project/task tree (P2-18)', () => {
  it('shows projects with their tasks, agents and derived states, and the summary counts', async () => {
    seed({
      questions: [
        { ...fx.question, holder: { type: 'user' } },
        { ...fx.question, id: 'q-3' }, // held by the Waykeeper
      ],
    });
    ui();
    await flush();
    const summary = screen.getByLabelText('summary');
    expect(summary.textContent).toMatch(/open questions 2/);
    expect(summary.textContent).toMatch(/waiting for you 1/);
    expect(summary.textContent).toMatch(/blocked 1/); // the asteroid task is blocked on the user
    const project = screen.getByLabelText('project Auth refactor');
    expect(project.querySelector('.node-head')?.textContent).toMatch(/^in progressAuth refactor/);
    expect(within(project).getByText(/Waykeeper · Auth refactor/)).toBeTruthy();
    const task = within(project).getByLabelText('task Replace the session middleware');
    expect(within(task).getByText(/Steward · Replace the session middleware/)).toBeTruthy();
    const standalone = screen.getByLabelText('task Fix the flaky date test');
    expect(within(standalone).getByText('blocked on user')).toBeTruthy();
    expect(within(standalone).getByText(/asteroid Ceres-1/)).toBeTruthy();
  });

  it('sends control actions: pause, close, pin, edit, and reopen for finished work', async () => {
    seed({
      projects: [fx.project, { ...fx.project, id: 'p-2', name: 'Done thing', state: 'completed' }],
    });
    ui();
    await flush();
    const controls = screen.getByLabelText('controls of Auth refactor');
    await click(within(controls).getByText('Pause'));
    await click(within(controls).getByText('Close'));
    await click(within(controls).getByText('Pin'));
    await flush();
    const done = screen.getByLabelText('controls of Done thing');
    expect(within(done).queryByText('Pause')).toBeNull();
    await click(within(done).getByText('Reopen'));
    await click(within(done).getByText('Archive now'));
    await flush();
    const taskControls = screen.getByLabelText('controls of Replace the session middleware');
    await click(within(taskControls).getByText('Edit'));
    fireEvent.change(within(taskControls).getByDisplayValue('normal'), {
      target: { value: 'urgent' },
    });
    await click(within(taskControls).getByText('Save'));
    await flush();
    expect(posts('/api/control').map((c) => c.body)).toEqual([
      { target: { kind: 'project', id: 'p-1' }, action: { action: 'pause' } },
      { target: { kind: 'project', id: 'p-1' }, action: { action: 'close' } },
      { target: { kind: 'project', id: 'p-1' }, action: { action: 'pin', pinned: true } },
      { target: { kind: 'project', id: 'p-2' }, action: { action: 'reopen' } },
      { target: { kind: 'project', id: 'p-2' }, action: { action: 'archive' } },
      {
        target: { kind: 'task', id: 't-1' },
        action: { action: 'edit', changes: { priority: 'urgent' } },
      },
    ]);
  });

  it('shows a refused control action under its buttons', async () => {
    seed();
    replies['POST /api/control'] = {
      status: 409,
      body: { error: 'rejected', message: 'project p-1 has an active sub-project' },
    };
    ui();
    await flush();
    const controls = screen.getByLabelText('controls of Auth refactor');
    await click(within(controls).getByText('Close'));
    await flush();
    expect(within(controls).getByRole('alert').textContent).toMatch(/active sub-project/);
  });

  it("edits a project's permission policy with a preset or back to the global default", async () => {
    seed();
    ui();
    await flush();
    const controls = screen.getByLabelText('controls of Auth refactor');
    await click(within(controls).getByText('Edit'));
    fireEvent.change(within(controls).getByDisplayValue('unchanged (default)'), {
      target: { value: 'clear' },
    });
    await click(within(controls).getByText('Save'));
    await flush();
    expect(posts('/api/control')[0]?.body).toEqual({
      target: { kind: 'project', id: 'p-1' },
      action: { action: 'edit', changes: { permissionPolicy: null } },
    });
  });

  it("shows each project's trust level and makes a project trusted from its edit form (P2-22)", async () => {
    seed({
      projects: [
        fx.project,
        {
          ...fx.project,
          id: 'p-2',
          name: 'Trusted thing',
          permissionPolicy: PERMISSION_POLICY_PRESETS.trusted,
        },
        {
          ...fx.project,
          id: 'p-3',
          name: 'Odd thing',
          permissionPolicy: { rules: { push: 'deny' } },
        },
      ],
    });
    ui();
    await flush();
    const trustOf = (name: string) =>
      within(screen.getByLabelText(`project ${name}`)).getAllByLabelText('trust level')[0]!
        .textContent;
    expect(trustOf('Auth refactor')).toBe('trust: default');
    expect(trustOf('Trusted thing')).toBe('trust: trusted');
    expect(trustOf('Odd thing')).toBe('trust: custom');
    const controls = screen.getByLabelText('controls of Auth refactor');
    await click(within(controls).getByText('Edit'));
    const select = within(controls).getByLabelText('trust level');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['', 'clear', 'default', 'trusting', 'cautious', 'trusted']);
    fireEvent.change(select, { target: { value: 'trusted' } });
    await click(within(controls).getByText('Save'));
    await flush();
    expect(posts('/api/control')[0]?.body).toEqual({
      target: { kind: 'project', id: 'p-1' },
      action: { action: 'edit', changes: { permissionPolicy: PERMISSION_POLICY_PRESETS.trusted } },
    });
  });
});

describe('proposal cards (P2-18)', () => {
  const card: Proposal = {
    ...fx.proposal,
    meta: { request: { type: 'new_project', name: 'Dark mode' } },
  };

  it('approves, rejects with a reason, and edits size, body, workspace and the git consent', async () => {
    seed({ proposals: [card] });
    ui();
    await flush();
    const el = screen.getByLabelText('proposal Add dark mode to the settings page');
    expect(within(el).getByText('new project')).toBeTruthy();
    await click(within(el).getByText('Approve'));
    fireEvent.change(within(el).getByLabelText('reason'), { target: { value: 'not now' } });
    await click(within(el).getByText('Reject'));
    await click(within(el).getByText('Edit'));
    const form = within(el).getByLabelText('edit card');
    fireEvent.change(within(form).getByDisplayValue('moon'), { target: { value: 'planet' } });
    // Only free bodies of the chosen size are offered (Kepler and Mars host nothing; Luna does).
    const options = within(form)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Kepler', 'Mars']));
    expect(options).not.toContain('Luna');
    fireEvent.change(within(form).getByDisplayValue('any free planet'), {
      target: { value: 'b-mars' },
    });
    fireEvent.change(within(form).getByDisplayValue('/home/cosmin/work/auth'), {
      target: { value: '/home/cosmin/work/dark' },
    });
    await click(within(form).getByRole('checkbox'));
    await click(within(form).getByText('Save'));
    await flush();
    expect(posts('/api/proposals/pr-1/decide').map((c) => c.body)).toEqual([
      { decision: 'approve' },
      { decision: 'reject', reason: 'not now' },
      {
        decision: 'edit',
        changes: {
          kind: 'planet',
          proposedBody: { kind: 'planet', name: 'Mars', bodyId: 'b-mars' },
          workspace: '/home/cosmin/work/dark',
          initGit: true,
        },
      },
    ]);
    // A saved edit closes the form.
    expect(within(el).queryByLabelText('edit card')).toBeNull();
  });

  it('shows the trust level on the card and lets the user choose it (P2-22)', async () => {
    seed({
      proposals: [
        card,
        {
          ...card,
          id: 'pr-2',
          requestText: 'Trusted one',
          meta: { ...card.meta, trust: 'trusted' },
        },
      ],
    });
    ui();
    await flush();
    const el = screen.getByLabelText('proposal Add dark mode to the settings page');
    expect(within(el).getByLabelText('trust level').textContent).toMatch(/^default/);
    const other = screen.getByLabelText('proposal Trusted one');
    expect(within(other).getByLabelText('trust level').textContent).toMatch(
      /^trusted — everything without a card except a push/,
    );
    await click(within(el).getByText('Edit'));
    const form = within(el).getByLabelText('edit card');
    const select = within(form).getByLabelText('trust level');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['default', 'trusting', 'cautious', 'trusted']);
    fireEvent.change(select, { target: { value: 'trusted' } });
    await click(within(form).getByText('Save'));
    await flush();
    expect(posts('/api/proposals/pr-1/decide').map((c) => c.body)).toEqual([
      { decision: 'edit', changes: { trust: 'trusted' } },
    ]);
  });

  it('offers no trust level for standalone work on an asteroid', async () => {
    seed({
      proposals: [
        { ...card, kind: 'asteroid', proposedBody: { kind: 'asteroid', name: 'Ceres-9' } },
      ],
    });
    ui();
    await flush();
    const el = screen.getByLabelText('proposal Add dark mode to the settings page');
    expect(within(el).queryByLabelText('trust level')).toBeNull();
    await click(within(el).getByText('Edit'));
    expect(
      within(within(el).getByLabelText('edit card')).queryByLabelText('trust level'),
    ).toBeNull();
  });

  it('shows a parked card with the occupied bodies and the offers', async () => {
    seed({
      proposals: [
        {
          ...card,
          kind: 'planet',
          proposedBody: { kind: 'planet', name: 'Dark mode' },
          state: 'parked',
          meta: {
            ...card.meta,
            parked: {
              reason: 'no free planet',
              waitingFor: 'planet',
              occupied: [
                {
                  bodyId: 'b-kepler',
                  bodyName: 'Kepler',
                  host: { kind: 'project', id: 'p-2' },
                  occupant: 'Old app',
                  state: 'completed',
                },
              ],
              offers: ['downsize_moon', 'close_early'],
            },
          },
        },
      ],
      projects: [fx.project, { ...fx.project, id: 'p-2', name: 'Old app', state: 'completed' }],
    });
    ui();
    await flush();
    const el = screen.getByLabelText('proposal Add dark mode to the settings page');
    expect(within(el).getByText(/resumes by itself when a planet frees/)).toBeTruthy();
    const occupied = within(el).getByLabelText('occupied bodies');
    expect(occupied.textContent).toMatch(/Kepler: Old app \(completed\)/);
    expect(within(el).getByText(/close a completed project early/)).toBeTruthy();
    await click(within(el).getByText('make it a moon project'));
    // Closing the completed occupant early, from the card.
    await click(within(occupied).getByText('Archive now'));
    await flush();
    expect(posts('/api/proposals/pr-1/decide')[0]?.body).toEqual({
      decision: 'edit',
      changes: { kind: 'moon', proposedBody: { kind: 'moon', name: 'Dark mode' } },
    });
    expect(posts('/api/control')[0]?.body).toEqual({
      target: { kind: 'project', id: 'p-2' },
      action: { action: 'archive' },
    });
  });

  it('shows a plan card with its tasks: approve or reject the whole, edit or drop a task', async () => {
    const tasks: Task[] = [
      { ...fx.task, id: 't-a', description: 'parse the CSV', state: 'proposed' },
      { ...fx.task, id: 't-b', description: 'write Parquet', state: 'proposed', priority: 'high' },
    ];
    seed({
      tasks,
      proposals: [
        {
          ...fx.proposal,
          id: 'pr-plan',
          requestText: 'Two steps',
          meta: {
            plan: { projectId: 'p-1', waykeeperId: 'a-waykeeper-1', taskIds: ['t-a', 't-b'] },
          },
        },
      ],
    });
    ui();
    await flush();
    const el = screen.getByLabelText('plan Two steps');
    expect(within(el).getByText('Plan for Auth refactor')).toBeTruthy();
    expect(within(el).getByText(/by Waykeeper · Auth refactor/)).toBeTruthy();
    expect(within(el).getByText(/write Parquet/).textContent).toMatch(/\(high\)/);
    // A plan is not edited as a card: no card edit form.
    expect(within(el).queryByLabelText('edit card')).toBeNull();
    await click(within(el).getByText('Approve plan'));
    const first = within(el).getByLabelText('controls of parse the CSV');
    await click(within(first).getByText('Cancel'));
    await click(within(el).getByText('Reject'));
    await flush();
    expect(posts('/api/proposals/pr-plan/decide').map((c) => c.body)).toEqual([
      { decision: 'approve' },
      { decision: 'reject' },
    ]);
    expect(posts('/api/control')[0]?.body).toEqual({
      target: { kind: 'task', id: 't-a' },
      action: { action: 'cancel' },
    });
  });
});

describe('question inbox (P2-18)', () => {
  it('answers a user-held clarification inline with its version', async () => {
    seed({ questions: [{ ...fx.question, holder: { type: 'user' }, version: 3 }] });
    ui();
    await flush();
    const inbox = screen.getByLabelText('question inbox');
    const card = within(inbox).getByLabelText(
      'clarification question Keep the legacy cookie name?',
    );
    expect(within(card).getByText('held by you')).toBeTruthy();
    expect(within(card).getByText(/from Steward · Replace the session middleware/)).toBeTruthy();
    expect(within(card).getByText(/project Auth refactor/)).toBeTruthy();
    await click(within(card).getByText('yes'));
    await flush();
    expect(posts('/api/questions/q-1/answer')[0]?.body).toEqual({ answer: 'yes', version: 3 });
  });

  it('says who answered first when an answer is stale', async () => {
    seed({ questions: [{ ...fx.question, holder: { type: 'user' } }] });
    replies['POST /api/questions/q-1/answer'] = {
      status: 409,
      body: { error: 'stale', message: 'question q-1 was already answered by agent a-waykeeper-1' },
    };
    ui();
    await flush();
    fireEvent.change(screen.getByLabelText('answer'), { target: { value: 'no' } });
    await click(screen.getByText('Answer'));
    await flush();
    // Meanwhile the stream says the Waykeeper answered it.
    act(() =>
      useAppStore.getState().apply({
        type: 'event',
        seq: 11,
        at: later(1),
        event: {
          type: 'question.answered',
          questionId: 'q-1',
          answer: 'yes',
          answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
          version: 1,
        },
      }),
    );
    const inbox = screen.getByLabelText('question inbox');
    expect(within(inbox).getAllByRole('alert')[0]!.textContent).toMatch(
      /Not sent: already answered by Waykeeper · Auth refactor: "yes"/,
    );
  });

  it('shows a permission card with the tool call and the action; allow and refuse', async () => {
    seed({
      questions: [{ ...permissionBase, status: 'open', version: 0 }],
    });
    ui();
    await flush();
    const card = screen.getByLabelText('permission question Run `git push origin task/t-1`?');
    expect(within(card).getByText('push:')).toBeTruthy();
    expect(within(card).getByText(/Bash .*git push origin task\/t-1/)).toBeTruthy();
    expect(within(card).queryByLabelText('answer')).toBeNull();
    await click(within(card).getByText('Allow'));
    await click(within(card).getByText('Refuse'));
    await flush();
    expect(posts('/api/questions/q-2/answer').map((c) => c.body)).toEqual([
      { answer: 'allow', version: 0 },
      { answer: 'no', version: 0 },
    ]);
  });

  it('lists clarifications held by supervisors read-only, still answerable by the user', async () => {
    seed({ questions: [fx.question] });
    ui();
    await flush();
    const inbox = screen.getByLabelText('question inbox');
    expect(within(inbox).getByText('Nothing waits for you.')).toBeTruthy();
    expect(within(inbox).getByText('Held by supervisors (1)')).toBeTruthy();
    expect(within(inbox).getByText('held by Waykeeper · Auth refactor')).toBeTruthy();
  });

  it("shows a supervisor's answer read-only with an override that tells that supervisor", async () => {
    seed({
      questions: [
        {
          ...fx.question,
          status: 'answered',
          answer: 'yes',
          answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
          version: 1,
        },
      ],
    });
    ui();
    await flush();
    const card = screen.getByLabelText('answered question Keep the legacy cookie name?');
    expect(card.textContent).toMatch(/Waykeeper · Auth refactor answered: “yes”/);
    fireEvent.change(within(card).getByLabelText('override'), {
      target: { value: 'rename it to sid' },
    });
    await click(within(card).getByText('Override'));
    await flush();
    expect(posts('/api/agents/a-waykeeper-1/send')[0]?.body).toEqual({
      text: 'Override of your answer to question q-1 ("Keep the legacy cookie name?"): rename it to sid',
      interrupt: false,
    });
    expect(within(card).getByText(/sent to Waykeeper/)).toBeTruthy();
  });
});

describe('chat boxes (P2-18)', () => {
  it("shows the Harmonizer's conversation: history, live messages and its replies, by time", async () => {
    seed();
    replies['GET /api/agents/a-harmonizer/messages'] = {
      status: 200,
      body: {
        messages: [
          {
            messageId: 'm-0',
            agentId: 'a-harmonizer',
            seq: 3,
            at: later(1),
            sender: { type: 'user' },
            text: 'Start a new project: a CSV to Parquet CLI',
          },
        ],
      },
    };
    ui();
    await flush();
    expect(subscribed).toContain('a-harmonizer');
    act(() => {
      const s = useAppStore.getState();
      s.apply({
        type: 'transcript',
        agentId: 'a-harmonizer',
        chunks: [
          {
            agentId: 'a-harmonizer',
            seq: 1,
            at: later(2),
            kind: 'text',
            text: 'Proposed a planet.',
          },
          { agentId: 'a-harmonizer', seq: 2, at: later(2), kind: 'tool', text: 'propose {…}' },
        ],
      });
      s.apply({
        type: 'event',
        seq: 12,
        at: later(3),
        event: {
          type: 'message.sent',
          messageId: 'm-1',
          agentId: 'a-harmonizer',
          sender: { type: 'agent', id: 'a-waykeeper-1' },
          text: 'Plan approved, two Stewards running.',
          interrupt: false,
        },
      });
    });
    const chat = screen.getByLabelText('chat with Harmonizer');
    const lines = within(chat).getByRole('log').querySelectorAll('.chat-line');
    expect([...lines].map((l) => l.textContent)).toEqual([
      'you: Start a new project: a CSV to Parquet CLI',
      'Harmonizer: Proposed a planet.',
      'Waykeeper · Auth refactor: Plan approved, two Stewards running.',
    ]);
    fireEvent.change(within(chat).getByLabelText('message to Harmonizer'), {
      target: { value: 'how is it going?' },
    });
    await click(within(chat).getByText('Send'));
    await flush();
    expect(posts('/api/agents/a-harmonizer/send')[0]?.body).toEqual({
      text: 'how is it going?',
      interrupt: false,
    });
  });

  it('reads the history again after a snapshot catch-up (a reconnect)', async () => {
    seed();
    ui();
    await flush();
    const fetched = () => calls.filter((c) => c.url === '/api/agents/a-harmonizer/messages');
    expect(fetched()).toHaveLength(1);
    // While the page was away a line reached the Harmonizer; the reconnect took a snapshot.
    replies['GET /api/agents/a-harmonizer/messages'] = {
      status: 200,
      body: {
        messages: [
          {
            messageId: 'm-away',
            agentId: 'a-harmonizer',
            seq: 11,
            at: later(1),
            sender: { type: 'user' },
            text: 'sent from the phone',
          },
        ],
      },
    };
    seed();
    await flush();
    expect(fetched()).toHaveLength(2);
    const chat = screen.getByLabelText('chat with Harmonizer');
    expect(within(chat).getByText(/sent from the phone/)).toBeTruthy();
  });

  it("opens a Waykeeper's chat from the tree", async () => {
    seed();
    ui();
    await flush();
    await click(screen.getByRole('button', { name: /Waykeeper · Auth refactor/ }));
    await flush();
    const chat = screen.getByLabelText('chat with Waykeeper · Auth refactor');
    expect(within(chat).getByLabelText('message to Waykeeper · Auth refactor')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/agents/a-waykeeper-1/messages')).toBe(true);
  });
});

describe('Steward view (P2-18, decision 13)', () => {
  it('is read-only without an open clarification', async () => {
    seed();
    ui();
    await flush();
    await click(screen.getByRole('button', { name: /Steward · Replace the session middleware/ }));
    await flush();
    const view = screen.getByLabelText('view of Steward · Replace the session middleware');
    expect(subscribed).toContain('a-steward-1');
    expect(within(view).queryByRole('textbox')).toBeNull();
    expect(within(view).getByText(/Read-only/)).toBeTruthy();
    expect(within(view).getByText(/reports to Waykeeper · Auth refactor/)).toBeTruthy();
    act(() =>
      useAppStore.getState().apply({
        type: 'transcript',
        agentId: 'a-steward-1',
        chunks: [
          { agentId: 'a-steward-1', seq: 1, at: NOW, kind: 'thinking', text: 'Reading the code' },
        ],
      }),
    );
    expect(within(view).getByText('Reading the code')).toBeTruthy();
    await click(within(view).getByText('Pause'));
    await flush();
    expect(posts('/api/control')[0]?.body).toEqual({
      target: { kind: 'agent', id: 'a-steward-1' },
      action: { action: 'pause' },
    });
  });

  it('shows an answer box while it holds an open clarification question', async () => {
    seed({ questions: [{ ...fx.question, holder: { type: 'user' }, version: 2 }] });
    ui();
    await flush();
    await click(screen.getByRole('button', { name: /Steward · Replace the session middleware/ }));
    await flush();
    const view = screen.getByLabelText('view of Steward · Replace the session middleware');
    expect(within(view).queryByText(/Read-only/)).toBeNull();
    fireEvent.change(within(view).getByLabelText('answer'), { target: { value: 'keep it' } });
    await click(within(view).getByText('Answer'));
    await flush();
    expect(posts('/api/questions/q-1/answer')[0]?.body).toEqual({ answer: 'keep it', version: 2 });
  });
});
