import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { openDatabase } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { TranscriptPipeline } from '../runtime/transcripts.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

let log: EventLog;
let transcripts: TranscriptPipeline;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  const db = openDatabase(':memory:');
  log = new EventLog(db, { now: () => fx.NOW });
  transcripts = new TranscriptPipeline(db, { flushMs: 10 });
  t = await startTestApp({ log, transcripts });
});
afterEach(async () => {
  transcripts.dispose();
  await t.stop();
});

function open() {
  const ws = new WebSocket(t.wsUrl);
  const messages: ServerMessage[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
  const ready = new Promise<void>((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN }));
      resolve();
    });
  });
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const until = (pred: () => boolean, ms = 2_000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (pred()) resolve();
        else if (Date.now() - t0 > ms)
          reject(new Error(`timeout; got ${JSON.stringify(messages)}`));
        else setTimeout(tick, 10);
      };
      tick();
    });
  return { ws, messages, ready, send, until };
}

const FAKE_KEY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';

describe('transcript stream over the socket', () => {
  it('delivers history then live chunks in seq order, redacted, for subscribed agents only', async () => {
    transcripts.append('a-1', 'text', 'first');
    transcripts.append('a-1', 'text', `token ${FAKE_KEY}`);
    transcripts.flush();
    const c = open();
    await c.ready;
    await c.until(() => c.messages.some((m) => m.type === 'snapshot'));
    c.send({ type: 'transcript.subscribe', agentId: 'a-1' });
    await c.until(() => c.messages.some((m) => m.type === 'transcript'));
    transcripts.append('a-1', 'tool', 'third');
    transcripts.append('a-2', 'text', 'not subscribed');
    await c.until(() => c.messages.filter((m) => m.type === 'transcript').length === 2);
    const chunks = c.messages
      .filter((m): m is Extract<ServerMessage, { type: 'transcript' }> => m.type === 'transcript')
      .flatMap((m) => m.chunks);
    expect(chunks.map((ch) => [ch.agentId, ch.seq, ch.kind, ch.text])).toEqual([
      ['a-1', 1, 'text', 'first'],
      ['a-1', 2, 'text', 'token [redacted:github-token]'],
      ['a-1', 3, 'tool', 'third'],
    ]);
    expect(JSON.stringify(c.messages)).not.toContain(FAKE_KEY);

    c.send({ type: 'transcript.unsubscribe', agentId: 'a-1' });
    await new Promise((r) => setTimeout(r, 30));
    transcripts.append('a-1', 'text', 'after unsubscribe');
    await new Promise((r) => setTimeout(r, 60));
    expect(c.messages.filter((m) => m.type === 'transcript')).toHaveLength(2);
    c.ws.close();
  });

  it('resumes from `since` and refuses subscriptions when the stream is not configured', async () => {
    for (const text of ['a', 'b', 'c']) transcripts.append('a-1', 'text', text);
    transcripts.flush();
    const c = open();
    await c.ready;
    await c.until(() => c.messages.some((m) => m.type === 'snapshot'));
    c.send({ type: 'transcript.subscribe', agentId: 'a-1', since: 2 });
    await c.until(() => c.messages.some((m) => m.type === 'transcript'));
    const m = c.messages.find((x) => x.type === 'transcript') as Extract<
      ServerMessage,
      { type: 'transcript' }
    >;
    expect(m.chunks.map((ch) => ch.seq)).toEqual([3]);
    c.ws.close();

    const bare = await startTestApp({ log: new EventLog(openDatabase(':memory:')) });
    const ws = new WebSocket(bare.wsUrl);
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN }));
    ws.send(JSON.stringify({ type: 'transcript.subscribe', agentId: 'a-1' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(messages.some((x) => x.type === 'error' && x.code === 'unsupported')).toBe(true);
    ws.close();
    await bare.stop();
  });
});
