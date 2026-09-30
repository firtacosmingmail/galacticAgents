import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage, StatusRecord } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

function open() {
  const ws = new WebSocket(t.wsUrl);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN })));
  const until = (pred: () => boolean, ms = 3_000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (pred()) resolve();
        else if (Date.now() - t0 > ms)
          reject(
            new Error(
              `timeout; got ${JSON.stringify(messages.map((m) => (m.type === 'event' ? m.event.type + '@' + m.seq : m.type === 'status' ? 'status:' + m.statuses.map((s) => s.state).join(',') : m.type)))}`,
            ),
          );
        else setTimeout(tick, 10);
      };
      tick();
    });
  const statuses = () =>
    messages
      .filter((m): m is Extract<ServerMessage, { type: 'status' }> => m.type === 'status')
      .flatMap((m) => m.statuses);
  return { ws, messages, until, statuses, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe('status records over the socket (P1-05)', () => {
  it('a fresh client gets the records in the snapshot and then batched diffs', async () => {
    const spawned = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:long',
      cwd: '/tmp',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const agentId = spawned.agent.id;
    await new Promise((r) => setTimeout(r, 150));
    const c = open();
    await c.until(() => c.messages.some((m) => m.type === 'snapshot'));
    const snapshot = c.messages.find((m) => m.type === 'snapshot') as Extract<
      ServerMessage,
      { type: 'snapshot' }
    >;
    expect(snapshot.statuses.map((s) => [s.agentId, s.state])).toEqual([[agentId, 'working']]);
    expect(snapshot.agents.map((a) => a.id)).toEqual([agentId]);

    await c.until(() => c.statuses().some((s) => s.state === 'finished'));
    const seen: StatusRecord[] = c.statuses();
    expect(seen.every((s) => s.agentId === agentId)).toBe(true);
    // Batched: far fewer status messages than progress events (20 steps at 50 ms, 10 Hz flush).
    const statusMessages = c.messages.filter((m) => m.type === 'status').length;
    const progressEvents = c.messages.filter(
      (m) => m.type === 'event' && m.event.type === 'agent.progress',
    ).length;
    expect(statusMessages).toBeGreaterThan(1);
    expect(statusMessages).toBeLessThanOrEqual(progressEvents + 5); // + finish, + wall-clock ticks
    expect(seen.at(-1)).toMatchObject({ state: 'finished', costSoFar: { usd: 0.0042 } });
    // The client never had to fold agent.* events itself: every event is still on the stream too.
    expect(
      c.messages.filter((m) => m.type === 'event' && m.event.type === 'agent.progress').length,
    ).toBeGreaterThan(0);

    // Transcript subscription works on the same socket (the `long` scenario prints nothing).
    const talker = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:happy',
      cwd: '/tmp',
    });
    if (!talker.ok) throw new Error(talker.reason);
    c.send({ type: 'transcript.subscribe', agentId: talker.agent.id });
    await c.until(() => c.messages.some((m) => m.type === 'transcript'));
    c.ws.close();
  });

  it('a client that resumes by replay gets the current records right after caught_up', async () => {
    const first = open();
    await first.until(() => first.messages.some((m) => m.type === 'snapshot'));
    const snapshot = first.messages.find((m) => m.type === 'snapshot') as Extract<
      ServerMessage,
      { type: 'snapshot' }
    >;
    first.ws.close();
    await new Promise((r) => setTimeout(r, 30));
    const spawned = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:happy',
      cwd: '/tmp',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    await new Promise((r) => setTimeout(r, 150)); // it finishes while nobody listens

    const ws = new WebSocket(t.wsUrl);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          token: TEST_TOKEN,
          lastEventId: snapshot.seq,
          logId: snapshot.logId,
        }),
      ),
    );
    await new Promise<void>((resolve) => {
      const tick = () =>
        messages.some((m) => m.type === 'status') ? resolve() : setTimeout(tick, 10);
      tick();
    });
    const types = messages.map((m) => m.type);
    expect(types.indexOf('caught_up')).toBeGreaterThan(-1);
    expect(types.indexOf('caught_up')).toBeLessThan(types.indexOf('status'));
    const status = messages.find((m) => m.type === 'status') as Extract<
      ServerMessage,
      { type: 'status' }
    >;
    expect(status.statuses.map((s) => [s.agentId, s.state])).toEqual([
      [spawned.agent.id, 'finished'],
    ]);
    // The replayed events include agent.created, so the agents table is complete as well.
    expect(messages.some((m) => m.type === 'event' && m.event.type === 'agent.created')).toBe(true);
    ws.close();
  });

  it('rebuilds the records from the log for a new server on the same database', async () => {
    const spawned = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:happy',
      cwd: '/tmp',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    await new Promise((r) => setTimeout(r, 100));
    const before = composed.statuses.get(spawned.agent.id);
    expect(before?.state).toBe('finished');
    const again = composeRuntime(composed.log.db, { adapters: [new FakeAdapter()] });
    const after = again.statuses.get(spawned.agent.id);
    expect({ ...after, caps: undefined }).toEqual({ ...before, caps: undefined });
    await again.dispose();
  });
});
