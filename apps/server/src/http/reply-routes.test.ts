import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationResponse,
  MessagesResponse,
  REPLY_QUOTE_MAX,
  type Event,
  type EventOfType,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { spawnHarmonizer } from '../test/hierarchy.js';

/**
 * P8-17 (SPEC decision 139): `POST /api/agents/:id/send` with `replyTo` — the quote resolved from
 * the log, foreign and unknown targets refused, a reply to an open clarification answering it.
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

const call = async (path: string, body?: unknown) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
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
const pending = (id: string) => composed.statuses.get(id)?.pendingQuestionId;
const events = <T extends Event['type']>(type: T) =>
  composed.log
    .eventsSince(0)
    .map((e) => e.event)
    .filter((e): e is EventOfType<T> => e.type === type);
const lastSent = () => events('message.sent').at(-1)!;

async function harmonizer(): Promise<string> {
  const h = await spawnHarmonizer(composed.commands, 'scenario:echo');
  await waitFor(() => state(h.id) === 'idle', 'harmonizer idle');
  return h.id;
}
async function send(agentId: string, body: Record<string, unknown>) {
  return call(`/api/agents/${agentId}/send`, body);
}

describe('replying in a chat (P8-17)', () => {
  it('quotes a message of the chat from the log, never the client’s text', async () => {
    const h = await harmonizer();
    const first = await send(h, { text: 'build a CSV tool' });
    const m1 = first.body['messageId'] as string;

    const res = await send(h, {
      text: 'make it fast',
      replyTo: { kind: 'message', id: m1, text: 'forged', sender: { type: 'system' } },
    });
    expect(res.status).toBe(200);
    expect(lastSent()).toMatchObject({
      text: 'make it fast',
      replyTo: { kind: 'message', id: m1, sender: { type: 'user' }, text: 'build a CSV tool' },
    });
    expect(lastSent().replyTo?.answered).toBeUndefined();

    // The chat's two histories carry the quote.
    const conversation = ConversationResponse.parse(
      (await call(`/api/agents/${h}/conversation`)).body,
    );
    const entry = conversation.entries.find((e) => e.messageId === res.body['messageId']);
    expect(entry?.replyTo).toMatchObject({ kind: 'message', id: m1, text: 'build a CSV tool' });
    const messages = MessagesResponse.parse((await call(`/api/agents/${h}/messages`)).body);
    expect(messages.messages.at(-1)?.replyTo?.id).toBe(m1);
  });

  it('caps a long quote and redacts secrets in it', async () => {
    const h = await harmonizer();
    const secret = 'sk-ant-api03-' + 'a'.repeat(40);
    const long = `${secret} ${'y'.repeat(3_000)}`;
    const m1 = (await send(h, { text: long })).body['messageId'] as string;
    expect((await send(h, { text: 'ok', replyTo: { kind: 'message', id: m1 } })).status).toBe(200);
    const quote = lastSent().replyTo!;
    expect(Array.from(quote.text)).toHaveLength(REPLY_QUOTE_MAX);
    expect(quote.text.endsWith('…')).toBe(true);
    expect(quote.text).not.toContain(secret);
  });

  it('quotes an agent’s reply; a removed one is gone (409), a foreign one refused (400)', async () => {
    const h = await harmonizer();
    await send(h, { text: 'hello' });
    await waitFor(() => {
      composed.transcripts.flush();
      return composed.transcripts.read(h).some((c) => c.kind === 'text');
    }, 'a text reply');
    const chunk = composed.transcripts.read(h).find((c) => c.kind === 'text')!;
    const id = `r:${h}:${chunk.seq}`;
    expect((await send(h, { text: 'why?', replyTo: { kind: 'reply', id } })).status).toBe(200);
    expect(lastSent().replyTo).toEqual({
      kind: 'reply',
      id,
      sender: { type: 'agent', id: h },
      text: chunk.text,
    });

    // Another agent's reply id, or nonsense, is not in this chat.
    for (const bad of [`r:a-other:${chunk.seq}`, 'r:x', `r:${h}:999999`]) {
      const res = await send(h, { text: 'why?', replyTo: { kind: 'reply', id: bad } });
      expect(res.status, bad).toBe(400);
      expect(res.body['error']).toBe('reply_target');
    }

    // Retention removed it (P8-02): said so, not "unknown".
    composed.log.db
      .prepare('DELETE FROM transcript_chunks WHERE agent_id = ? AND seq <= ?')
      .run(h, chunk.seq);
    composed.log.db
      .prepare(
        `INSERT INTO transcript_compactions
          (agent_id, through_seq, through_at, last_seq, removed_at, reason)
          VALUES (?, ?, ?, ?, ?, 'age')`,
      )
      .run(h, chunk.seq, chunk.at, chunk.seq, new Date().toISOString());
    const before = events('message.sent').length;
    const gone = await send(h, { text: 'why?', replyTo: { kind: 'reply', id } });
    expect(gone.status).toBe(409);
    expect(gone.body['error']).toBe('reply_target_gone');
    expect(events('message.sent')).toHaveLength(before);
  });

  it('refuses an unknown or foreign target, and a slash command, sending nothing', async () => {
    const h = await harmonizer();
    const other = (
      await call('/api/agents', { runtime: 'fake', prompt: 'scenario:echo', cwd: '/tmp' })
    ).body['agentId'] as string;
    await waitFor(() => state(other) === 'idle', 'other idle');
    const theirs = (await send(other, { text: 'hi' })).body['messageId'] as string;
    const mine = (await send(h, { text: 'hi' })).body['messageId'] as string;
    const before = events('message.sent').length;
    for (const replyTo of [
      { kind: 'message', id: theirs },
      { kind: 'message', id: 'm-nope' },
      { kind: 'question', id: 'q-nope' },
      { kind: 'proposal', id: 'p-nope' },
    ]) {
      const res = await send(h, { text: 'about that', replyTo });
      expect(res.status, replyTo.id).toBe(400);
      expect(res.body['error']).toBe('reply_target');
    }
    const slash = await send(h, { text: '/compact', replyTo: { kind: 'message', id: mine } });
    expect(slash.status).toBe(400);
    expect(events('message.sent')).toHaveLength(before);
  });

  it('quotes a proposal card of the chat', async () => {
    const h = await harmonizer();
    const proposal = (
      await composed.commands.createProposal({
        requestText: 'A CSV to JSON converter',
        kind: 'asteroid',
        proposedBody: { kind: 'asteroid', name: 'Converter' },
        workspace: '/tmp',
        rationale: 'small',
      })
    ).value;
    const res = await send(h, { text: 'smaller?', replyTo: { kind: 'proposal', id: proposal.id } });
    expect(res.status).toBe(200);
    expect(lastSent().replyTo).toEqual({
      kind: 'proposal',
      id: proposal.id,
      sender: { type: 'agent', id: h },
      text: 'A CSV to JSON converter',
    });
  });

  it('answers an open clarification by replying to it; a permission request stays undecided', async () => {
    const h = await harmonizer();
    // A standalone Steward's questions show in the Harmonizer's chat.
    const steward = (
      await call('/api/agents', { runtime: 'fake', prompt: 'scenario:full', cwd: '/tmp' })
    ).body['agentId'] as string;
    await waitFor(() => state(steward) === 'waiting_for_input', 'clarification');
    const q1 = pending(steward)!;
    const question = composed.log.tables.questions.get(q1)!;
    expect(question.kind).toBe('clarification');

    const res = await send(h, {
      text: 'yes, go ahead',
      replyTo: { kind: 'question', id: q1, version: question.version, answerId: 'ans-1' },
    });
    expect(res.status).toBe(200);
    const row = composed.log.tables.questions.get(q1)!;
    expect(row).toMatchObject({
      status: 'answered',
      answer: 'yes, go ahead',
      answeredBy: { type: 'user' },
    });
    expect(events('question.answered').find((e) => e.questionId === q1)).toMatchObject({
      repliedIn: h,
      answerId: 'ans-1',
    });
    // The message comes after the answer, quoting the question, marked answered.
    expect(lastSent()).toMatchObject({
      agentId: h,
      text: 'yes, go ahead',
      replyTo: {
        kind: 'question',
        id: q1,
        sender: { type: 'agent', id: steward },
        text: question.context.text,
        answered: true,
      },
    });
    // No withdrawal noise for the question just answered.
    expect(events('question.cancelled').filter((e) => e.questionId === q1)).toHaveLength(0);

    // The Steward went on to a permission request: a reply only quotes it (decision 7).
    await waitFor(() => pending(steward) !== undefined && pending(steward) !== q1, 'permission');
    const q2 = pending(steward)!;
    const permission = composed.log.tables.questions.get(q2)!;
    expect(permission.kind).toBe('permission');
    const about = await send(h, {
      text: 'what does it push?',
      replyTo: { kind: 'question', id: q2, version: permission.version },
    });
    expect(about.status).toBe(200);
    expect(composed.log.tables.questions.get(q2)?.status).toBe('open');
    expect(events('question.answered').filter((e) => e.questionId === q2)).toHaveLength(0);
    expect(lastSent().replyTo).toMatchObject({ kind: 'question', id: q2 });
    expect(lastSent().replyTo?.answered).toBeUndefined();
  });

  it('a stale reply to a clarification is refused whole; to an answered one it is a message', async () => {
    const h = await harmonizer();
    const asked = (
      await composed.commands.openQuestion({
        kind: 'clarification',
        originAgentId: h,
        context: { text: 'Which licence?' },
        toUser: true,
      })
    ).value;
    expect((await call(`/api/questions/${asked.id}/answer`, { answer: 'MIT' })).status).toBe(200);
    const before = events('message.sent').length;

    const stale = await send(h, {
      text: 'Apache',
      replyTo: { kind: 'question', id: asked.id, version: asked.version },
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('stale');
    expect(events('message.sent')).toHaveLength(before);
    expect(composed.log.tables.questions.get(asked.id)?.answer).toBe('MIT');

    // Without a version (the card was already answered when the user replied): a plain reply.
    const plain = await send(h, { text: 'why MIT?', replyTo: { kind: 'question', id: asked.id } });
    expect(plain.status).toBe(200);
    expect(lastSent().replyTo).toMatchObject({ kind: 'question', id: asked.id });
    expect(lastSent().replyTo?.answered).toBeUndefined();
  });

  it('answers a log-only clarification and names the chat it was answered in', async () => {
    const h = await harmonizer();
    const asked = (
      await composed.commands.openQuestion({
        kind: 'clarification',
        originAgentId: h,
        context: { text: 'Which licence?' },
        toUser: true,
      })
    ).value;
    const res = await send(h, {
      text: 'MIT',
      replyTo: { kind: 'question', id: asked.id, version: asked.version },
    });
    expect(res.status).toBe(200);
    expect(composed.log.tables.questions.get(asked.id)?.answer).toBe('MIT');
    expect(events('question.answered').at(-1)).toMatchObject({
      questionId: asked.id,
      repliedIn: h,
    });
    expect(lastSent().replyTo?.answered).toBe(true);
  });

  it('an agent without a mailbox receives the quote in front of the text', async () => {
    const id = (
      await call('/api/agents', { runtime: 'fake', prompt: 'scenario:echo', cwd: '/tmp' })
    ).body['agentId'] as string;
    await waitFor(() => state(id) === 'idle', 'idle');
    const m1 = (await send(id, { text: 'first' })).body['messageId'] as string;
    expect((await send(id, { text: 'second', replyTo: { kind: 'message', id: m1 } })).status).toBe(
      200,
    );
    expect(lastSent().text).toBe('second');
    await waitFor(() => {
      composed.transcripts.flush();
      return composed.transcripts
        .read(id)
        .some((c) => c.text.includes('(replying to user: "first")\nsecond'));
    }, 'the quoted text delivered');
  });
});
