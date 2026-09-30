import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@galactic/protocol';
import { GalacticClient, type ConnectionStatus } from './client.js';
import { FakeWebSocket } from './fake-socket.js';

const idle = (seq: number): ServerMessage => ({
  type: 'event',
  seq,
  at: '2026-09-30T10:00:00.000Z',
  event: { type: 'agent.idle', agentId: 'a' },
});
const snapshot = (seq: number): ServerMessage => ({
  type: 'snapshot',
  seq,
  agents: [],
  bodies: [],
  projects: [],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [],
});

function setup(lastEventId?: number) {
  const received: ServerMessage[] = [];
  const statuses: ConnectionStatus[] = [];
  const persisted: number[] = [];
  const timers: (() => void)[] = [];
  const client = new GalacticClient({
    url: 'ws://test/ws',
    token: 'tok',
    ...(lastEventId !== undefined ? { lastEventId } : {}),
    onMessage: (m) => received.push(m),
    onStatus: (s) => statuses.push(s),
    onLastEventId: (seq) => persisted.push(seq),
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    setTimeoutImpl: ((fn: () => void) => {
      timers.push(fn);
      return 0;
    }) as unknown as typeof setTimeout,
    reconnect: { jitter: false, baseMs: 10 },
  });
  return {
    client,
    received,
    statuses,
    persisted,
    timers,
    socket: () => FakeWebSocket.instances.at(-1)!,
  };
}

beforeEach(() => {
  FakeWebSocket.instances = [];
});

describe('GalacticClient', () => {
  it('sends hello with the token and no lastEventId on a fresh start, then goes live on the snapshot', () => {
    const t = setup();
    t.client.connect();
    t.socket().serverOpens();
    expect(t.socket().hello).toEqual({ type: 'hello', token: 'tok' });
    t.socket().serverSends(snapshot(5));
    expect(t.client.lastEventId).toBe(5);
    expect(t.client.status).toBe('live');
    expect(t.persisted).toEqual([5]);
    t.socket().serverSends(idle(6));
    expect(t.received.map((m) => m.type)).toEqual(['snapshot', 'event']);
    expect(t.client.lastEventId).toBe(6);
  });

  it('resumes with lastEventId and reports live after caught_up', () => {
    const t = setup(41);
    t.client.connect();
    t.socket().serverOpens();
    expect(t.socket().hello).toEqual({ type: 'hello', token: 'tok', lastEventId: 41 });
    t.socket().serverSends(idle(42));
    expect(t.client.status).toBe('catching_up');
    t.socket().serverSends({ type: 'caught_up', seq: 42 });
    expect(t.client.status).toBe('live');
    expect(t.received.map((m) => m.type)).toEqual(['event', 'caught_up']);
  });

  it('drops duplicates and reconnects on a gap, resuming from the last applied seq', () => {
    const t = setup(10);
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverSends(idle(11));
    t.socket().serverSends(idle(11)); // duplicate
    t.socket().serverSends(idle(10)); // stale
    expect(t.received).toHaveLength(1);
    t.socket().serverSends(idle(13)); // gap: 12 missing
    expect(t.received).toHaveLength(1);
    expect(t.socket().closeCalls[0]?.reason).toBe('gap in event stream');
    expect(t.client.status).toBe('disconnected');
    expect(t.timers).toHaveLength(1);
    t.timers[0]!();
    expect(FakeWebSocket.instances).toHaveLength(2);
    t.socket().serverOpens();
    expect(t.socket().hello.lastEventId).toBe(11);
  });

  it('reconnects with growing backoff when the server drops the connection', () => {
    const t = setup();
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverSends(snapshot(0));
    t.socket().serverCloses(1006);
    expect(t.client.status).toBe('disconnected');
    t.timers.shift()!();
    t.socket().serverCloses(1006);
    t.timers.shift()!();
    expect(FakeWebSocket.instances).toHaveLength(3);
    t.socket().serverOpens();
    expect(t.socket().hello.lastEventId).toBe(0);
  });

  it('stops on an unauthorized close and on a user close', () => {
    const t = setup();
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverCloses(4401, 'unauthorized');
    expect(t.client.status).toBe('unauthorized');
    expect(t.timers).toHaveLength(0);

    const u = setup();
    u.client.connect();
    u.socket().serverOpens();
    u.client.close();
    expect(u.client.status).toBe('closed');
    expect(u.socket().closeCalls).toEqual([{ code: 1000, reason: 'client closed' }]);
    expect(u.timers).toHaveLength(0);
  });
});
