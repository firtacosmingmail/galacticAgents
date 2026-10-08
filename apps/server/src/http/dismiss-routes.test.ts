import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DISMISSED_BY_USER,
  SUPERSEDED_BY_MESSAGE,
  dismissalOf,
  type Event,
  type EventOfType,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { projectHierarchy } from '../test/hierarchy.js';

/**
 * P9-14 (SPEC decision 135): `POST /api/questions/:id/dismiss` and the automatic withdrawal of an
 * agent's clarifications when the user writes to it directly.
 */

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
    caps: { maxConcurrentAgents: 4 },
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const call = async (path: string, body: unknown = {}, headers: Record<string, string> = {}) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
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
const pending = (id: string) => composed.statuses.get(id)?.pendingQuestionId;
const events = <T extends Event['type']>(type: T) =>
  composed.log
    .eventsSince(0)
    .map((e) => e.event)
    .filter((e): e is EventOfType<T> => e.type === type);
const cancelled = (questionId: string) =>
  events('question.cancelled').find((e) => e.questionId === questionId);
const transcript = (id: string) => {
  composed.transcripts.flush();
  return composed.transcripts.read(id).map((c) => c.text);
};
const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };

async function spawn(prompt: string): Promise<string> {
  const res = await call('/api/agents', { runtime: 'fake', prompt, cwd: '/tmp' });
  expect(res.status).toBe(201);
  return res.body['agentId'] as string;
}

describe('POST /api/questions/:id/dismiss (P9-14)', () => {
  it('withdraws a clarification and denies a permission request, telling the agent', async () => {
    const id = await spawn('scenario:full');
    await waitFor(() => state(id) === 'waiting_for_input', 'clarification');
    const q1 = pending(id)!;
    const version = composed.log.tables.questions.get(q1)!.version;

    expect((await call(`/api/questions/${q1}/dismiss`, { version })).status).toBe(200);
    const e1 = cancelled(q1);
    expect(e1).toMatchObject({
      reason: DISMISSED_BY_USER,
      by: { type: 'user' },
      origin: 'local',
      agentId: id,
    });
    const row = composed.log.tables.questions.get(q1);
    expect(row?.status).toBe('cancelled');
    expect(dismissalOf(row)).toEqual({ by: { type: 'user' }, reason: DISMISSED_BY_USER });
    // The agent read "the user did not answer" and went on to its permission request.
    await waitFor(() => pending(id) !== undefined && pending(id) !== q1, 'permission');
    expect(transcript(id).some((l) => l.includes('The user did not answer this question'))).toBe(
      true,
    );

    const q2 = pending(id)!;
    expect(composed.log.tables.questions.get(q2)?.kind).toBe('permission');
    expect((await call(`/api/questions/${q2}/dismiss`)).status).toBe(200);
    expect(cancelled(q2)).toMatchObject({ reason: DISMISSED_BY_USER, by: { type: 'user' } });
    await waitFor(() => state(id) === 'idle', 'idle after the refusal');
    // Denied, never allowed: the push did not run.
    expect(transcript(id).some((l) => /permission denied for Bash.*dismissed/.test(l))).toBe(true);
    expect(events('agent.tool_call').some((e) => e.agentId === id && e.toolName === 'Bash')).toBe(
      false,
    );
    expect(events('question.answered').filter((e) => e.questionId === q2)).toHaveLength(0);
  });

  it('refuses a stale, a repeated and an unknown dismissal', async () => {
    const id = await spawn('scenario:asks');
    await waitFor(() => state(id) === 'waiting_for_input', 'clarification');
    const q = pending(id)!;
    const version = composed.log.tables.questions.get(q)!.version;
    const stale = await call(`/api/questions/${q}/dismiss`, { version: version + 5 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: 'stale' });
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');

    expect((await call(`/api/questions/${q}/dismiss`, { version })).status).toBe(200);
    const again = await call(`/api/questions/${q}/dismiss`, { version });
    expect(again.status).toBe(409);
    expect(again.body['message']).toMatch(/already withdrawn/);
    expect((await call('/api/questions/q-nope/dismiss')).status).toBe(404);
    expect((await call(`/api/questions/${q}/dismiss`, { version: -1 })).status).toBe(400);
  });

  it('refuses dismissing an answered question, saying who answered', async () => {
    const id = await spawn('scenario:asks');
    await waitFor(() => state(id) === 'waiting_for_input', 'clarification');
    const q = pending(id)!;
    expect((await call(`/api/questions/${q}/answer`, { answer: 'ISO 8601' })).status).toBe(200);
    const res = await call(`/api/questions/${q}/dismiss`);
    expect(res.status).toBe(409);
    expect(res.body['message']).toMatch(/already answered by the user/);
  });

  it('takes a dismissal from a remote client and logs where it came from (decision 90)', async () => {
    const id = await spawn('scenario:permission');
    await waitFor(() => state(id) === 'waiting_for_input', 'permission');
    const q = pending(id)!;
    expect((await call(`/api/questions/${q}/dismiss`, {}, REMOTE)).status).toBe(200);
    expect(cancelled(q)).toMatchObject({ by: { type: 'user' }, origin: 'remote' });
  });

  it("dismisses a brain's own question in the log and wakes nobody's session", async () => {
    const { commands, log } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/tmp' })).value;
    const { harmonizer, waykeeper } = await projectHierarchy(commands, project.id);
    const q = (
      await commands.openQuestion({
        kind: 'clarification',
        originAgentId: waykeeper.id,
        context: { text: 'Which licence?' },
      })
    ).value;
    expect(q.holder).toEqual({ type: 'agent', id: harmonizer.id });
    expect((await call(`/api/questions/${q.id}/dismiss`)).status).toBe(200);
    expect(log.tables.questions.get(q.id)?.status).toBe('cancelled');
    expect(cancelled(q.id)).toMatchObject({
      reason: DISMISSED_BY_USER,
      by: { type: 'user' },
      holders: [harmonizer.id],
    });
  });
});

