// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor, Agent, Event, Question, ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { createApi } from '../console/api.js';
import { ApiContext } from '../console/hierarchy/shared.js';
import { useAppStore } from '../state/store.js';
import { CardLinksContext, QuestionView } from './cards/index.js';

/**
 * P9-14 (SPEC decision 135): the × on every question card — the inbox, a chat thread (the
 * Harmonizer's relay of a Waykeeper's question, the Waykeeper's own thread), the Steward view —
 * posts `/api/questions/:id/dismiss` with the card's version, needs the connection, and the card
 * turns into "Dismissed by you" / "Withdrawn: you wrote to its agent directly".
 */

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
const { answer: _a, answeredBy: _b, ...permissionBase } = fx.permissionQuestion;
/** A Waykeeper's clarification that reached the user (shown in the Harmonizer's thread too). */
const clarification: Question = {
  ...fx.question,
  originAgentId: waykeeper.id,
  holder: { type: 'user' },
  version: 3,
};
const permission: Question = {
  ...permissionBase,
  status: 'open',
  version: 0,
  createdAt: later(5),
  updatedAt: later(5),
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
      if (url.includes('/transcript')) {
        return new Response(JSON.stringify({ chunks: [], hasMore: false, lastSeq: 0 }));
      }
      if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
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
async function open(questions: Question[], path = '/') {
  seq = 10;
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const snapshot: ServerMessage = {
    type: 'snapshot',
    logId: 'log-a',
    seq,
    agents: [fx.harmonizer, waykeeper, fx.agent],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [fx.project],
    tasks: [fx.task, fx.asteroidTask],
    questions,
    proposals: [],
    statuses: [
      { ...fx.status, agentId: 'a-harmonizer' },
      { ...fx.status, agentId: waykeeper.id },
      fx.status,
    ],
  };
  await act(async () => {
    FakeWebSocket.instances[0]!.serverOpens();
    FakeWebSocket.instances[0]!.serverSends(snapshot);
  });
}
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
const dismissButton = (scope: HTMLElement, text: string) =>
  within(scope).getByRole('button', { name: new RegExp(`^Dismiss .*: ${text}`) });

function renderThread() {
  return render(
    <ApiContext.Provider value={createApi('tok')}>
      <CardLinksContext.Provider value={true}>
        <section aria-label="thread">
          <QuestionView questionId={clarification.id} />
        </section>
      </CardLinksContext.Provider>
    </ApiContext.Provider>,
  );
}
const thread = () => screen.getByRole('region', { name: 'thread' });

const cancelled = (q: Question, reason: string, by: Actor): Event => ({
  type: 'question.cancelled',
  questionId: q.id,
  agentId: q.originAgentId,
  reason,
  version: q.version + 1,
  by,
});

describe('dismissing a question (P9-14)', () => {
  it('the inbox: × on both kinds, named for what it does, posts the version', async () => {
    await open([clarification, permission]);
    const clarifyX = dismissButton(inbox(), clarification.context.text);
    expect(clarifyX.getAttribute('aria-label')).toMatch(/^Dismiss the question without answering/);
    expect(clarifyX.tagName).toBe('BUTTON'); // a native button: Tab and Enter reach it
    const permissionX = dismissButton(inbox(), permission.context.text);
    expect(permissionX.getAttribute('aria-label')).toMatch(/\(deny it\)/);

    await click(clarifyX);
    await flush();
    expect(posts(`/api/questions/${clarification.id}/dismiss`)[0]?.body).toEqual({ version: 3 });
    await click(permissionX);
    await flush();
    expect(posts(`/api/questions/${permission.id}/dismiss`)[0]?.body).toEqual({ version: 0 });
    // Nothing was answered: a dismissal is never an "allow".
    expect(calls.filter((c) => c.url.endsWith('/answer'))).toHaveLength(0);

    await stream(cancelled(clarification, 'dismissed by the user', { type: 'user' }));
    expect(within(inbox()).queryByText(clarification.context.text)).toBeNull();
  });

  it('a chat thread: the same card, then "Dismissed by you"', async () => {
    await open([clarification]);
    renderThread();
    await click(dismissButton(thread(), clarification.context.text));
    await flush();
    expect(posts(`/api/questions/${clarification.id}/dismiss`)).toHaveLength(1);
    await stream(cancelled(clarification, 'dismissed by the user', { type: 'user' }));
    expect(within(thread()).getByRole('group').textContent).toBe(
      `Dismissed by you: ${clarification.context.text}`,
    );
  });

  it('a clarification superseded by the user’s message reads so in the thread', async () => {
    await open([clarification]);
    renderThread();
    await stream(cancelled(clarification, "superseded by the user's message", { type: 'system' }));
    expect(within(thread()).getByRole('group').textContent).toBe(
      `Withdrawn: you wrote to its agent directly: ${clarification.context.text}`,
    );
  });

  it('a stale dismissal says who was first', async () => {
    replies[`POST /api/questions/${clarification.id}/dismiss`] = {
      status: 409,
      body: { error: 'stale', message: 'question q-1 was already answered by the user' },
    };
    await open([clarification]);
    await click(dismissButton(inbox(), clarification.context.text));
    await flush();
    expect(within(inbox()).getByRole('alert').textContent).toMatch(/^Not sent: /);
  });

  it('needs the connection: disabled while the stream is down', async () => {
    await open([clarification]);
    expect((dismissButton(inbox(), clarification.context.text) as HTMLButtonElement).disabled).toBe(
      false,
    );
    await act(async () => {
      FakeWebSocket.instances[0]!.serverCloses(1006);
    });
    const x = dismissButton(inbox(), clarification.context.text);
    expect((x as HTMLButtonElement).disabled).toBe(true);
    expect(x.getAttribute('title')).toMatch(/needs the connection/);
  });

  it('the Steward view: × on its clarification and on its permission request', async () => {
    const steward = { ...clarification, originAgentId: fx.agent.id, id: 'q-s1' };
    const stewardPermission = { ...permission, originAgentId: fx.agent.id };
    await open([steward, stewardPermission], `/steward/${fx.agent.id}`);
    const view = screen.getByRole('region', { name: 'open question' });
    await click(dismissButton(view, steward.context.text));
    await flush();
    expect(posts(`/api/questions/${steward.id}/dismiss`)).toHaveLength(1);
    await click(dismissButton(view, stewardPermission.context.text));
    await flush();
    expect(posts(`/api/questions/${stewardPermission.id}/dismiss`)).toHaveLength(1);
  });
});
