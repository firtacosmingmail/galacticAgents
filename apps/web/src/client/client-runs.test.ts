import { beforeEach, describe, expect, it } from 'vitest';
import type { RunOutputChunk, ServerMessage } from '@galactic/protocol';
import { GalacticClient } from './client.js';
import { FakeWebSocket } from './fake-socket.js';
import { MAX_RUN_OUTPUT, mergeRunOutput, useAppStore } from '../state/store.js';

const snapshot = (seq: number): ServerMessage => ({
  type: 'snapshot',
  logId: 'log-a',
  seq,
  agents: [],
  bodies: [],
  projects: [],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [],
});

const chunk = (seq: number, text = `line ${seq}\n`): RunOutputChunk => ({
  runId: 'r-1',
  seq,
  at: '2026-10-08T10:00:00.000Z',
  chunk: text,
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  useAppStore.getState().reset();
});

describe('the run output stream (P9-10)', () => {
  it('subscribes once live, from the newest seq held, and again after a reconnect', () => {
    const held: Record<string, number> = { 'r-1': 0 };
    const timers: (() => void)[] = [];
    const client = new GalacticClient({
      url: 'ws://test/ws',
      token: 'tok',
      onMessage: () => undefined,
      runSince: (runId) => held[runId] ?? 0,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      setTimeoutImpl: ((fn: () => void) => {
        timers.push(fn);
        return 0;
      }) as unknown as typeof setTimeout,
      reconnect: { jitter: false, baseMs: 10 },
    });
    client.connect();
    client.subscribeRun('r-1');
    const first = FakeWebSocket.instances.at(-1)!;
    first.serverOpens();
    expect(first.sent.map((m) => JSON.parse(m).type)).toEqual(['hello']);
    first.serverSends(snapshot(3));
    expect(JSON.parse(first.sent.at(-1)!)).toEqual({
      type: 'run.subscribe',
      runId: 'r-1',
      since: 0,
    });
    // Output arrived; the socket drops; the next one resumes after it.
    held['r-1'] = 7;
    first.serverCloses(1006);
    timers.shift()!();
    const second = FakeWebSocket.instances.at(-1)!;
    second.serverOpens();
    second.serverSends(snapshot(3));
    expect(JSON.parse(second.sent.at(-1)!)).toEqual({
      type: 'run.subscribe',
      runId: 'r-1',
      since: 7,
    });
    client.unsubscribeRun('r-1');
    expect(JSON.parse(second.sent.at(-1)!)).toEqual({ type: 'run.unsubscribe', runId: 'r-1' });
  });

  it('merges REST pages and stream batches by seq, in order, once each', () => {
    const store = useAppStore.getState();
    store.apply({ type: 'run_output', runId: 'r-1', chunks: [chunk(3), chunk(4)] });
    store.addRunOutput('r-1', [chunk(1), chunk(2), chunk(3)]);
    useAppStore
      .getState()
      .apply({ type: 'run_output', runId: 'r-1', chunks: [chunk(4), chunk(5)] });
    expect(useAppStore.getState().runOutputs['r-1']!.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
    useAppStore.getState().dropRunOutput('r-1');
    expect(useAppStore.getState().runOutputs['r-1']).toBeUndefined();
  });

  it('keeps the newest output past the cap', () => {
    const big = [chunk(1, 'a'.repeat(60)), chunk(2, 'b'.repeat(60)), chunk(3, 'c'.repeat(30))];
    expect(mergeRunOutput([], big, 100).map((c) => c.seq)).toEqual([2, 3]);
    // One chunk alone above the cap is kept.
    expect(mergeRunOutput([], [chunk(9, 'x'.repeat(200))], 100).map((c) => c.seq)).toEqual([9]);
    expect(MAX_RUN_OUTPUT).toBeGreaterThan(2 * 1024 * 1024);
  });
});
