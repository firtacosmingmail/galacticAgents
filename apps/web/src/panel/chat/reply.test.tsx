// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationEntry,
  ConversationQuery,
  ConversationResponse,
  EventEnvelope,
  Question,
  ReplyQuote,
  ReplyRef,
  ServerMessage,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useConversationStore } from '../../state/conversation.js';
import { useAppStore } from '../../state/store.js';
import { Conversation } from './Conversation.js';

/**
 * P8-17 (SPEC decision 139): replying to a line or a card of the chat — the Reply action, the
 * composer's quote bar (× and Esc cancel), the quote above a sent message, and the quote's jump
 * back to the original (paging back, or saying it is gone).
 */

const H = fx.harmonizer.id;
const at = (s: number) => new Date(Date.UTC(2026, 9, 14, 10, 0, s)).toISOString();

const message = (n: number, over: Partial<ConversationEntry> = {}): ConversationEntry => ({
  id: `m:msg-${n}`,
  agentId: H,
  kind: 'message',
  at: at(n),
  sender: { type: 'user' },
  text: `you said ${n}`,
  messageId: `msg-${n}`,
  seq: n,
  cursor: `c${n}`,
  ...over,
});
const reply = (n: number): ConversationEntry => ({
  id: `r:${H}:${n}`,
  agentId: H,
  kind: 'reply',
  at: at(n),
  sender: { type: 'agent', id: H },
  text: `brain said ${n}`,
  chunkSeq: n,
  cursor: `c${n}`,
});

const clarification: Question = {
  ...fx.question,
  id: 'q-clar',
  kind: 'clarification',
  originAgentId: H,
  holder: { type: 'user' },
  status: 'open',
  version: 3,
  context: { text: 'Which licence should it use?' },
  createdAt: at(5),
  updatedAt: at(5),
};

const snapshot = (questions: Question[] = []) =>
  ({
    type: 'snapshot',
    logId: 'log-a',
    seq: 100,
    agents: [fx.harmonizer],
    bodies: [fx.body],
    projects: [fx.project],
    tasks: [],
    questions,
    proposals: [],
    statuses: [{ ...fx.status, agentId: H }],
  }) as ServerMessage;

let seq = 100;
const event = (e: EventEnvelope['event'], when = at(50)) =>
  useAppStore.getState().apply({ type: 'event', seq: ++seq, at: when, event: e } as ServerMessage);

interface Sent {
  text: string;
  replyTo?: ReplyRef | undefined;
}

function fakeApi(
  pages: (q: ConversationQuery) => ConversationResponse,
  refuse?: () => Error | undefined,
) {
  const calls: ConversationQuery[] = [];
  const sent: Sent[] = [];
  const api = {
    conversation: async (_id: string, q: ConversationQuery = {}) => {
      calls.push(q);
      return pages(q);
    },
    send: async (_agentId: string, text: string, _interrupt: boolean, replyTo?: ReplyRef) => {
      const error = refuse?.();
      if (error) throw error;
      sent.push({ text, ...(replyTo ? { replyTo } : {}) });
      return { messageId: `msg-sent-${sent.length}` };
    },
    commands: async () => ({ commands: [] }),
    answer: async () => ({}),
  } as unknown as Api;
  return { api, calls, sent };
}

beforeEach(() => {
  seq = 100;
  useAppStore.getState().reset();
  useConversationStore.getState().reset();
  useAppStore.getState().apply(snapshot([clarification]));
  useAppStore.setState({
    status: 'live',
    subscribeTranscript: vi.fn(),
    unsubscribeTranscript: vi.fn(),
  });
});
afterEach(() => cleanup());

function show(api: Api) {
  return render(
    <ApiContext.Provider value={api}>
      <Conversation agentId={H} />
    </ApiContext.Provider>,
  );
}
const thread = () => screen.getByRole('log');
const box = () => screen.getByLabelText('message to Harmonizer') as HTMLTextAreaElement;
const replyingTo = () => screen.queryByRole('group', { name: 'replying to' });

