import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

let composed: ComposedRuntime;
let fake: FakeAdapter;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  fake = new FakeAdapter({ speed: 1 });
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [fake],
    flushMs: 10,
    caps: { maxConcurrentAgents: 2 },
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    scenarios: () => fake.scenarioNames(),
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const call = async (path: string, body?: unknown, token = TEST_TOKEN) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: body === undefined && path.startsWith('/api/runtimes') ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const waitFor = (pred: () => boolean, what: string, ms = 3_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () =>
      pred()
        ? resolve()
        : Date.now() - t0 > ms
          ? reject(new Error(`timeout: ${what}`))
          : setTimeout(tick, 10);
    tick();
  });
const state = (id: string) => composed.statuses.get(id)?.state;

describe('/api agent routes (P1-11)', () => {
  it('needs the token', async () => {
    expect((await call('/api/runtimes', undefined, 'wrong')).status).toBe(401);
    expect(
      (await call('/api/agents', { runtime: 'fake', prompt: 'x', cwd: '/tmp' }, 'wrong')).status,
    ).toBe(401);
  });

  it('describes the runtimes, policies and caps for the spawn form', async () => {
    const { status, body } = await call('/api/runtimes');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      runtimes: [
        { name: 'fake', resumable: true, scenarios: expect.arrayContaining(['happy', 'asks']) },
      ],
      policies: ['default', 'trusting', 'cautious'],
      maxConcurrentAgents: 2,
    });
  });

  it('spawns, messages, pauses, resumes and stops an agent', async () => {
    const spawned = await call('/api/agents', {
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/tmp',
      policy: 'trusting',
      caps: { maxToolCalls: 7 },
    });
    expect(spawned.status).toBe(201);
    const id = spawned.body['agentId'] as string;
    expect(composed.log.tables.agents.get(id)?.caps.maxToolCalls).toBe(7);
    await waitFor(() => state(id) === 'idle', 'idle');

    const sent = await call(`/api/agents/${id}/send`, { text: 'hello there' });
    expect(sent.status).toBe(200);
    expect(sent.body['messageId']).toBeTypeOf('string');
    await waitFor(
      () => composed.log.eventsSince(0).filter((e) => e.event.type === 'agent.idle').length >= 2,
      'second idle',
    );
    composed.transcripts.flush();
    expect(composed.transcripts.read(id).map((c) => c.text)).toContain('received: hello there');

    expect((await call(`/api/agents/${id}/pause`)).status).toBe(200);
    await waitFor(() => state(id) === 'paused', 'paused');
    expect((await call(`/api/agents/${id}/resume`)).status).toBe(200);
    await waitFor(() => state(id) === 'idle', 'idle after resume');
    expect((await call(`/api/agents/${id}/stop`)).status).toBe(200);
    await waitFor(() => state(id) === 'stopped', 'stopped');
    const afterStop = await call(`/api/agents/${id}/send`, { text: 'too late' });
    expect(afterStop.status).toBe(409);
  });

  it('answers questions of both kinds and reports a refused spawn', async () => {
    const a = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:full', cwd: '/tmp' });
    const id = a.body['agentId'] as string;
    await waitFor(() => state(id) === 'waiting_for_input', 'clarification');
    const q1 = composed.statuses.get(id)!.pendingQuestionId!;
    expect((await call(`/api/questions/${q1}/answer`, { answer: 'yes' })).status).toBe(200);
    await waitFor(
      () =>
        composed.statuses.get(id)?.pendingQuestionId !== undefined &&
        composed.statuses.get(id)?.pendingQuestionId !== q1,
      'permission',
    );
    const q2 = composed.statuses.get(id)!.pendingQuestionId!;
    expect(composed.log.tables.questions.get(q2)?.kind).toBe('permission');
    expect((await call(`/api/questions/${q2}/answer`, { answer: 'allow' })).status).toBe(200);
    await waitFor(() => state(id) === 'idle', 'idle');
    expect((await call(`/api/questions/${q2}/answer`, { answer: 'again' })).status).toBe(409);

    const b = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:long', cwd: '/tmp' });
    expect(b.status).toBe(201);
    const c = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:long', cwd: '/tmp' });
    expect(c.status).toBe(409);
    expect(c.body['message']).toMatch(/concurrency cap/);
    expect((await call('/api/agents', { runtime: 'pty', prompt: 'x', cwd: '/tmp' })).status).toBe(
      409,
    );
    expect((await call('/api/agents', { runtime: 'fake', prompt: '', cwd: '/tmp' })).status).toBe(
      400,
    );
  });

  it('recovers an interrupted agent on demand', async () => {
    const a = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:asks', cwd: '/tmp' });
    const id = a.body['agentId'] as string;
    await waitFor(() => state(id) === 'waiting_for_input', 'question');
    await composed.runtime.shutdown();
    expect(state(id)).toBe('interrupted');
    expect((await call(`/api/agents/${id}/recover`)).status).toBe(200);
    await waitFor(() => state(id) === 'waiting_for_input', 're-asked');
    expect((await call(`/api/agents/nope/recover`)).status).toBe(404);
  });
});
