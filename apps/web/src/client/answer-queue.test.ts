// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Event as DomainEvent, Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../console/api.js';
import { useAppStore } from '../state/store.js';
import {
  answeredByLine,
  cancelQueuedAnswer,
  clearAnswerQueue,
  dismissAnswerNotice,
  flushAnswerQueue,
  notSentLine,
  QUEUE_KEY,
  RETRY_MS,
  startAnswerQueue,
  submitAnswer,
  tokenScope,
  useAnswerQueue,
  type QueuedAnswer,
} from './answer-queue.js';

/** P7-05: the offline answer queue — persistence, reconnect ordering, conflicts, idempotency. */

const TOKEN = 'secret-token-123';
const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
};
const userHeld: Question = { ...fx.question, holder: { type: 'user' }, version: 3 };
const second: Question = {
  ...fx.question,
  id: 'q-2',
  holder: { type: 'user' },
  context: { text: 'Which date format?' },
  version: 0,
};

type AnswerFn = Api['answer'];
let answer: ReturnType<typeof vi.fn<AnswerFn>>;
let api: Api;
let stop: (() => void) | undefined;
let seq = 10;

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAnswerQueue.setState({ scope: undefined, entries: {}, announcement: undefined });
  answer = vi.fn<AnswerFn>(async () => ({ ok: true as const }));
  api = { answer } as unknown as Api;
  seq = 10;
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});

const status = (s: Parameters<ReturnType<typeof useAppStore.getState>['setStatus']>[0]) =>
  useAppStore.getState().setStatus(s);

/** The page's world: a snapshot with these questions, then live. */
function snapshot(questions: Question[]) {
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq,
    agents: [fx.harmonizer, waykeeper, fx.agent],
    bodies: [fx.body, fx.moon],
    projects: [fx.project],
    tasks: [fx.task],
    questions,
    proposals: [],
    statuses: [],
  });
}
function event(e: DomainEvent) {
  seq += 1;
  useAppStore.getState().apply({ type: 'event', seq, at: fx.NOW, event: e });
}
const entries = () => useAnswerQueue.getState().entries;
const stored = () =>
  JSON.parse(localStorage.getItem(QUEUE_KEY) ?? 'null') as {
    scope?: string;
    entries: QueuedAnswer[];
  } | null;
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Offline, with a world: the user answers, and the answer is queued. */
async function answerOffline(q: Question = userHeld, text = 'yes') {
  status('disconnected');
  expect(await submitAnswer(api, q, text)).toBe('queued');
}

