// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  ConversationEntry,
  ConversationQuery,
  ConversationResponse,
  EventEnvelope,
  Proposal,
  ServerMessage,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { conversationSince, useConversationStore } from '../../state/conversation.js';
import { useAppStore } from '../../state/store.js';
import { Conversation } from './Conversation.js';

const H = fx.harmonizer.id;
const at = (s: number) => new Date(Date.UTC(2026, 9, 2, 10, 0, s)).toISOString();

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: H,
};

const entry = (n: number, kind: 'message' | 'reply', agentId = H): ConversationEntry =>
  kind === 'message'
    ? {
        id: `m:msg-${n}`,
        agentId,
        kind,
        at: at(n),
        sender: { type: 'user' },
        text: `you said ${n}`,
        messageId: `msg-${n}`,
        seq: n,
        cursor: `c${n}`,
      }
    : {
        id: `r:${agentId}:${n}`,
        agentId,
        kind,
        at: at(n),
        sender: { type: 'agent', id: agentId },
        text: `brain said ${n}`,
        chunkSeq: n,
        cursor: `c${n}`,
      };

const snapshot = (extra: Partial<Extract<ServerMessage, { type: 'snapshot' }>> = {}) =>
  ({
    type: 'snapshot',
    logId: 'log-a',
    seq: 100,
    agents: [fx.harmonizer, waykeeper],
    bodies: [fx.body],
    projects: [fx.project],
    tasks: [],
    questions: [],
    proposals: [],
    statuses: [
      { ...fx.status, agentId: H },
      { ...fx.status, agentId: waykeeper.id },
    ],
    ...extra,
  }) as ServerMessage;

let seq = 100;
const event = (e: EventEnvelope['event'], when = at(50)) =>
  useAppStore.getState().apply({ type: 'event', seq: ++seq, at: when, event: e } as ServerMessage);

interface FakeApi {
  api: Api;
  calls: ConversationQuery[];
  sent: { agentId: string; text: string; interrupt: boolean }[];
  decided: { id: string; decision: unknown }[];
}

function fakeApi(pages: (q: ConversationQuery) => ConversationResponse): FakeApi {
  const calls: ConversationQuery[] = [];
  const sent: FakeApi['sent'] = [];
  const decided: FakeApi['decided'] = [];
  const api = {
    conversation: async (_id: string, q: ConversationQuery = {}) => {
      calls.push(q);
      return pages(q);
    },
    send: async (agentId: string, text: string, interrupt: boolean) => {
      sent.push({ agentId, text, interrupt });
      return { messageId: `msg-sent-${sent.length}` };
    },
    decide: async (id: string, decision: unknown) => {
      decided.push({ id, decision });
      return {};
    },
    answer: async () => ({}),
  } as unknown as Api;
  return { api, calls, sent, decided };
}

const subscribed: { agentId: string; since: number }[] = [];

beforeEach(() => {
  seq = 100;
  subscribed.length = 0;
  useAppStore.getState().reset();
  useConversationStore.getState().reset();
  useAppStore.getState().apply(snapshot());
  useAppStore.setState({
    status: 'live',
    // As the session does: the live transcript starts where the open chat's history ended.
    subscribeTranscript: (agentId) =>
      subscribed.push({ agentId, since: conversationSince(agentId) }),
    unsubscribeTranscript: vi.fn(),
  });
});
afterEach(() => cleanup());

function show(agentId: string, api: Api) {
  return render(
    <ApiContext.Provider value={api}>
      <Conversation agentId={agentId} />
    </ApiContext.Provider>,
  );
}
const thread = () => screen.getByRole('log');

