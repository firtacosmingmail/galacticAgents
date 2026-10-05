// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Event, Question, ServerMessage, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { QUEUE_KEY, useAnswerQueue } from '../client/answer-queue.js';
import { useAppStore } from '../state/store.js';
import { axeFindings, blocking } from '../a11y/a11y-fixtures.js';

/**
 * P7-05: the panel's offline answers — queued state on the card, cancel with focus, the send after
 * the catch-up, "already answered by …" and "sent" after reconnecting, card decisions waiting for
 * the connection, the Steward view's composer.
 */

const later = (s: number) => new Date(Date.parse(fx.NOW) + s * 1000).toISOString();
const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-luna',
};
const working = (agentId: string): StatusRecord => ({ ...fx.status, agentId });
const clarification: Question = { ...fx.question, holder: { type: 'user' }, version: 3 };

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
const calls: Call[] = [];
let answerReply: () => Response = () => new Response(JSON.stringify({ ok: true }));
const answers = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/answer'));

beforeEach(() => {
  calls.length = 0;
  answerReply = () => new Response(JSON.stringify({ ok: true }));
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  useAppStore.getState().reset();
  useAnswerQueue.setState({ scope: undefined, entries: {}, announcement: undefined });
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        ...(init?.body ? { body: JSON.parse(init.body as string) as Record<string, unknown> } : {}),
      });
      if (url.endsWith('/answer')) return answerReply();
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
      if (url.includes('/conversation') || url.includes('/transcript')) {
        return new Response(JSON.stringify({ entries: [], chunks: [], hasMore: false }));
      }
      return new Response(JSON.stringify({ ok: true }));
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

let seq = 10;
const socket = () => FakeWebSocket.instances.at(-1)!;

async function open(questions: Question[], path = '/') {
  seq = 10;
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  await act(async () => {
    socket().serverOpens();
    socket().serverSends({
      type: 'snapshot',
      logId: 'log-a',
      seq,
      agents: [fx.harmonizer, waykeeper, fx.agent],
      bodies: [fx.body, fx.moon, fx.asteroid],
      projects: [fx.project],
      tasks: [fx.task],
      questions,
      proposals: [{ ...fx.proposal, createdAt: later(-120) }],
      statuses: [working('a-harmonizer'), working('a-waykeeper-1'), working('a-steward-1')],
    } satisfies ServerMessage);
  });
}

/** The connection drops (a phone in a tunnel). */
async function drop() {
  await act(async () => socket().serverCloses(1006));
  expect(useAppStore.getState().status).toBe('disconnected');
}

/** The client reconnects; the server replays `events` and says `caught_up`. */
async function reconnect(events: Event[] = []) {
  const before = FakeWebSocket.instances.length;
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(before + 1), {
    timeout: 3000,
  });
  await act(async () => {
    socket().serverOpens();
  });
  expect(socket().hello).toMatchObject({ lastEventId: seq, logId: 'log-a' });
  for (const event of events) {
    seq += 1;
    await act(async () => socket().serverSends({ type: 'event', seq, at: later(seq), event }));
  }
  // Nothing is sent while catching up.
  expect(answers()).toHaveLength(0);
  await act(async () => {
    socket().serverSends({ type: 'caught_up', seq });
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await new Promise((r) => setTimeout(r, 0));
  });
}

const inbox = () => screen.getByRole('region', { name: 'question inbox' });
const card = () =>
  within(inbox()).getByRole('article', {
    name: 'clarification question Keep the legacy cookie name?',
  });
const liveRegionText = () =>
  Array.from(document.querySelectorAll('[role="status"][aria-live="polite"]'))
    .map((n) => n.textContent)
    .join(' | ');