describe('answering offline (P7-05)', () => {
  it('queues the answer with the version, sends nothing, persists it without the token', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    expect(answer).not.toHaveBeenCalled();
    const entry = entries()['q-1']!;
    expect(entry).toMatchObject({ questionId: 'q-1', answer: 'yes', version: 3, state: 'queued' });
    expect(entry.answerId).toMatch(/\S{8,}/);
    const raw = localStorage.getItem(QUEUE_KEY)!;
    expect(raw).not.toContain(TOKEN);
    expect(stored()).toMatchObject({
      scope: tokenScope(TOKEN),
      entries: [{ answerId: entry.answerId }],
    });
    expect(useAnswerQueue.getState().announcement?.text).toMatch(/queued.*connection is back/);
  });

  it('sends after the catch-up, not before: the replayed events are applied first', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    const queuedId = entries()['q-1']!.answerId;
    status('connecting');
    status('catching_up');
    await settle();
    expect(answer).not.toHaveBeenCalled();
    let seqAtSend: number | undefined;
    answer.mockImplementation(async () => {
      seqAtSend = useAppStore.getState().world.seq;
      return { ok: true as const };
    });
    event({ type: 'agent.progress', agentId: 'a-steward-1', summary: 'still waiting' });
    status('live'); // `caught_up` was applied
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(seqAtSend).toBe(11);
    const [qid, text, version, answerId] = answer.mock.calls[0]!;
    expect([qid, text, version]).toEqual(['q-1', 'yes', 3]);
    expect(answerId).toBe(queuedId);
    expect(entries()['q-1']?.state).toBe('sent');
    expect(stored()).toBeNull(); // a "sent" notice is not persisted
    expect(useAnswerQueue.getState().announcement?.text).toMatch(/queued answer “yes”.*was sent/);
  });

  it('sends several queued answers oldest first, one at a time', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld, second]);
    status('live');
    await answerOffline(second, 'ISO 8601');
    await new Promise((r) => setTimeout(r, 2));
    await answerOffline(userHeld, 'no');
    let inFlight = 0;
    let most = 0;
    answer.mockImplementation(async () => {
      most = Math.max(most, ++inFlight);
      await settle();
      inFlight--;
      return { ok: true as const };
    });
    status('live');
    await flushAnswerQueue();
    expect(answer.mock.calls.map((c) => c[0])).toEqual(['q-2', 'q-1']);
    expect(most).toBe(1);
  });

  it('survives a reload: the stored queue is sent by the next page once it is live', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    const { answerId } = entries()['q-1']!;
    stop();
    // A new page life: nothing in memory, the stored queue only.
    useAppStore.getState().reset();
    useAnswerQueue.setState({ scope: undefined, entries: {} });
    stop = startAnswerQueue(TOKEN, api);
    expect(entries()['q-1']).toMatchObject({ answerId, state: 'queued' });
    status('connecting');
    snapshot([userHeld]);
    status('live');
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledWith('q-1', 'yes', 3, answerId);
  });

  it('an entry caught mid-send by a reload is queued again with the same answerId', async () => {
    const entry: QueuedAnswer = {
      answerId: 'ans-1',
      questionId: 'q-1',
      answer: 'yes',
      version: 3,
      text: 'Keep the legacy cookie name?',
      queuedAt: fx.NOW,
      state: 'sending',
    };
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ v: 1, scope: tokenScope(TOKEN), entries: [entry] }),
    );
    stop = startAnswerQueue(TOKEN, api);
    expect(entries()['q-1']?.state).toBe('queued');
    snapshot([userHeld]);
    status('live');
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledWith('q-1', 'yes', 3, 'ans-1');
  });

  it('another token clears the queue when its session goes live; forgetting the token clears it', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    stop();
    useAnswerQueue.setState({ scope: undefined, entries: {} });
    stop = startAnswerQueue('another-token', api);
    expect(entries()['q-1']).toBeDefined(); // not before the new token is known to work
    status('live');
    await flushAnswerQueue();
    expect(answer).not.toHaveBeenCalled();
    expect(entries()).toEqual({});
    expect(stored()).toBeNull();

    await answerOffline();
    expect(stored()?.entries).toHaveLength(1);
    clearAnswerQueue();
    expect(entries()).toEqual({});
    expect(stored()).toBeNull();
  });

  it('cancel removes a queued answer: nothing is sent on reconnect', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    expect(cancelQueuedAnswer('q-1')).toBe(true);
    expect(entries()).toEqual({});
    expect(stored()).toBeNull();
    expect(useAnswerQueue.getState().announcement?.text).toBe('Queued answer cancelled.');
    status('live');
    await flushAnswerQueue();
    expect(answer).not.toHaveBeenCalled();
    expect(cancelQueuedAnswer('q-1')).toBe(false);
  });

  it('a retry after a lost acknowledgement resends the same answerId (the server says duplicate)', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    // Online, but the request dies after the server recorded it: no reply reaches the page.
    answer.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await submitAnswer(api, userHeld, 'yes')).toBe('queued');
    expect(entries()['q-1']).toMatchObject({ state: 'queued', wasQueued: true });
    answer.mockResolvedValueOnce({ ok: true, duplicate: true });
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(answer.mock.calls[1]![3]).toBe(answer.mock.calls[0]![3]);
    expect(entries()['q-1']?.state).toBe('sent');
  });

  it.each([500, 502, 503, 408, 429])(
    'a passing %i while flushing keeps the answer queued and retries it with the same answerId',
    async (code) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        stop = startAnswerQueue(TOKEN, api);
        snapshot([userHeld]);
        status('live');
        await answerOffline();
        const { answerId } = entries()['q-1']!;
        answer.mockRejectedValueOnce(new ApiError(code, 'try later'));
        status('live');
        await flushAnswerQueue();
        expect(entries()['q-1']).toMatchObject({ state: 'queued', answerId });
        expect(answer).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(RETRY_MS);
        await flushAnswerQueue();
        expect(answer).toHaveBeenCalledTimes(2);
        expect(answer.mock.calls[1]![3]).toBe(answerId);
        expect(entries()['q-1']?.state).toBe('sent');
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('a passing 503 on a direct send queues the answer instead of failing the card', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    answer.mockRejectedValueOnce(new ApiError(503, 'unavailable'));
    expect(await submitAnswer(api, userHeld, 'yes')).toBe('queued');
    expect(entries()['q-1']).toMatchObject({ state: 'queued', wasQueued: true });
    // A real refusal still throws to the card.
    answer.mockRejectedValueOnce(new ApiError(400, 'bad answer', 'invalid'));
    await expect(submitAnswer(api, second, 'x')).rejects.toBeInstanceOf(ApiError);
    expect(entries()['q-2']).toBeUndefined();
  });

  it('a network failure while flushing keeps the answer queued for the next try', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    answer.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    status('live');
    await flushAnswerQueue();
    expect(entries()['q-1']?.state).toBe('queued');
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledTimes(2);
    expect(entries()['q-1']?.state).toBe('sent');
  });
});