describe('the panel chat (P25-03)', () => {
  it('merges the history with the live stream without duplicates or a gap at lastSeq', async () => {
    const f = fakeApi(() => ({
      entries: [entry(1, 'message'), entry(2, 'reply')],
      hasMore: false,
      lastSeq: 2,
    }));
    show(H, f.api);
    await screen.findByText('brain said 2');
    // The transcript stream is opened only after the page, from its lastSeq.
    await waitFor(() => expect(subscribed).toEqual([{ agentId: H, since: 2 }]));

    act(() => {
      // The stream repeats chunk 2 (already in the page) and brings 3; a tool chunk is not chat.
      useAppStore.getState().apply({
        type: 'transcript',
        agentId: H,
        chunks: [
          { agentId: H, seq: 2, at: at(2), kind: 'text', text: 'brain said 2' },
          { agentId: H, seq: 3, at: at(3), kind: 'tool', text: 'find_related_work' },
          { agentId: H, seq: 4, at: at(4), kind: 'text', text: 'brain said 4' },
        ],
      });
      // And the message from the page arrives live too (a reconnect replay).
      event(
        {
          type: 'message.sent',
          messageId: 'msg-1',
          agentId: H,
          sender: { type: 'user' },
          text: 'you said 1',
          interrupt: false,
        },
        at(1),
      );
      // The brain's turn prompt is logged as a system message, but it is not a chat line.
      event(
        {
          type: 'message.sent',
          messageId: 'msg-turn',
          agentId: H,
          sender: { type: 'system' },
          text: 'Since your last turn: the user said "you said 1"',
          interrupt: false,
          turn: true,
        },
        at(1),
      );
    });
    expect(within(thread()).queryByText(/Since your last turn/)).toBeNull();
    expect(within(thread()).getAllByText('brain said 2')).toHaveLength(1);
    expect(within(thread()).getAllByText('you said 1')).toHaveLength(1);
    expect(within(thread()).getByText('brain said 4')).toBeTruthy();
    expect(within(thread()).queryByText('find_related_work')).toBeNull();
    const order = [...thread().querySelectorAll('[data-entry]')].map((n) =>
      n.getAttribute('data-entry'),
    );
    expect(order).toEqual(['m:msg-1', `r:${H}:2`, `r:${H}:4`]);
  });

  it('pages back on demand', async () => {
    const f = fakeApi((q) =>
      q.before
        ? { entries: [entry(1, 'message'), entry(2, 'reply')], hasMore: false, lastSeq: 4 }
        : { entries: [entry(3, 'message'), entry(4, 'reply')], hasMore: true, lastSeq: 4 },
    );
    show(H, f.api);
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('you said 1');
    expect(f.calls).toEqual([{ limit: 50 }, { before: 'c3', limit: 50 }]);
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
    // Scrolling to the top pages back too (no layout in jsdom: just the handler).
    expect(within(thread()).getAllByText(/said/)).toHaveLength(4);
  });

  it('says when retention removed older replies (P8-02)', async () => {
    const f = fakeApi(() => ({
      entries: [entry(3, 'message'), entry(4, 'reply')],
      hasMore: false,
      lastSeq: 4,
      compacted: {
        throughSeq: 2,
        throughAt: '2026-06-01T10:00:00.000Z',
        removedAt: '2026-10-05T09:00:00.000Z',
        reason: 'archived',
      },
    }));
    show(H, f.api);
    const note = await within(thread()).findByRole('note');
    expect(note.textContent).toMatch(
      /^Replies removed on .*2026 by retention: this work was archived\. Messages are kept\.$/,
    );
  });

  it('catches up after a snapshot and starts over for another log', async () => {
    let pages = 0;
    const f = fakeApi((q) => {
      pages++;
      return q.after
        ? { entries: [entry(5, 'message')], hasMore: false, lastSeq: 4 }
        : { entries: [entry(4, 'reply')], hasMore: false, lastSeq: 4 };
    });
    show(H, f.api);
    await screen.findByText('brain said 4');
    act(() => useAppStore.getState().apply(snapshot()));
    await screen.findByText('you said 5');
    expect(f.calls.at(-1)).toEqual({ after: 'c4', limit: 200 });
    expect(pages).toBe(2);
  });

  it('reads the history again when the log changes (no lingering "Loading…")', async () => {
    const f = fakeApi(() =>
      f.calls.length > 1
        ? { entries: [entry(7, 'reply')], hasMore: false, lastSeq: 7 }
        : { entries: [entry(4, 'reply')], hasMore: false, lastSeq: 4 },
    );
    show(H, f.api);
    await screen.findByText('brain said 4');
    // A new database: the threads of the old log are dropped and the open chat reads the new one.
    act(() => useAppStore.getState().apply(snapshot({ logId: 'log-b' })));
    await screen.findByText('brain said 7');
    expect(within(thread()).queryByText('brain said 4')).toBeNull();
    expect(screen.queryByText(/Loading/)).toBeNull();
    // Opened again on the new log: loaded, with the live seam at the new page's lastSeq.
    await waitFor(() => expect(conversationSince(H)).toBe(7));
    expect(useConversationStore.getState().threads[H]?.loaded).toBe(true);
    expect(f.calls.every((c) => c.limit === 50 && !c.after && !c.before)).toBe(true);
  });

  it('sends to the selected brain and shows the line as sending until it arrives', async () => {
    const f = fakeApi(() => ({ entries: [], hasMore: false, lastSeq: 0 }));
    show(waykeeper.id, f.api);
    await screen.findByText(/No conversation yet/);
    const box = screen.getByLabelText('message to Waykeeper · Auth refactor');
    fireEvent.change(box, { target: { value: 'How is it going?' } });
    // Enter sends (Shift+Enter would be a new line).
    fireEvent.keyDown(box, { key: 'Enter' });
    await screen.findByText('sending…');
    expect(f.sent).toEqual([{ agentId: waykeeper.id, text: 'How is it going?', interrupt: false }]);
    expect((box as HTMLTextAreaElement).value).toBe('');

    act(() =>
      event({
        type: 'message.sent',
        messageId: 'msg-sent-1',
        agentId: waykeeper.id,
        sender: { type: 'user' },
        text: 'How is it going?',
        interrupt: false,
      }),
    );
    expect(screen.queryByText('sending…')).toBeNull();
    expect(within(thread()).getAllByText('How is it going?')).toHaveLength(1);
  });

  it('shows the work card the Harmonizer posted inline, with its actions', async () => {
    const f = fakeApi(() => ({
      entries: [entry(1, 'message'), entry(60, 'reply')],
      hasMore: false,
      lastSeq: 60,
    }));
    show(H, f.api);
    await screen.findByText('brain said 60');
    const card: Proposal = { ...fx.proposal, createdAt: at(30), updatedAt: at(30) };
    act(() => event({ type: 'proposal.created', proposal: card }, at(30)));
    const inline = await within(thread()).findByLabelText(`proposal ${card.requestText}`);
    // Between the request and the later reply.
    const order = [...thread().querySelectorAll('[data-entry], [data-card]')].map(
      (n) => n.getAttribute('data-entry') ?? n.getAttribute('data-card'),
    );
    expect(order).toEqual(['m:msg-1', 'pr-1', `r:${H}:60`]);
    fireEvent.click(within(inline).getByText('Approve'));
    await waitFor(() =>
      expect(f.decided).toEqual([{ id: 'pr-1', decision: { decision: 'approve' } }]),
    );
  });

  it('shows a Waykeeper its plan card and its Stewards’ status reports, not the Harmonizer’s cards', async () => {
    const steward: Agent = { ...fx.agent, supervisorId: waykeeper.id };
    const plan: Proposal = {
      ...fx.proposal,
      id: 'pr-plan',
      requestText: 'Two steps',
      meta: { plan: { projectId: 'p-1', waykeeperId: waykeeper.id, taskIds: ['t-1'] } },
    };
    useAppStore.getState().apply(
      snapshot({
        agents: [fx.harmonizer, waykeeper, steward],
        tasks: [{ ...fx.task, state: 'proposed' }],
        proposals: [plan, { ...fx.proposal, id: 'pr-work' }],
      }),
    );
    const f = fakeApi(() => ({
      entries: [
        {
          ...entry(1, 'message', waykeeper.id),
          sender: { type: 'agent', id: steward.id },
          text: 'Done: the session middleware.',
        },
      ],
      hasMore: false,
      lastSeq: 0,
    }));
    show(waykeeper.id, f.api);
    const planCard = await within(thread()).findByLabelText('plan Two steps');
    expect(within(planCard).getByText('Approve plan')).toBeTruthy();
    expect(within(thread()).queryByLabelText(`proposal ${fx.proposal.requestText}`)).toBeNull();
    const report = within(thread()).getByLabelText('status report');
    expect(
      within(report).getByRole('link', { name: /Steward · Replace the session/ }),
    ).toBeTruthy();

    // Approved: the card shows its compact approved card.
    act(() => event({ type: 'proposal.approved', proposalId: 'pr-plan' }));
    await waitFor(() =>
      expect(within(thread()).queryByRole('button', { name: 'Approve plan' })).toBeNull(),
    );
    expect(within(thread()).getByLabelText('plan Two steps')).toBeTruthy();
  });
});