describe('a direct message supersedes the agent’s open clarifications (P9-14)', () => {
  it("withdraws a Waykeeper's own clarifications, never a permission or a toUser question", async () => {
    const { commands, log } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/tmp' })).value;
    const { harmonizer, waykeeper } = await projectHierarchy(commands, project.id);
    const ask = async (text: string, toUser = false) =>
      (
        await commands.openQuestion({
          kind: 'clarification',
          originAgentId: waykeeper.id,
          context: { text },
          ...(toUser ? { toUser } : {}),
        })
      ).value.id;
    const a = await ask('Which licence?');
    const b = await ask('Dark mode too?');
    const conflict = await ask('The merge conflicts with outside commits: what now?', true);
    const permission = (
      await commands.openQuestion({
        kind: 'permission',
        originAgentId: waykeeper.id,
        context: { text: 'May I push?' },
      })
    ).value.id;
    const hq = await ask('Which font?'); // a third plain one, answered first
    await commands.answerQuestion({ questionId: hq, answer: 'MIT', by: { type: 'user' } });
    const harmonizers = (
      await commands.openQuestion({
        kind: 'clarification',
        originAgentId: harmonizer.id,
        context: { text: 'Anything else on CSV?' },
      })
    ).value.id;

    // A slash command is no reply: nothing is withdrawn.
    expect((await call(`/api/agents/${waykeeper.id}/send`, { text: '/compact' })).status).toBe(200);
    expect(log.tables.questions.get(a)?.status).toBe('open');

    expect(
      (await call(`/api/agents/${waykeeper.id}/send`, { text: 'Use MIT and skip dark mode' }))
        .status,
    ).toBe(200);
    for (const q of [a, b]) {
      expect(log.tables.questions.get(q)?.status).toBe('cancelled');
      expect(cancelled(q)).toMatchObject({
        reason: SUPERSEDED_BY_MESSAGE,
        by: { type: 'system' },
        agentId: waykeeper.id,
      });
    }
    expect(log.tables.questions.get(conflict)?.status).toBe('open');
    expect(log.tables.questions.get(permission)?.status).toBe('open');
    expect(log.tables.questions.get(hq)?.status).toBe('answered');

    // The Harmonizer, the user's single contact, keeps its questions open while they talk.
    expect(
      (await call(`/api/agents/${harmonizer.id}/send`, { text: 'not yet, thanks' })).status,
    ).toBe(200);
    expect(log.tables.questions.get(harmonizers)?.status).toBe('open');
  });

  it('tells a live session through its adapter and leaves its permission request open', async () => {
    const id = await spawn('scenario:full');
    await waitFor(() => state(id) === 'waiting_for_input', 'clarification');
    const q1 = pending(id)!;
    expect((await call(`/api/agents/${id}/send`, { text: 'do only the first one' })).status).toBe(
      200,
    );
    expect(cancelled(q1)).toMatchObject({ reason: SUPERSEDED_BY_MESSAGE, by: { type: 'system' } });
    await waitFor(() => pending(id) !== undefined && pending(id) !== q1, 'permission');
    expect(transcript(id).some((l) => l.includes('Their new message reaches you next'))).toBe(true);
    const q2 = pending(id)!;
    // Another message never withdraws a permission request.
    expect((await call(`/api/agents/${id}/send`, { text: 'and push it' })).status).toBe(200);
    expect(composed.log.tables.questions.get(q2)?.status).toBe('open');
    expect((await call(`/api/questions/${q2}/answer`, { answer: 'allow' })).status).toBe(200);
    // The queued message reaches the agent once its turn ends.
    await waitFor(
      () => transcript(id).some((l) => l === 'received: do only the first one'),
      'message delivered',
    );
  });
});