describe('the browser and other tabs (P7-05)', () => {
  it('navigator.onLine false queues even while the stream still looks live; "online" sends it', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    expect(await submitAnswer(api, userHeld, 'yes')).toBe('queued');
    expect(answer).not.toHaveBeenCalled();
    vi.stubGlobal('navigator', { ...navigator, onLine: true });
    window.dispatchEvent(new Event('online'));
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledTimes(1);
    expect(entries()['q-1']?.state).toBe('sent');
  });

  it("another tab's change is read in, and a live tab sends what it queued", async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    const entry: QueuedAnswer = {
      answerId: 'other-tab',
      questionId: 'q-1',
      answer: 'yes',
      version: 3,
      text: 'Keep the legacy cookie name?',
      queuedAt: fx.NOW,
      state: 'queued',
    };
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ v: 1, scope: tokenScope(TOKEN), entries: [entry] }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: QUEUE_KEY }));
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledWith('q-1', 'yes', 3, 'other-tab');
  });

  it("another live tab's in-flight send is left to it, not sent again here", async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    const entry: QueuedAnswer = {
      answerId: 'other-tab',
      questionId: 'q-1',
      answer: 'yes',
      version: 3,
      text: 'Keep the legacy cookie name?',
      queuedAt: fx.NOW,
      state: 'sending',
      wasQueued: true,
    };
    localStorage.setItem(
      QUEUE_KEY,
      JSON.stringify({ v: 1, scope: tokenScope(TOKEN), entries: [entry] }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: QUEUE_KEY }));
    await flushAnswerQueue();
    expect(answer).not.toHaveBeenCalled();
    expect(entries()['q-1']?.state).toBe('sending');
    // That tab closed mid-send: the next page load recovers it (same answerId).
    stop();
    useAnswerQueue.setState({ scope: undefined, entries: {} });
    status('connecting');
    stop = startAnswerQueue(TOKEN, api);
    expect(entries()['q-1']?.state).toBe('queued');
    status('live');
    await flushAnswerQueue();
    expect(answer).toHaveBeenCalledWith('q-1', 'yes', 3, 'other-tab');
  });
});

