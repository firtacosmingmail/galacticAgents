// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Question,
  ServerMessage,
  TranscriptChunk,
  TranscriptResponse,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../../App.js';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';

const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};

const chunk = (seq: number, kind: TranscriptChunk['kind'], text: string): TranscriptChunk => ({
  agentId: 'a-steward-1',
  seq,
  at: `2026-09-30T10:00:${String(seq).padStart(2, '0')}.000Z`,
  kind,
  text,
});

const userClarification: Question = {
  ...fx.question,
  holder: { type: 'user' },
  version: 2,
};

function snapshot(questions: Question[] = []): ServerMessage {
  return {
    type: 'snapshot',
    logId: 'log-a',
    seq: 10,
    agents: [fx.harmonizer, waykeeper, fx.agent],
    bodies: [fx.body, fx.moon],
    projects: [fx.project],
    tasks: [fx.task],
    questions,
    proposals: [],
    statuses: [
      { ...fx.status, agentId: 'a-harmonizer' },
      { ...fx.status, agentId: waykeeper.id },
      fx.status,
    ],
  };
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

let calls: Call[];
/** Answers `GET …/transcript`; replace per test. */
let transcriptReply: (url: URL) => Promise<TranscriptResponse>;
/** Answers `POST /api/questions/:id/answer`; replace per test. */
let answerReply: () => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  calls = [];
  transcriptReply = async () => ({ chunks: [], hasMore: false, lastSeq: 0 });
  answerReply = () => json({ ok: true });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url: input,
        method,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      const url = new URL(input, 'http://localhost');
      if (url.pathname.endsWith('/transcript')) return json(await transcriptReply(url));
      if (url.pathname.endsWith('/answer')) return answerReply();
      if (url.pathname.endsWith('/messages')) return json({ messages: [] });
      if (url.pathname === '/api/control') return json({ ok: true, seq: 11 });
      return json({});
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(questions: Question[] = []) {
  window.history.replaceState(null, '', '/steward/a-steward-1');
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot(questions));
  });
  return socket;
}

const view = () =>
  screen.getByRole('region', { name: 'view of Steward · Replace the session middleware' });
const composer = () => within(view()).queryByRole('form', { name: 'answer the clarification' });
const subscribes = (socket: FakeWebSocket) =>
  socket.sent
    .map((s) => JSON.parse(s) as { type: string; agentId?: string; since?: number })
    .filter((m) => m.type === 'transcript.subscribe');
const shownSeqs = () =>
  Array.from(view().querySelectorAll('[data-seq]')).map((el) =>
    Number(el.getAttribute('data-seq')),
  );

