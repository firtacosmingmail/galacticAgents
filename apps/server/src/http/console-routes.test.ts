import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  MessagesResponse,
  PERMISSION_POLICY_PRESETS,
  type Id,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { projectHierarchy, spawnHarmonizer } from '../test/hierarchy.js';

/**
 * P2-18: the REST routes the hierarchy console adds — deciding proposal cards, answering with the
 * question's version, and the chat history of an agent.
 */

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
    caps: { maxConcurrentAgents: 3 },
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

const call = async (method: 'GET' | 'POST', path: string, body?: unknown, token = TEST_TOKEN) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const post = (path: string, body?: unknown) => call('POST', path, body ?? {});

async function workCard(name = 'CSV tool'): Promise<Id> {
  const { value } = await composed.commands.createProposal({
    requestText: `build ${name}`,
    kind: 'moon',
    proposedBody: { kind: 'moon', name },
    workspace: `/w/${name.toLowerCase().replace(/\W+/g, '-')}`,
    rationale: 'small',
    meta: { request: { type: 'new_project', name } },
  });
  return value.id;
}

describe('POST /api/proposals/:id/decide (P2-18)', () => {
  it('needs the token', async () => {
    const id = await workCard();
    const res = await call('POST', `/api/proposals/${id}/decide`, { decision: 'approve' }, 'nope');
    expect(res.status).toBe(401);
    expect(composed.log.tables.proposals.get(id)?.state).toBe('pending');
  });

  it('edits size, body, workspace and the git consent, then approves: the project is created', async () => {
    const id = await workCard();
    const edit = await post(`/api/proposals/${id}/decide`, {
      decision: 'edit',
      changes: {
        kind: 'planet',
        proposedBody: { kind: 'planet', name: 'CSV planet' },
        workspace: '/w/csv-planet',
        initGit: true,
      },
    });
    expect(edit).toMatchObject({ status: 200, body: { ok: true, state: 'edited' } });
    expect(composed.log.tables.proposals.get(id)).toMatchObject({
      kind: 'planet',
      workspace: '/w/csv-planet',
      meta: { initGit: true },
    });
    const approve = await post(`/api/proposals/${id}/decide`, { decision: 'approve' });
    expect(approve).toMatchObject({ status: 200, body: { ok: true, state: 'approved' } });
    const project = composed.log.tables.projects.all().find((p) => p.meta?.['proposalId'] === id);
    expect(project).toMatchObject({ workspace: '/w/csv-planet', meta: { initGit: true } });
    expect(composed.log.tables.bodies.get(project!.bodyId)?.kind).toBe('planet');
    // Approval is final.
    const again = await post(`/api/proposals/${id}/decide`, { decision: 'reject' });
    expect(again.status).toBe(409);
    expect(again.body['message']).toMatch(/approved/);
  });

  it('sets the trust level on the card: a local approval makes the project trusted, a remote one is floored (P2-22)', async () => {
    const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };
    const decide = async (id: Id, body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${t.baseUrl}/api/proposals/${id}/decide`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      });
      return res.status;
    };
    const projectOf = (id: Id) =>
      composed.log.tables.projects.all().find((p) => p.meta?.['proposalId'] === id);

    const local = await workCard('Lab');
    expect(await decide(local, { decision: 'edit', changes: { trust: 'trusted' } })).toBe(200);
    expect(composed.log.tables.proposals.get(local)?.meta).toMatchObject({ trust: 'trusted' });
    expect(await decide(local, { decision: 'edit', changes: { trust: 'yolo' } })).toBe(400);
    expect(await decide(local, { decision: 'approve' })).toBe(200);
    expect(projectOf(local)?.permissionPolicy).toEqual(PERMISSION_POLICY_PRESETS.trusted);

    const remote = await workCard('Far');
    expect(await decide(remote, { decision: 'edit', changes: { trust: 'trusted' } }, REMOTE)).toBe(
      200,
    );
    expect(await decide(remote, { decision: 'approve' }, REMOTE)).toBe(200);
    expect(projectOf(remote)?.permissionPolicy).toEqual({
      ...DEFAULT_PERMISSION_POLICY,
      unclassified: 'ask',
    });

    // The edit form's way: a remote edit cannot make a project trusted either.
    const edit = (headers: Record<string, string> = {}) =>
      fetch(`${t.baseUrl}/api/control`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          target: { kind: 'project', id: projectOf(remote)!.id },
          action: {
            action: 'edit',
            changes: { permissionPolicy: PERMISSION_POLICY_PRESETS.trusted },
          },
        }),
      });
    expect((await edit(REMOTE)).status).toBe(200);
    expect(projectOf(remote)?.permissionPolicy?.unclassified).toBe('ask');
    expect(projectOf(remote)?.permissionPolicy?.rules['network']).toBe('ask');
    expect((await edit()).status).toBe(200);
    expect(projectOf(remote)?.permissionPolicy).toEqual(PERMISSION_POLICY_PRESETS.trusted);
  });

  it('rejects with a reason (the draft stays editable) and parks by hand', async () => {
    const id = await workCard();
    expect(
      await post(`/api/proposals/${id}/decide`, { decision: 'reject', reason: 'not now' }),
    ).toMatchObject({ status: 200, body: { state: 'rejected' } });
    const rejected = composed.log
      .eventsSince(0, 1_000)
      .map((e) => e.event)
      .find((e) => e.type === 'proposal.rejected');
    expect(rejected).toMatchObject({ proposalId: id, reason: 'not now' });
    expect(
      await post(`/api/proposals/${id}/decide`, {
        decision: 'edit',
        changes: { workspace: '/w/other' },
      }),
    ).toMatchObject({ status: 200, body: { state: 'edited' } });
    expect(
      await post(`/api/proposals/${id}/decide`, { decision: 'park', reason: 'later' }),
    ).toMatchObject({ status: 200, body: { state: 'parked' } });
  });

  it('refuses bad bodies, unknown cards, invalid edits and editing a plan card', async () => {
    const id = await workCard();
    expect((await post(`/api/proposals/${id}/decide`, { decision: 'maybe' })).status).toBe(400);
    expect(
      (await post(`/api/proposals/${id}/decide`, { decision: 'edit', changes: { name: 'x' } }))
        .status,
    ).toBe(400);
    expect((await post('/api/proposals/pr-nope/decide', { decision: 'approve' })).status).toBe(404);
    // The body's kind must match the card's.
    const mismatch = await post(`/api/proposals/${id}/decide`, {
      decision: 'edit',
      changes: { kind: 'planet' },
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body['message']).toMatch(/proposed body is a moon/);

    const { value: project } = await composed.commands.createProject({
      name: 'Plans',
      workspace: '/w/plans',
    });
    const { waykeeper } = await projectHierarchy(composed.commands, project.id);
    const { value: plan } = await composed.commands.proposePlan({
      projectId: project.id,
      waykeeperId: waykeeper.id,
      summary: 'two steps',
      tasks: [{ description: 'one' }, { description: 'two' }],
    });
    const editPlan = await post(`/api/proposals/${plan.proposal.id}/decide`, {
      decision: 'edit',
      changes: { workspace: '/w/x' },
    });
    expect(editPlan.status).toBe(400);
    expect(editPlan.body['message']).toMatch(/edit its tasks/);
    expect(
      await post(`/api/proposals/${plan.proposal.id}/decide`, { decision: 'approve' }),
    ).toMatchObject({ status: 200, body: { state: 'approved' } });
    expect(plan.tasks.map((x) => composed.log.tables.tasks.get(x.id)?.state)).toEqual([
      'approved',
      'approved',
    ]);
  });
});

describe('POST /api/questions/:id/answer with a version (P2-18)', () => {
  it('answers a question no live session waits on, and refuses a stale answer with who answered', async () => {
    const hq = await spawnHarmonizer(composed.commands);
    const ask = async () =>
      (
        await composed.commands.openQuestion({
          kind: 'clarification',
          originAgentId: hq.id,
          context: { text: 'Anything else on CSV tool?', options: ['Close CSV tool'] },
          toUser: true,
        })
      ).value;
    const q = await ask();
    const ok = await post(`/api/questions/${q.id}/answer`, {
      answer: 'Close CSV tool',
      version: q.version,
    });
    expect(ok.status).toBe(200);
    expect(composed.log.tables.questions.get(q.id)).toMatchObject({
      status: 'answered',
      answer: 'Close CSV tool',
      answeredBy: { type: 'user' },
    });
    const late = await post(`/api/questions/${q.id}/answer`, {
      answer: 'Something else',
      version: q.version,
    });
    expect(late.status).toBe(409);
    expect(late.body).toMatchObject({ error: 'stale' });
    expect(late.body['message']).toMatch(/already answered by the user/);

    // A version that moved on (here: an outdated one) is refused before anything is written.
    const q2 = await ask();
    const stale = await post(`/api/questions/${q2.id}/answer`, {
      answer: 'x',
      version: q2.version + 1,
    });
    expect(stale).toMatchObject({ status: 409, body: { error: 'stale' } });
    expect(composed.log.tables.questions.get(q2.id)?.status).toBe('open');
    expect((await post('/api/questions/q-nope/answer', { answer: 'x' })).status).toBe(404);
    expect((await post(`/api/questions/${q2.id}/answer`, { answer: '' })).status).toBe(400);
  });

  it('an adapter that fails to take the answer is a 500 that echoes nothing', async () => {
    const spawned = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/w/s',
    });
    expect(spawned.ok).toBe(true);
    const agentId = spawned.ok ? spawned.agent.id : '';
    let questionId: string | undefined;
    for (let i = 0; i < 200 && !questionId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      questionId = composed.statuses.get(agentId)?.pendingQuestionId;
    }
    const adapter = composed.runtime.adapter('fake')!;
    adapter.answer = () =>
      Promise.reject(new Error('cli said: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'));
    const res = await post(`/api/questions/${questionId!}/answer`, { answer: 'ISO 8601' });
    expect(res).toEqual({ status: 500, body: { error: 'internal' } });
    expect(composed.log.tables.questions.get(questionId!)?.status).toBe('open');
  });
});

describe('POST /api/questions/:id/answer with an answerId (P7-05)', () => {
  const askUser = async () => {
    const hq = await spawnHarmonizer(composed.commands);
    return (
      await composed.commands.openQuestion({
        kind: 'clarification',
        originAgentId: hq.id,
        context: { text: 'Which format?' },
        toUser: true,
      })
    ).value;
  };

  it('a retry with the same answerId after a lost acknowledgement is ok and logs nothing more', async () => {
    const q = await askUser();
    const body = { answer: 'ISO 8601', version: q.version, answerId: 'ans-1' };
    const first = await post(`/api/questions/${q.id}/answer`, body);
    expect(first).toEqual({ status: 200, body: { ok: true } });
    const seq = composed.log.currentSeq();
    const retry = await post(`/api/questions/${q.id}/answer`, body);
    expect(retry).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(composed.log.currentSeq()).toBe(seq);
    const row = composed.log.tables.questions.get(q.id)!;
    expect(row).toMatchObject({
      status: 'answered',
      answer: 'ISO 8601',
      meta: { answerId: 'ans-1' },
    });
    const answered = composed.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .filter((e) => e.event.type === 'question.answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]!.event).toMatchObject({ answerId: 'ans-1' });
  });

  it('another answerId (another device) is refused as stale, saying who answered', async () => {
    const q = await askUser();
    await post(`/api/questions/${q.id}/answer`, {
      answer: 'ISO 8601',
      version: q.version,
      answerId: 'phone',
    });
    const other = await post(`/api/questions/${q.id}/answer`, {
      answer: 'RFC 2822',
      version: q.version,
      answerId: 'laptop',
    });
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ error: 'stale' });
    expect(other.body['message']).toMatch(/already answered by the user/);
    expect(composed.log.tables.questions.get(q.id)?.answer).toBe('ISO 8601');
  });

  it('a stale version is refused even with a fresh answerId, and a withdrawn question is stale', async () => {
    const q = await askUser();
    const moved = await post(`/api/questions/${q.id}/answer`, {
      answer: 'x',
      version: q.version + 1,
      answerId: 'ans-x',
    });
    expect(moved).toMatchObject({ status: 409, body: { error: 'stale' } });
    await composed.commands.withdrawQuestion(q.id, 'no longer needed', { type: 'system' });
    const withdrawn = await post(`/api/questions/${q.id}/answer`, {
      answer: 'x',
      version: q.version,
      answerId: 'ans-y',
    });
    // P9-14: a late answer to a withdrawn (dismissed) question reads "already withdrawn".
    expect(withdrawn).toMatchObject({
      status: 409,
      body: { error: 'stale', message: `question ${q.id} was already withdrawn` },
    });
  });

  it('a retry while the answer is still being handed to the adapter waits for it (live session)', async () => {
    const spawned = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/w/s',
    });
    const agentId = spawned.ok ? spawned.agent.id : '';
    let questionId: string | undefined;
    for (let i = 0; i < 200 && !questionId; i++) {
      await new Promise((r) => setTimeout(r, 10));
      questionId = composed.statuses.get(agentId)?.pendingQuestionId;
    }
    const q = composed.log.tables.questions.get(questionId!)!;
    const adapter = composed.runtime.adapter('fake')!;
    const original = adapter.answer.bind(adapter);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    adapter.answer = async (...args: Parameters<typeof original>) => {
      await gate;
      return original(...args);
    };
    const body = { answer: 'ISO 8601', version: q.version, answerId: 'ans-live' };
    const first = post(`/api/questions/${q.id}/answer`, body);
    await new Promise((r) => setTimeout(r, 30));
    const retry = post(`/api/questions/${q.id}/answer`, body);
    await new Promise((r) => setTimeout(r, 30));
    release();
    expect((await first).status).toBe(200);
    expect((await retry).status).toBe(200);
    expect(composed.log.tables.questions.get(q.id)).toMatchObject({
      status: 'answered',
      meta: { answerId: 'ans-live' },
    });
    // After it is recorded, one more retry is a duplicate.
    expect(await post(`/api/questions/${q.id}/answer`, body)).toEqual({
      status: 200,
      body: { ok: true, duplicate: true },
    });
  });
});

describe('GET /api/agents/:id/messages (P2-18)', () => {
  it("returns the agent's messages oldest first, with who sent them", async () => {
    const hq = await spawnHarmonizer(composed.commands);
    await new Promise((r) => setTimeout(r, 30));
    expect((await post(`/api/agents/${hq.id}/send`, { text: 'first' })).status).toBe(200);
    expect((await post(`/api/agents/${hq.id}/send`, { text: 'second' })).status).toBe(200);
    const res = await call('GET', `/api/agents/${hq.id}/messages`);
    expect(res.status).toBe(200);
    const { messages } = MessagesResponse.parse(res.body);
    expect(messages.map((m) => [m.text, m.sender.type])).toEqual([
      ['first', 'user'],
      ['second', 'user'],
    ]);
    expect(messages[0]!.seq).toBeLessThan(messages[1]!.seq);
    expect((await call('GET', '/api/agents/a-nope/messages')).status).toBe(404);
    expect((await call('GET', `/api/agents/${hq.id}/messages`, undefined, 'bad')).status).toBe(401);
  });

  it('returns the newest 200, as the stream carries them, through the index', async () => {
    const hq = await spawnHarmonizer(composed.commands);
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    composed.log.runCommand((ctx) => {
      for (let i = 0; i < 205; i++) {
        ctx.emit({
          type: 'message.sent',
          messageId: `m-${i}`,
          agentId: hq.id,
          sender: { type: 'user' },
          // What the user typed is kept as written (TECHNOLOGY §8): the stream carries it so.
          text: i === 204 ? `my key is ${key}` : `line ${i}`,
          interrupt: false,
        });
        // Another agent's messages are not this chat's.
        if (i % 50 === 0) {
          ctx.emit({
            type: 'message.sent',
            messageId: `o-${i}`,
            agentId: 'a-other',
            sender: { type: 'user' },
            text: 'elsewhere',
            interrupt: false,
          });
        }
      }
    });
    const { messages } = MessagesResponse.parse(
      (await call('GET', `/api/agents/${hq.id}/messages`)).body,
    );
    expect(messages).toHaveLength(200);
    expect(messages[0]!.messageId).toBe('m-5');
    expect(messages.at(-1)!.text).toBe(`my key is ${key}`);
    expect(messages.every((m, i) => i === 0 || m.seq > messages[i - 1]!.seq)).toBe(true);
    const plan = composed.log.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id FROM events
          WHERE type = ? AND json_extract(payload, '$.agentId') = ? ORDER BY id DESC LIMIT 200`,
      )
      .all('message.sent', hq.id) as { detail: string }[];
    expect(plan.map((p) => p.detail).join(' ')).toContain('events_type_agent');
  });
});