describe('reconciling on reconnect (P7-05)', () => {
  async function conflict(by: Question['answeredBy'], serverMessage: string, answerId?: string) {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    status('catching_up');
    event({
      type: 'question.answered',
      questionId: 'q-1',
      answer: 'no',
      answeredBy: by!,
      version: 4,
      ...(answerId ? { answerId } : {}),
    });
    answer.mockRejectedValueOnce(new ApiError(409, serverMessage, 'stale'));
    status('live');
    await flushAnswerQueue();
    return entries()['q-1']!;
  }

  it('answered on another device: "already answered by you on another device or tab"', async () => {
    const entry = await conflict(
      { type: 'user' },
      'question q-1 was already answered by the user',
      'other-device',
    );
    expect(entry).toMatchObject({ state: 'not_sent', reason: 'stale' });
    const line = notSentLine(useAppStore.getState().world, entry);
    expect(line).toBe('already answered by you on another device or tab: “no”');
    expect(useAnswerQueue.getState().announcement?.text).toMatch(
      /queued answer “yes” was not sent: already answered by you on another device/,
    );
    dismissAnswerNotice('q-1');
    expect(entries()).toEqual({});
  });

  it('answered by a supervisor from context: names it', async () => {
    const entry = await conflict(
      { type: 'agent', id: 'a-waykeeper-1' },
      'question q-1 was already answered by agent a-waykeeper-1',
    );
    expect(notSentLine(useAppStore.getState().world, entry)).toBe(
      'already answered by Waykeeper · Auth refactor (its supervisor, from context): “no”',
    );
  });

  it('a permission the system decided reads as the permission policy', () => {
    const q: Question = {
      ...fx.permissionQuestion,
      status: 'answered',
      answer: 'allow',
      answeredBy: { type: 'system' },
    };
    expect(answeredByLine(useAppStore.getState().world, q)).toBe(
      'already answered by the permission policy: “allow”',
    );
  });

  it('a question that changed (escalated) while offline asks to answer again', async () => {
    stop = startAnswerQueue(TOKEN, api);
    const held: Question = { ...userHeld, holder: { type: 'agent', id: 'a-waykeeper-1' } };
    snapshot([held]);
    status('live');
    await answerOffline(held);
    event({
      type: 'question.escalated',
      questionId: 'q-1',
      from: { type: 'agent', id: 'a-waykeeper-1' },
      to: { type: 'agent', id: 'a-harmonizer' },
      version: 4,
    });
    answer.mockRejectedValueOnce(
      new ApiError(
        409,
        'question q-1 changed since version 3 (now held by agent a-harmonizer)',
        'stale',
      ),
    );
    status('live');
    await flushAnswerQueue();
    const entry = entries()['q-1']!;
    expect(notSentLine(useAppStore.getState().world, entry)).toMatch(
      /changed while you were offline \(it is now held by Harmonizer\); answer it again/,
    );
  });

  it('a withdrawn or unknown question is said so', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld, second]);
    status('live');
    await answerOffline(userHeld);
    await answerOffline(second, 'ISO');
    answer.mockImplementation(async (id) => {
      if (id === 'q-1') throw new ApiError(409, 'question q-1 is cancelled', 'rejected');
      throw new ApiError(404, 'not_found', 'not_found');
    });
    status('live');
    await flushAnswerQueue();
    const world = useAppStore.getState().world;
    expect(notSentLine(world, entries()['q-1']!)).toBe('the question was withdrawn');
    expect(notSentLine(world, entries()['q-2']!)).toBe('the question no longer exists');
  });

  it('a dismissed question (409 stale "was already withdrawn") reads as withdrawn (P9-14)', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline(userHeld);
    answer.mockRejectedValueOnce(new ApiError(409, 'question q-1 was already withdrawn', 'stale'));
    status('live');
    await flushAnswerQueue();
    const entry = entries()['q-1']!;
    expect(entry).toMatchObject({ state: 'not_sent', reason: 'withdrawn' });
    expect(notSentLine(useAppStore.getState().world, entry)).toBe('the question was withdrawn');
  });

  it('before the world arrives (a reload), the refusal is worded from the server message', () => {
    const entry: QueuedAnswer = {
      answerId: 'x',
      questionId: 'q-unknown',
      answer: 'yes',
      version: 0,
      text: 'Q?',
      queuedAt: fx.NOW,
      state: 'not_sent',
      reason: 'stale',
      message: 'question q-unknown was already answered by the user',
    };
    const world = useAppStore.getState().world;
    expect(notSentLine(world, entry)).toBe('already answered by you on another device or tab');
    expect(
      notSentLine(world, { ...entry, message: 'question q was already answered by agent a-1' }),
    ).toBe('already answered by a supervisor');
    expect(notSentLine(world, { ...entry, message: 'question q changed since version 0' })).toBe(
      'the question changed while you were offline',
    );
  });

  it('a refused token keeps the answer queued for the next session', async () => {
    stop = startAnswerQueue(TOKEN, api);
    snapshot([userHeld]);
    status('live');
    await answerOffline();
    answer.mockRejectedValueOnce(new ApiError(401, 'unauthorized', 'unauthorized'));
    status('live');
    await flushAnswerQueue();
    expect(entries()['q-1']?.state).toBe('queued');
  });
});