describe('the Steward view (P25-05)', () => {
  it('has no composer without an open question, and shows its status and work', async () => {
    transcriptReply = async () => ({
      chunks: [
        chunk(1, 'thinking', 'Where is the cookie set?'),
        chunk(2, 'tool', 'Read src/session.ts'),
        chunk(3, 'text', 'Found it.'),
      ],
      hasMore: false,
      lastSeq: 3,
    });
    await open();
    await vi.waitFor(() => expect(shownSeqs()).toEqual([1, 2, 3]));
    expect(composer()).toBeNull();
    expect(within(view()).queryByRole('textbox')).toBeNull();
    expect(view().textContent).toMatch(/Read-only/);

    const text = view().textContent ?? '';
    expect(text).toMatch(/Editing src\/session\.ts/); // current activity
    expect(text).toMatch(/\/home\/cosmin\/work\/auth\/\.worktrees\/t-1/);
    expect(text).toMatch(/task\/t-1-session-middleware/);
    expect(text).toMatch(/Auth refactor/);
    expect(text).toMatch(/\$0\.42/);
    expect(text).toMatch(/17 \/ 500/);
    expect(within(view()).queryByText('blocked on you')).toBeNull();

    // Thinking is collapsed; tool calls and text are shown.
    const thinking = view().querySelector('details.stw-thinking') as HTMLDetailsElement;
    expect(thinking.open).toBe(false);
    expect(within(view()).getByText('Read src/session.ts')).toBeTruthy();
  });

  it('answers an open clarification from the composer, which then disappears', async () => {
    const socket = await open([userClarification]);
    expect(within(view()).getByText('blocked on you')).toBeTruthy();
    expect(within(view()).getByRole('region', { name: 'open question' }).textContent).toMatch(
      /Keep the legacy cookie name\?/,
    );
    const form = composer()!;
    expect(form).toBeTruthy();

    fireEvent.change(within(form).getByRole('textbox'), { target: { value: 'yes, keep it' } });
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: 'Send answer' }));
    });
    await vi.waitFor(() =>
      expect(calls.find((c) => c.url === '/api/questions/q-1/answer')).toMatchObject({
        method: 'POST',
        body: { answer: 'yes, keep it', version: 2 },
      }),
    );

    // The answer resolves it on the stream: the composer goes away.
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 11,
        at: '2026-09-30T10:05:00.000Z',
        event: {
          type: 'question.answered',
          questionId: 'q-1',
          answer: 'yes, keep it',
          answeredBy: { type: 'user' },
          version: 3,
        },
      });
    });
    expect(composer()).toBeNull();
    expect(within(view()).queryByRole('textbox')).toBeNull();
    expect(within(view()).queryByRole('region', { name: 'open question' })).toBeNull();
  });

  it('says who answered first when the answer is stale', async () => {
    answerReply = () => json({ error: 'stale', message: 'already answered' }, 409);
    const socket = await open([userClarification]);
    await act(async () => {
      fireEvent.click(within(composer()!).getByRole('button', { name: 'yes' }));
    });
    await vi.waitFor(() => expect(view().textContent).toMatch(/Not sent: already answered/));
    // The stream brings the first answer: the composer goes, the line names who was first.
    await act(async () => {
      socket.serverSends({
        type: 'event',
        seq: 11,
        at: '2026-09-30T10:05:00.000Z',
        event: {
          type: 'question.answered',
          questionId: 'q-1',
          answer: 'no',
          answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
          version: 3,
        },
      });
    });
    expect(composer()).toBeNull();
    expect(view().textContent).toMatch(
      /Not sent: already answered by Waykeeper · Auth refactor: "no"/,
    );
  });

  it('shows an open permission card with allow / refuse only', async () => {
    await open([
      {
        ...fx.permissionQuestion,
        status: 'open',
        answer: undefined,
        answeredBy: undefined,
      } as Question,
    ]);
    const card = within(view()).getByRole('article', { name: /permission question/ });
    expect(within(card).getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Refuse' })).toBeTruthy();
    expect(within(view()).queryByRole('textbox')).toBeNull();
    expect(composer()).toBeNull();
  });

  it('backfills over REST, then goes live from the page with no gap and no duplicate', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transcriptReply = async (url) => {
      if (url.searchParams.get('before') === '11') {
        return {
          chunks: [chunk(8, 'text', 'eight'), chunk(9, 'text', 'nine'), chunk(10, 'tool', 'ten')],
          hasMore: false,
          lastSeq: 14,
        };
      }
      await gate;
      return {
        chunks: [
          chunk(11, 'text', 'eleven'),
          chunk(12, 'tool', 'twelve'),
          chunk(13, 'text', 'thirteen'),
        ],
        hasMore: true,
        lastSeq: 13,
      };
    };
    const socket = await open();
    // The stream waits for the page: subscribed first, it would replay everything from 0.
    expect(subscribes(socket)).toEqual([]);
    await act(async () => {
      release();
    });
    await vi.waitFor(() => expect(shownSeqs()).toEqual([11, 12, 13]));
    await vi.waitFor(() =>
      expect(subscribes(socket)).toEqual([
        { type: 'transcript.subscribe', agentId: 'a-steward-1', since: 13 },
      ]),
    );

    // The stream overlaps the page (13 again) and continues it (a buffered 14, then 15).
    await act(async () => {
      socket.serverSends({
        type: 'transcript',
        agentId: 'a-steward-1',
        chunks: [chunk(13, 'text', 'thirteen'), chunk(14, 'text', 'fourteen')],
      });
      socket.serverSends({
        type: 'transcript',
        agentId: 'a-steward-1',
        chunks: [chunk(15, 'thinking', 'fifteen')],
      });
    });
    expect(shownSeqs()).toEqual([11, 12, 13, 14, 15]);

    // Scrolling back reads the page before the oldest held chunk.
    await act(async () => {
      fireEvent.click(within(view()).getByRole('button', { name: 'Load earlier' }));
    });
    await vi.waitFor(() => expect(shownSeqs()).toEqual([8, 9, 10, 11, 12, 13, 14, 15]));
    expect(calls.filter((c) => c.url.includes('before=11'))).toHaveLength(1);
    expect(within(view()).queryByRole('button', { name: 'Load earlier' })).toBeNull();
  });

  it('pauses and stops the Steward through the control route', async () => {
    await open();
    await act(async () => {
      fireEvent.click(within(view()).getByRole('button', { name: 'Pause' }));
    });
    await vi.waitFor(() =>
      expect(calls.find((c) => c.url === '/api/control')?.body).toEqual({
        target: { kind: 'agent', id: 'a-steward-1' },
        action: { action: 'pause' },
      }),
    );
    fireEvent.click(within(view()).getByRole('button', { name: 'Stop' }));
    await act(async () => {
      fireEvent.click(within(view()).getByRole('button', { name: 'Confirm stop' }));
    });
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/control').at(-1)?.body).toEqual({
        target: { kind: 'agent', id: 'a-steward-1' },
        action: { action: 'stop' },
      }),
    );
  });
});
