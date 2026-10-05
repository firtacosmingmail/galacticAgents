import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOSE_UNAUTHORIZED, type ServerMessage } from '@galactic/protocol';
import { GalacticClient, type ConnectionStatus } from './client.js';
import { FakeWebSocket } from './fake-socket.js';

const idle = (seq: number): ServerMessage => ({
  type: 'event',
  seq,
  at: '2026-09-30T10:00:00.000Z',
  event: { type: 'agent.idle', agentId: 'a' },
});
const LOG = 'log-a';
const snapshot = (seq: number, logId = LOG): ServerMessage => ({
  type: 'snapshot',
  logId,
  seq,
  agents: [],
  bodies: [],
  projects: [],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [],
});

function setup(lastEventId?: number, logId = LOG) {
  const received: ServerMessage[] = [];
  const statuses: ConnectionStatus[] = [];
  const persisted: number[] = [];
  const timers: (() => void)[] = [];
  const client = new GalacticClient({
    url: 'ws://test/ws',
    token: 'tok',
    ...(lastEventId !== undefined ? { lastEventId, logId } : {}),
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
    expect(t.socket().hello).toEqual({ type: 'hello', token: 'tok', lastEventId: 41, logId: LOG });
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
    expect(t.socket().hello.logId).toBe(LOG);
  });

  it('takes a snapshot from a new log as the new baseline and resumes from it afterwards', () => {
    const t = setup(41);
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverSends(snapshot(3, 'log-b')); // the server decided we cannot replay
    expect(t.client.logId).toBe('log-b');
    expect(t.client.lastEventId).toBe(3);
    expect(t.persisted).toEqual([3]);
    t.socket().serverSends(idle(4));
    expect(t.received.map((m) => m.type)).toEqual(['snapshot', 'event']);
    t.socket().serverCloses(1006);
    t.timers.shift()!();
    t.socket().serverOpens();
    expect(t.socket().hello).toEqual({
      type: 'hello',
      token: 'tok',
      lastEventId: 4,
      logId: 'log-b',
    });
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
    t.socket().serverCloses(CLOSE_UNAUTHORIZED, 'unauthorized');
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

  it('unsubscribes a transcript on an open socket only (P1-38)', () => {
    const t = setup();
    t.client.connect();
    t.client.subscribeTranscript('a1');
    // Still CONNECTING: sending would throw InvalidStateError in a browser.
    t.client.unsubscribeTranscript('a1');
    expect(t.socket().sent).toEqual([]);
    t.socket().serverOpens();
    t.socket().serverSends(snapshot(0));
    // The dropped subscription is not re-sent when the stream goes live.
    expect(t.socket().sent.map((m) => JSON.parse(m).type)).toEqual(['hello']);

    t.client.subscribeTranscript('a2');
    t.client.unsubscribeTranscript('a2');
    expect(
      t
        .socket()
        .sent.slice(1)
        .map((m) => JSON.parse(m)),
    ).toEqual([
      { type: 'transcript.subscribe', agentId: 'a2', since: 0 },
      { type: 'transcript.unsubscribe', agentId: 'a2' },
    ]);
  });

  it('ignores a frame that is not JSON and keeps the stream (P1-38)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverSends(snapshot(3));
    t.socket().serverSendsRaw('{not json');
    t.socket().serverSends(idle(4));
    expect(warn).toHaveBeenCalledOnce();
    expect(t.received.map((m) => m.type)).toEqual(['snapshot', 'event']);
    expect(t.client.status).toBe('live');
    expect(t.socket().closeCalls).toEqual([]);
    warn.mockRestore();
  });

  it('skips an event type a newer server added, advancing seq instead of looping (protocol evolution)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = setup();
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverSends(snapshot(3));
    const future = {
      type: 'event',
      seq: 4,
      at: '2026-09-30T10:00:00.000Z',
      event: { type: 'body.someday', bodyId: 'b-1', anything: [1, 2] },
    };
    t.socket().serverSends(future);
    expect(t.client.status).toBe('live');
    expect(t.socket().closeCalls).toEqual([]);
    expect(t.client.lastEventId).toBe(4);
    expect(t.persisted).toEqual([3, 4]); // a reload resumes past it
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/body\.someday.*reload/));
    // Not handed to the store; the next event applies in order.
    t.socket().serverSends(idle(5));
    expect(t.received.map((m) => m.type)).toEqual(['snapshot', 'event']);
    expect(t.client.lastEventId).toBe(5);
    // A replayed copy is a duplicate; an unknown event after a gap still resumes.
    t.socket().serverSends(future);
    expect(t.socket().closeCalls).toEqual([]);
    t.socket().serverSends({ ...future, seq: 9 });
    expect(t.socket().closeCalls[0]?.reason).toBe('gap in event stream');
    warn.mockRestore();
  });

  it('still treats a malformed event of a known type, or a broken envelope, as unreadable', () => {
    const t = setup();
    t.client.connect();
    t.socket().serverOpens();
    t.socket().serverSends(snapshot(3));
    // `agent.idle` is known: a missing agentId is a server bug, not a newer protocol.
    t.socket().serverSends({
      type: 'event',
      seq: 4,
      at: '2026-09-30T10:00:00.000Z',
      event: { type: 'agent.idle' },
    });
    expect(t.socket().closeCalls[0]).toEqual({ code: 4002, reason: 'unreadable message' });
    expect(t.client.lastEventId).toBe(3);

    const u = setup();
    u.client.connect();
    u.socket().serverOpens();
    u.socket().serverSends(snapshot(3));
    u.socket().serverSends({ type: 'event', seq: 'four', event: { type: 'body.someday' } });
    expect(u.socket().closeCalls[0]?.reason).toBe('unreadable message');
  });
});