describe('offline answers in the panel (P7-05)', () => {
  it('queues an answer while disconnected, shows it, and lets the user cancel it (focus back)', async () => {
    await open([clarification]);
    await drop();
    await click(within(card()).getByRole('button', { name: 'yes' }));
    expect(answers()).toHaveLength(0);
    const box = within(card()).getByRole('group', { name: 'queued answer' });
    expect(box.textContent).toMatch(/queued.*Your answer “yes” will send when reconnected/);
    expect(liveRegionText()).toMatch(/Answer queued/);
    expect(localStorage.getItem(QUEUE_KEY)).toContain('"answer":"yes"');
    expect(blocking(await axeFindings())).toEqual([]);
    // The answer controls are replaced while it is queued.
    expect(within(card()).queryByRole('button', { name: 'yes' })).toBeNull();

    await click(within(box).getByRole('button', { name: 'Cancel queued answer' }));
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(within(card()).queryByRole('group', { name: 'queued answer' })).toBeNull();
    expect(document.activeElement).toBe(within(card()).getByLabelText('answer'));
    expect(liveRegionText()).toMatch(/Queued answer cancelled/);
    expect(localStorage.getItem(QUEUE_KEY)).toBeNull();

    await reconnect();
    expect(answers()).toHaveLength(0);
  });

  it('sends the queued answer after the catch-up and says it was sent', async () => {
    await open([clarification]);
    await drop();
    fireEvent.change(within(card()).getByLabelText('answer'), { target: { value: 'rename it' } });
    await click(within(card()).getByRole('button', { name: 'Answer' }));
    const queued = useAnswerQueue.getState().entries['q-1']!;
    await reconnect([
      { type: 'agent.progress', agentId: 'a-steward-1', summary: 'waiting for the user' },
    ]);
    expect(answers().map((c) => c.body)).toEqual([
      { answer: 'rename it', version: 3, answerId: queued.answerId },
    ]);
    // The stream brings the answer; the card leaves, the inbox says it was sent.
    seq += 1;
    await act(async () =>
      socket().serverSends({
        type: 'event',
        seq,
        at: later(seq),
        event: {
          type: 'question.answered',
          questionId: 'q-1',
          answer: 'rename it',
          answeredBy: { type: 'user' },
          version: 4,
          answerId: queued.answerId,
        },
      }),
    );
    expect(within(inbox()).queryByRole('article', { name: /clarification question/ })).toBeNull();
    expect(inbox().textContent).toMatch(
      /Sent: your answer “rename it” to “Keep the legacy cookie name\?”/,
    );
    expect(liveRegionText()).toMatch(
      /queued answer “rename it” to “Keep the legacy cookie name\?” was sent/,
    );
    expect(useAppStore.getState().world.questions['q-1']?.meta).toMatchObject({
      answerId: queued.answerId,
    });
  });

  it('answered on another device meanwhile: "Not sent: already answered by you on another device"', async () => {
    await open([clarification]);
    await drop();
    await click(within(card()).getByRole('button', { name: 'yes' }));
    answerReply = () =>
      new Response(
        JSON.stringify({
          error: 'stale',
          message: 'question q-1 was already answered by the user',
        }),
        { status: 409 },
      );
    await reconnect([
      {
        type: 'question.answered',
        questionId: 'q-1',
        answer: 'no',
        answeredBy: { type: 'user' },
        version: 4,
        answerId: 'laptop-tab',
      },
    ]);
    expect(answers()).toHaveLength(1);
    const notice = inbox().querySelector('.answer-notice.is-not-sent')!;
    expect(notice.textContent).toMatch(
      /Not sent: your answer “yes” to “Keep the legacy cookie name\?” — already answered by you on another device or tab: “no”/,
    );
    expect(liveRegionText()).toMatch(/was not sent: already answered by you on another device/);
    expect(blocking(await axeFindings())).toEqual([]);
    // No "send again" for a question that is closed; dismiss clears it.
    expect(within(notice as HTMLElement).queryByRole('button', { name: 'Send again' })).toBeNull();
    await click(within(notice as HTMLElement).getByRole('button', { name: 'dismiss' }));
    expect(inbox().querySelector('.answer-notice')).toBeNull();
  });

  it('a question escalated while offline: not sent, "Send again" uses the new version', async () => {
    await open([{ ...clarification, holder: { type: 'agent', id: 'a-waykeeper-1' } }]);
    const held = () =>
      within(inbox()).getByRole('article', {
        name: 'clarification question Keep the legacy cookie name?',
      });
    await drop();
    await click(within(held()).getByRole('button', { name: 'no' }));
    let reply = 0;
    answerReply = () =>
      reply++ === 0
        ? new Response(
            JSON.stringify({
              error: 'stale',
              message: 'question q-1 changed since version 3 (now held by agent a-harmonizer)',
            }),
            { status: 409 },
          )
        : new Response(JSON.stringify({ ok: true }));
    await reconnect([
      {
        type: 'question.escalated',
        questionId: 'q-1',
        from: { type: 'agent', id: 'a-waykeeper-1' },
        to: { type: 'agent', id: 'a-harmonizer' },
        version: 4,
      },
    ]);
    expect(held().textContent).toMatch(
      /Not sent: your answer “no”.*changed while you were offline \(it is now held by Harmonizer\)/,
    );
    await click(within(held()).getByRole('button', { name: 'Send again' }));
    expect(answers().map((c) => c.body?.['version'])).toEqual([3, 4]);
    expect(answers()[1]!.body?.['answerId']).not.toBe(answers()[0]!.body?.['answerId']);
  });

  it('card decisions are not queued: offline, the card says so and its buttons wait', async () => {
    await open([]);
    const proposal = () =>
      within(inbox()).getByRole('article', { name: `proposal ${fx.proposal.requestText}` });
    expect(within(proposal()).getByRole('button', { name: 'Approve' })).toHaveProperty(
      'disabled',
      false,
    );
    await drop();
    expect(proposal().textContent).toMatch(/Offline: decisions on cards are not queued/);
    expect(within(proposal()).getByRole('button', { name: 'Approve' })).toHaveProperty(
      'disabled',
      true,
    );
    await reconnect();
    expect(within(proposal()).getByRole('button', { name: 'Approve' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it("the Steward view's composer queues too, and Cancel gives the box back with focus", async () => {
    await open([clarification], '/steward/a-steward-1');
    const main = () => document.querySelector<HTMLElement>('.pnl-body main')!;
    await drop();
    const box = within(main()).getByRole('form', { name: 'answer the clarification' });
    fireEvent.change(within(box).getByRole('textbox'), { target: { value: 'Keep it' } });
    await click(within(box).getByRole('button', { name: 'Send answer' }));
    const group = within(main()).getByRole('group', { name: 'answer the clarification' });
    expect(group.textContent).toMatch(/Your answer “Keep it” will send when reconnected/);
    await click(within(group).getByRole('button', { name: 'Cancel queued answer' }));
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    const again = within(main()).getByRole('form', { name: 'answer the clarification' });
    expect(document.activeElement).toBe(within(again).getByRole('textbox'));
  });

  it('a queue stored by an earlier page is listed before the world arrives and sent after it', async () => {
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({
        v: 1,
        entries: [
          {
            answerId: 'ans-stored',
            questionId: 'q-1',
            answer: 'yes',
            version: 3,
            text: 'Keep the legacy cookie name?',
            queuedAt: fx.NOW,
            state: 'queued',
          },
        ],
      }),
    );
    await open([clarification]);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(answers().map((c) => c.body)).toEqual([
      { answer: 'yes', version: 3, answerId: 'ans-stored' },
    ]);
  });
});
