import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { spawnHarmonizer, spawnWaykeeper } from '../test/hierarchy.js';

/** P8-19 (SPEC decision 141): the routes of a question set. */

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

const call = async (path: string, body: unknown = {}) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const row = (id: string) => composed.log.tables.questions.get(id)!;

async function openSet(toUser = true) {
  const h = await spawnHarmonizer(composed.commands, 'scenario:echo');
  const rows = (
    await composed.commands.openQuestionSet({
      originAgentId: h.id,
      title: 'Setup',
      toUser,
      questions: [{ text: 'Licence?', options: ['MIT', 'Apache'] }, { text: 'Name?' }],
    })
  ).value;
  const setId = rows[0]!.context.set!.id;
  return { rows, setId };
}

describe('question-set routes (P8-19)', () => {
  it('answers every row in one call; a retry under the answerId is a duplicate', async () => {
    const { rows, setId } = await openSet();
    const body = {
      answers: [
        { questionId: rows[0]!.id, answer: { choices: ['MIT'] } },
        { questionId: rows[1]!.id, answer: { choices: [], text: 'Atlas' } },
      ],
      answerId: 'a-1',
    };
    const first = await call(`/api/question-sets/${setId}/answer`, body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    expect(row(rows[0]!.id)).toMatchObject({ status: 'answered', answer: 'MIT' });
    expect(row(rows[1]!.id)).toMatchObject({ status: 'answered', answer: 'Atlas' });

    const retry = await call(`/api/question-sets/${setId}/answer`, body);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true, duplicate: true });
  });

  it('refuses a stale answer with 409 and a partial send with 400', async () => {
    const { rows, setId } = await openSet();
    const partial = await call(`/api/question-sets/${setId}/answer`, {
      answers: [{ questionId: rows[0]!.id, answer: { choices: ['MIT'] } }],
    });
    expect(partial.status).toBe(400);
    expect(partial.body['error']).toBe('invalid');
    expect(row(rows[0]!.id).status).toBe('open');

    const stale = await call(`/api/question-sets/${setId}/answer`, {
      answers: [
        {
          questionId: rows[0]!.id,
          version: row(rows[0]!.id).version + 5,
          answer: { choices: ['MIT'] },
        },
        { questionId: rows[1]!.id, answer: { choices: [], skipped: true } },
      ],
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('stale');
    expect(row(rows[1]!.id).status).toBe('open');
  });

  it('rejects a malformed body with 400 and an unknown set with 404', async () => {
    expect((await call('/api/question-sets/qs-x/answer', { nope: 1 })).status).toBe(400);
    const missing = await call('/api/question-sets/qs-x/answer', { answers: [] });
    expect(missing.status).toBe(404);
  });

  it('saves and clears a draft without bumping the version', async () => {
    const { rows } = await openSet();
    const id = rows[0]!.id;
    const version = row(id).version;
    const saved = await call(`/api/questions/${id}/draft`, { draft: { choices: ['MIT'] } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ok: true });
    expect(row(id).meta?.['draft']).toEqual({ choices: ['MIT'] });
    expect(row(id).version).toBe(version);
    expect((await call(`/api/questions/${id}/draft`, { draft: null })).status).toBe(200);
    expect(row(id).meta?.['draft']).toBeUndefined();
  });

  it('refuses a draft on a plain question or an agent-held row with 400', async () => {
    const h = await spawnHarmonizer(composed.commands, 'scenario:echo');
    const single = (
      await composed.commands.openQuestion({
        kind: 'clarification',
        originAgentId: h.id,
        context: { text: 'Which licence?' },
        toUser: true,
      })
    ).value;
    expect(
      (await call(`/api/questions/${single.id}/draft`, { draft: { choices: [] } })).status,
    ).toBe(400);
    // A Waykeeper's own set is held by the Harmonizer, not the user.
    const project = (await composed.commands.createProject({ name: 'CSV', workspace: '/tmp' }))
      .value;
    const waykeeper = await spawnWaykeeper(composed.commands, project.id, h.id);
    const held = (
      await composed.commands.openQuestionSet({
        originAgentId: waykeeper.id,
        title: 'Setup',
        questions: [{ text: 'A?' }, { text: 'B?' }],
      })
    ).value;
    expect(held[0]!.holder.type).toBe('agent');
    const res = await call(`/api/questions/${held[0]!.id}/draft`, { draft: { choices: [] } });
    expect(res.status).toBe(400);
  });

  it('dismisses every open row of the set', async () => {
    const { rows, setId } = await openSet();
    const res = await call(`/api/question-sets/${setId}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    for (const q of rows) expect(row(q.id).status).toBe('cancelled');
    expect((await call(`/api/question-sets/${setId}/dismiss`)).status).toBe(409);
  });

  it('refuses the single-question answer and dismiss on a set row with 400', async () => {
    const { rows } = await openSet();
    const a = await call(`/api/questions/${rows[0]!.id}/answer`, { answer: 'MIT' });
    expect(a.status).toBe(400);
    expect(String(a.body['message'])).toContain('part of set');
    const d = await call(`/api/questions/${rows[0]!.id}/dismiss`);
    expect(d.status).toBe(400);
    expect(row(rows[0]!.id).status).toBe('open');
  });
});
