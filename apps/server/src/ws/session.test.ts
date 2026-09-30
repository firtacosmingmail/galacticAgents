import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { EventEnvelope, ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { openDatabase } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { connectWs, startTestApp, TEST_TOKEN } from '../test/harness.js';
import { CLOSE_PROTOCOL_VIOLATION } from './gateway.js';

let log: EventLog;
let t: Awaited<ReturnType<typeof startTestApp>>;

const idle = (i: number) => ({ type: 'agent.idle', agentId: `a-${i}` }) as const;
const emit = (i: number) => log.runCommand(({ emit }) => emit(idle(i))).events[0]!;

beforeEach(async () => {
  log = new EventLog(openDatabase(':memory:'), { now: () => fx.NOW, maxReplay: 100 });
  t = await startTestApp({ log });
});
afterEach(() => t.stop());

/** Opens an authenticated socket and resolves once `n` server messages arrived. */
function open(lastEventId?: number) {
  const ws = new WebSocket(t.wsUrl);
  const messages: ServerMessage[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  ws.on('message', (d) => {
    messages.push(JSON.parse(d.toString()) as ServerMessage);
    for (const w of waiters.splice(0)) {
      if (messages.length >= w.n) w.resolve();
      else waiters.push(w);
    }
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN, lastEventId })));
  const upTo = (n: number) =>
    new Promise<ServerMessage[]>((resolve) => {
      if (messages.length >= n) resolve(messages);
      else waiters.push({ n, resolve: () => resolve(messages) });
    });
  return { ws, messages, upTo, closed };
}

describe('websocket stream', () => {
  it('sends a snapshot on a fresh hello, then live events in order', async () => {
    log.runCommand(({ tables, emit }) => {
      tables.bodies.insert(fx.body);
      emit({ type: 'body.freed', bodyId: 'b-earth' });
    });
    const c = open();
    const [first] = await c.upTo(1);
    expect(first).toMatchObject({
      type: 'snapshot',
      seq: 1,
      bodies: [fx.body],
      agents: [],
      statuses: [],
    });

    emit(1);
    emit(2);
    const msgs = await c.upTo(3);
    expect(msgs.slice(1)).toEqual([
      { type: 'event', seq: 2, at: fx.NOW, event: idle(1) },
      { type: 'event', seq: 3, at: fx.NOW, event: idle(2) },
    ]);
    c.ws.close();
  });

  it('replays exactly the missed events on resume, then caught_up, then live', async () => {
    for (let i = 1; i <= 5; i++) emit(i);
    const c = open(2);
    const msgs = await c.upTo(4);
    expect(msgs).toEqual([
      { type: 'event', seq: 3, at: fx.NOW, event: idle(3) },
      { type: 'event', seq: 4, at: fx.NOW, event: idle(4) },
      { type: 'event', seq: 5, at: fx.NOW, event: idle(5) },
      { type: 'caught_up', seq: 5 },
    ]);
    emit(6);
    expect((await c.upTo(5))[4]).toEqual({ type: 'event', seq: 6, at: fx.NOW, event: idle(6) });
    c.ws.close();
  });

  it('a client that is fully up to date gets only caught_up', async () => {
    emit(1);
    const c = open(1);
    expect(await c.upTo(1)).toEqual([{ type: 'caught_up', seq: 1 }]);
    c.ws.close();
  });

  it('falls back to a snapshot when lastEventId is too old or ahead of the log', async () => {
    for (let i = 1; i <= 150; i++) emit(i);
    const old = open(10);
    expect((await old.upTo(1))[0]).toMatchObject({ type: 'snapshot', seq: 150 });
    old.ws.close();
    const ahead = open(999);
    expect((await ahead.upTo(1))[0]).toMatchObject({ type: 'snapshot', seq: 150 });
    ahead.ws.close();
  });

  it('never duplicates or skips an event committed around the hello', async () => {
    const c = open();
    const seen: number[] = [];
    c.ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      if (m.type === 'event') seen.push(m.seq);
    });
    for (let i = 1; i <= 10; i++) emit(i); // land before or around the hello
    const [first] = await c.upTo(1);
    expect(first?.type).toBe('snapshot');
    const snapshotSeq = (first as { seq: number }).seq;
    for (let i = 11; i <= 20; i++) emit(i); // definitely live
    await c.upTo(1 + (20 - snapshotSeq));
    // The snapshot covers 1..snapshotSeq; the stream must continue exactly there, once each.
    expect(seen).toEqual(Array.from({ length: 20 - snapshotSeq }, (_, i) => snapshotSeq + i + 1));
    c.ws.close();
  });

  it('answers ping and closes on protocol violations', async () => {
    const out = await connectWs(t.wsUrl, {
      send: [{ type: 'hello', token: TEST_TOKEN }, { type: 'ping' }, { type: 'bogus' }],
    });
    expect(out.messages.map((m) => m.type)).toEqual(['snapshot', 'pong', 'error']);
    expect(out.closeCode).toBe(CLOSE_PROTOCOL_VIOLATION);

    const twice = await connectWs(t.wsUrl, {
      send: [
        { type: 'hello', token: TEST_TOKEN },
        { type: 'hello', token: TEST_TOKEN },
      ],
    });
    expect(twice.closeCode).toBe(CLOSE_PROTOCOL_VIOLATION);
  });

  it('stops publishing to a closed socket', async () => {
    const c = open();
    await c.upTo(1);
    c.ws.close();
    await c.closed;
    expect(() => emit(1)).not.toThrow();
  });

  it('drops a slow consumer instead of buffering forever', async () => {
    const { createSessionHandler } = await import('./session.js');
    const warnings: string[] = [];
    const sink = { info: () => {}, warn: (m: string) => warnings.push(m) };
    const slow = await startTestApp({
      log,
      onSession: createSessionHandler(log, { maxBufferedBytes: 1, log: sink }),
    });
    try {
      const ws = new WebSocket(slow.wsUrl);
      const closed = new Promise<number>((resolve) => ws.on('close', resolve));
      await new Promise<void>((resolve) => ws.on('open', resolve));
      ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN }));
      await new Promise<void>((resolve) => ws.once('message', () => resolve())); // the snapshot
      ws.pause(); // stop reading: the server side buffers
      const big = 'x'.repeat(64 * 1024);
      for (let i = 0; i < 400; i++) {
        log.runCommand(({ emit }) => emit({ type: 'agent.progress', agentId: 'a', summary: big }));
      }
      expect(warnings.some((w) => w.includes('slow consumer'))).toBe(true);
      ws.resume(); // a paused client cannot observe the close; drain and check it was cut
      expect(await closed).toBe(1006); // terminated, not closed: the backlog would block a close frame
    } finally {
      await slow.stop();
    }
  });
});

describe('dev routes', () => {
  it('appends validated events with the bearer token and lists them', async () => {
    const headers = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' };
    const seen: EventEnvelope[] = [];
    log.subscribe((e) => seen.push(e));

    const ok = await fetch(`${t.baseUrl}/dev/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(idle(1)),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ seq: 1 });
    expect(seen.map((e) => e.seq)).toEqual([1]);

    const bad = await fetch(`${t.baseUrl}/dev/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'nope' }),
    });
    expect(bad.status).toBe(400);
    const noAuth = await fetch(`${t.baseUrl}/dev/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noAuth.status).toBe(401);

    const list = await fetch(`${t.baseUrl}/dev/events?since=0`, { headers });
    expect(await list.json()).toEqual({ seq: 1, events: [{ seq: 1, at: fx.NOW, event: idle(1) }] });
  });
});