describe('replying in the chat (P8-17)', () => {
  it('quotes an agent’s reply in the composer and sends the target with the message', async () => {
    const f = fakeApi(() => ({ entries: [message(1), reply(2)], hasMore: false, lastSeq: 2 }));
    const view = show(f.api);
    await screen.findByText('brain said 2');
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Harmonizer: brain said 2' }));
    const bar = replyingTo()!;
    expect(within(bar).getByText('Replying to Harmonizer')).toBeTruthy();
    expect(within(bar).getByText('brain said 2')).toBeTruthy();
    // The text box has the focus, ready to type.
    expect(document.activeElement).toBe(box());
    expect(blocking(await axeFindings(view.container))).toEqual([]);

    fireEvent.change(box(), { target: { value: 'why that one?' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]).toEqual({
      text: 'why that one?',
      replyTo: { kind: 'reply', id: `r:${H}:2` },
    });
    // Sent: the bar is gone and the pending line shows the quote.
    await waitFor(() => expect(replyingTo()).toBeNull());
    const pending = (await screen.findByText('sending…')).closest('.pnl-line') as HTMLElement;
    expect(
      within(pending).getByRole('button', { name: /^Quoted Harmonizer: brain said 2/ }),
    ).toBeTruthy();
  });

  it('cancels with × or Esc, and keeps the quote with the error on a refusal', async () => {
    let refusal: Error | undefined = new ApiError(
      400,
      'Message msg-1 is not in this chat.',
      'reply_target',
    );
    const f = fakeApi(
      () => ({ entries: [message(1)], hasMore: false, lastSeq: 0 }),
      () => refusal,
    );
    show(f.api);
    await screen.findByText('you said 1');
    const action = screen.getByRole('button', { name: 'Reply to your message: you said 1' });
    fireEvent.click(action);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel the reply' }));
    expect(replyingTo()).toBeNull();

    fireEvent.click(action);
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(replyingTo()).toBeNull();

    fireEvent.click(action);
    fireEvent.change(box(), { target: { value: 'again' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText(/is not in this chat/);
    expect(replyingTo()).not.toBeNull();
    expect(box().value).toBe('again');

    refusal = undefined;
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() =>
      expect(f.sent).toEqual([{ text: 'again', replyTo: { kind: 'message', id: 'msg-1' } }]),
    );
    await waitFor(() => expect(replyingTo()).toBeNull());
  });

  it('a reply to an open clarification carries its version and says it answers it', async () => {
    const f = fakeApi(() => ({ entries: [message(1), reply(9)], hasMore: false, lastSeq: 9 }));
    show(f.api);
    await screen.findByText('brain said 9');
    fireEvent.click(
      within(thread()).getByRole('button', {
        name: 'Reply to the question: Which licence should it use?',
      }),
    );
    const bar = replyingTo()!;
    expect(within(bar).getByText('Replying to Harmonizer · question')).toBeTruthy();
    expect(within(bar).getByText('Your reply answers this question.')).toBeTruthy();
    fireEvent.change(box(), { target: { value: 'MIT' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]?.replyTo).toMatchObject({ kind: 'question', id: 'q-clar', version: 3 });
    expect(f.sent[0]?.replyTo?.answerId).toEqual(expect.any(String));
  });

  it('shows a sent reply’s quote, marked answered, and jumps to the original', async () => {
    const quote: ReplyQuote = {
      kind: 'question',
      id: 'q-clar',
      sender: { type: 'agent', id: H },
      text: 'Which licence should it use?',
      answered: true,
    };
    const f = fakeApi(() => ({
      entries: [message(1), message(10, { replyTo: quote, text: 'MIT' })],
      hasMore: false,
      lastSeq: 0,
    }));
    const view = show(f.api);
    const jump = await screen.findByRole('button', {
      name: /^Quoted Harmonizer · question: Which licence should it use\?/,
    });
    expect(within(jump).getByText(/answered/)).toBeTruthy();
    const card = thread().querySelector('[data-card="q-clar"]') as HTMLElement;
    const scrolled = vi.fn();
    card.scrollIntoView = scrolled;
    fireEvent.click(jump);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(card.classList.contains('is-highlighted')).toBe(true);
    expect(document.activeElement).toBe(card);
    expect(blocking(await axeFindings(view.container))).toEqual([]);
  });

  it('pages back until it finds the original', async () => {
    const quote: ReplyQuote = {
      kind: 'message',
      id: 'msg-1',
      sender: { type: 'user' },
      text: 'you said 1',
    };
    const f = fakeApi((q) => {
      if (q.before === 'c20') return { entries: [message(10)], hasMore: true, lastSeq: 0 };
      if (q.before === 'c10') return { entries: [message(1)], hasMore: false, lastSeq: 0 };
      return {
        entries: [message(20), message(30, { replyTo: quote, text: 'and also' })],
        hasMore: true,
        lastSeq: 0,
      };
    });
    show(f.api);
    const jump = await screen.findByRole('button', { name: /^Quoted You: you said 1/ });
    fireEvent.click(jump);
    await screen.findByText('you said 1');
    await waitFor(() =>
      expect(
        (thread().querySelector('[data-entry="m:msg-1"]') as HTMLElement).classList.contains(
          'is-highlighted',
        ),
      ).toBe(true),
    );
    expect(f.calls.map((c) => c.before)).toEqual([undefined, 'c20', 'c10']);
    expect(screen.queryByText('The original is no longer in the history.')).toBeNull();
  });

  it('says when the original is no longer in the history', async () => {
    const quote: ReplyQuote = {
      kind: 'reply',
      id: `r:${H}:2`,
      sender: { type: 'agent', id: H },
      text: 'an old reply',
    };
    const f = fakeApi((q) =>
      q.before
        ? { entries: [message(1)], hasMore: false, lastSeq: 0 }
        : {
            entries: [message(10, { replyTo: quote, text: 'about it' })],
            hasMore: true,
            lastSeq: 0,
          },
    );
    show(f.api);
    fireEvent.click(
      await screen.findByRole('button', { name: /^Quoted Harmonizer: an old reply/ }),
    );
    expect(await screen.findByText('The original is no longer in the history.')).toBeTruthy();
  });

  it('a history page that fails ends the jump after one request, without calling it gone (review)', async () => {
    const quote: ReplyQuote = {
      kind: 'message',
      id: 'msg-1',
      sender: { type: 'user' },
      text: 'you said 1',
    };
    const f = fakeApi((q) => {
      if (q.before) throw new Error('offline');
      return {
        entries: [message(20, { replyTo: quote, text: 'and also' })],
        hasMore: true,
        lastSeq: 0,
      };
    });
    show(f.api);
    fireEvent.click(await screen.findByRole('button', { name: /^Quoted You: you said 1/ }));
    await screen.findByText(/History: offline/);
    await act(() => new Promise((r) => setTimeout(r, 150)));
    expect(f.calls.filter((c) => c.before !== undefined)).toHaveLength(1);
    expect(screen.queryByText('The original is no longer in the history.')).toBeNull();
  });

  it('a retry of a reply whose answer was recorded sends it as the same answer (review)', async () => {
    let refusal: Error | undefined = new ApiError(409, 'agent is stopping', 'rejected');
    const f = fakeApi(
      () => ({ entries: [reply(9)], hasMore: false, lastSeq: 9 }),
      () => refusal,
    );
    show(f.api);
    await screen.findByText('brain said 9');
    fireEvent.click(
      within(thread()).getByRole('button', {
        name: 'Reply to the question: Which licence should it use?',
      }),
    );
    fireEvent.change(box(), { target: { value: 'MIT' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    await screen.findByText(/agent is stopping/);
    // The answer had been recorded under the draft's key before the message failed.
    const answerId = useConversationStore.getState().replies[H]!.answerId;
    act(() =>
      event({
        type: 'question.answered',
        questionId: 'q-clar',
        answer: 'MIT',
        answeredBy: { type: 'user' },
        version: 4,
        answerId,
      }),
    );
    refusal = undefined;
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]!.replyTo).toEqual({ kind: 'question', id: 'q-clar', version: 4, answerId });
  });

  it('keeps ↑ history and slash completion working with a quote open', async () => {
    const f = fakeApi(() => ({ entries: [message(1), reply(2)], hasMore: false, lastSeq: 2 }));
    show(f.api);
    await screen.findByText('brain said 2');
    fireEvent.click(screen.getByRole('button', { name: 'Reply to Harmonizer: brain said 2' }));
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(box().value).toBe('you said 1');
    expect(replyingTo()).not.toBeNull();
  });

  it('a live message carries its quote into the thread', async () => {
    const f = fakeApi(() => ({ entries: [reply(2)], hasMore: false, lastSeq: 2 }));
    show(f.api);
    await screen.findByText('brain said 2');
    act(() =>
      event({
        type: 'message.sent',
        messageId: 'msg-live',
        agentId: H,
        sender: { type: 'user' },
        text: 'and then?',
        interrupt: false,
        replyTo: {
          kind: 'reply',
          id: `r:${H}:2`,
          sender: { type: 'agent', id: H },
          text: 'brain said 2',
        },
      }),
    );
    const line = thread().querySelector('[data-entry="m:msg-live"]') as HTMLElement;
    expect(
      within(line).getByRole('button', { name: /^Quoted Harmonizer: brain said 2/ }),
    ).toBeTruthy();
  });
});
