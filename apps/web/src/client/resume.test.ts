// @vitest-environment node
//
// P0-10 — the resume and gap test: a real server, the real client, the connection dropped
// mid-stream. Every `seq` must reach the client exactly once, in order.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@galactic/protocol';
import { buildApp, EventLog, openDatabase, type App } from '@galactic/server';
import { GalacticClient, type ConnectionStatus } from './client.js';

const TOKEN = 'resume-test-token-0123456789';
let app: App;
let log: EventLog;
let wsUrl: string;

beforeEach(async () => {
  log = new EventLog(openDatabase(':memory:'), { maxReplay: 1000 });
  app = buildApp({
    config: {
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      allowedHosts: ['localhost', '127.0.0.1'],
      dev: false,
      dataDir: '',
      configPath: '',
      dbPath: ':memory:',
      projectsRoot: '/tmp/galactic-projects-unused',
    },
    log,
  });
  const port = await app.listen();
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
afterEach(() => app.close());

const emit = (n: number) => {
  for (let i = 0; i < n; i++)
    log.runCommand(({ emit }) => emit({ type: 'agent.idle', agentId: 'a' }));
};

/** Cuts every open socket the way a sleeping phone or a killed tab would. */
const dropAllConnections = () => {
  for (const c of app.gateway.wss.clients) c.terminate();
};

function makeClient(resume?: { lastEventId: number; logId: string }) {
  const seqs: number[] = [];
  const statuses: ConnectionStatus[] = [];
  const messages: ServerMessage[] = [];
  const waiters: { until: () => boolean; resolve: () => void }[] = [];
  const check = () => {
    for (const w of waiters.splice(0)) {
      if (w.until()) w.resolve();
      else waiters.push(w);
    }
  };
  const client = new GalacticClient({
    url: wsUrl,
    token: TOKEN,
    ...(resume ?? {}),
    onMessage: (m) => {
      messages.push(m);
      if (m.type === 'event') seqs.push(m.seq);
      check();
    },
    onStatus: (s) => {
      statuses.push(s);
      check();
    },
    reconnect: { baseMs: 20, maxMs: 50, jitter: false },
  });
  const waitFor = (until: () => boolean, ms = 5000) =>
    new Promise<void>((resolve, reject) => {
      if (until()) return resolve();
      const timer = setTimeout(
        () => reject(new Error(`timed out; seqs=${seqs.length} statuses=${statuses.join(',')}`)),
        ms,
      );
      waiters.push({
        until,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  return { client, seqs, statuses, messages, waitFor };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('resume and gap', () => {
  it('sees every seq exactly once across a mid-stream disconnect', async () => {
    const c = makeClient();
    c.client.connect();
    await c.waitFor(() => c.client.status === 'live');
    expect(c.messages[0]?.type).toBe('snapshot');

    emit(40);
    await c.waitFor(() => c.seqs.length === 40);
    dropAllConnections();
    emit(35); // land while the client is reconnecting
    await c.waitFor(() => c.client.status === 'live' && c.seqs.length >= 75);
    emit(25);
    await c.waitFor(() => c.seqs.length === 100);

    expect(c.seqs).toEqual(range(1, 100));
    expect(c.client.lastEventId).toBe(100);
    expect(c.statuses).toContain('disconnected');
    expect(c.messages.filter((m) => m.type === 'snapshot')).toHaveLength(1);
    expect(c.messages.filter((m) => m.type === 'caught_up')).toHaveLength(1);
    c.client.close();
  });

  it('survives repeated drops without gaps or duplicates', async () => {
    const c = makeClient();
    c.client.connect();
    await c.waitFor(() => c.client.status === 'live');
    let total = 0;
    for (let round = 0; round < 6; round++) {
      emit(10);
      total += 10;
      dropAllConnections();
      emit(5);
      total += 5;
      const target = total;
      await c.waitFor(() => c.seqs.length >= target && c.client.status === 'live');
    }
    expect(c.seqs).toEqual(range(1, total));
    c.client.close();
  });

  it('a new client given the previous lastEventId and logId gets exactly the missed events', async () => {
    const first = makeClient();
    first.client.connect();
    await first.waitFor(() => first.client.status === 'live');
    emit(12);
    await first.waitFor(() => first.seqs.length === 12);
    first.client.close(); // tab killed
    const persisted = { lastEventId: first.client.lastEventId!, logId: first.client.logId! };
    expect(persisted).toEqual({ lastEventId: 12, logId: log.logId });

    emit(8); // happened while the client was gone
    const second = makeClient(persisted);
    second.client.connect();
    await second.waitFor(() => second.client.status === 'live');
    expect(second.messages.map((m) => m.type)).toEqual([
      ...Array<string>(8).fill('event'),
      'caught_up',
    ]);
    expect(second.seqs).toEqual(range(13, 20));
    second.client.close();
  });

  it('falls back to a snapshot when too much was missed, never replaying already-applied seqs', async () => {
    const stale = makeClient({ lastEventId: 1, logId: log.logId });
    emit(1500); // more than maxReplay (1000)
    stale.client.connect();
    await stale.waitFor(() => stale.client.status === 'live');
    expect(stale.messages.map((m) => m.type)).toEqual(['snapshot']);
    expect(stale.client.lastEventId).toBe(1500);
    emit(3);
    await stale.waitFor(() => stale.seqs.length === 3);
    expect(stale.seqs).toEqual([1501, 1502, 1503]);
    stale.client.close();
  });

  it('gets a snapshot instead of a replay when its state came from another log (P0-15)', async () => {
    emit(5);
    const c = makeClient({ lastEventId: 2, logId: 'the-database-that-was-deleted' });
    c.client.connect();
    await c.waitFor(() => c.client.status === 'live');
    expect(c.messages.map((m) => m.type)).toEqual(['snapshot']);
    expect(c.client.logId).toBe(log.logId);
    expect(c.client.lastEventId).toBe(5);
    c.client.close();
  });
});
