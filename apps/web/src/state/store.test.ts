import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage, StatusRecord } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { useAppStore } from './store.js';

const record = (agentId: string, state: StatusRecord['state'] = 'working'): StatusRecord => ({
  ...fx.status,
  agentId,
  state,
});
const snapshot = (logId: string, statuses: StatusRecord[] = []): ServerMessage => ({
  type: 'snapshot',
  logId,
  seq: 1,
  agents: [],
  bodies: [],
  projects: [],
  tasks: [],
  questions: [],
  proposals: [],
  statuses,
});
const transcript = (agentId: string): ServerMessage => ({
  type: 'transcript',
  agentId,
  chunks: [{ agentId, seq: 1, at: fx.NOW, kind: 'text', text: 'hi' }],
});
const apply = (m: ServerMessage) => useAppStore.getState().apply(m);
const statusIds = () => Object.keys(useAppStore.getState().world.statuses).sort();

beforeEach(() => useAppStore.getState().reset());

describe('app store (P1-38)', () => {
  it('merges status diffs and replaces the whole set on replace:true', () => {
    apply(snapshot('log-a', [record('a1'), record('a2', 'finished')]));
    apply({ type: 'status', statuses: [record('a3')] });
    expect(statusIds()).toEqual(['a1', 'a2', 'a3']);
    apply({ type: 'status', statuses: [], removed: ['a3'] });
    expect(statusIds()).toEqual(['a1', 'a2']);

    // After a replay: a2 was dropped by retention while the client was away.
    apply({ type: 'status', statuses: [record('a1', 'idle')], replace: true });
    expect(statusIds()).toEqual(['a1']);
    expect(useAppStore.getState().world.statuses['a1']?.state).toBe('idle');
    apply({ type: 'status', statuses: [], replace: true });
    expect(statusIds()).toEqual([]);
  });

  it('keeps transcripts across a snapshot of the same log and drops them for a new log', () => {
    apply(snapshot('log-a'));
    apply(transcript('a1'));
    apply(snapshot('log-a'));
    expect(useAppStore.getState().transcripts['a1']).toHaveLength(1);

    apply(snapshot('log-b'));
    expect(useAppStore.getState().transcripts).toEqual({});
    expect(useAppStore.getState().logId).toBe('log-b');
    // The new log's chunks start from seq 1 again and are not filtered out as old.
    apply(transcript('a1'));
    expect(useAppStore.getState().transcripts['a1']).toHaveLength(1);
  });

  it('folds message.sent into the chat history, merges the REST history, and drops it for a new log (P2-18)', () => {
    apply(snapshot('log-a'));
    const sent = (seq: number, messageId: string, text: string): ServerMessage => ({
      type: 'event',
      seq,
      at: fx.NOW,
      event: {
        type: 'message.sent',
        messageId,
        agentId: 'hq',
        sender: { type: 'user' },
        text,
        interrupt: false,
      },
    });
    apply(sent(5, 'm2', 'second'));
    useAppStore.getState().addMessages('hq', [
      {
        messageId: 'm1',
        agentId: 'hq',
        seq: 3,
        at: fx.NOW,
        sender: { type: 'user' },
        text: 'first',
      },
      {
        messageId: 'm2',
        agentId: 'hq',
        seq: 5,
        at: fx.NOW,
        sender: { type: 'user' },
        text: 'second',
      },
    ]);
    apply(sent(5, 'm2', 'second')); // a replayed event is not doubled
    expect(useAppStore.getState().messages['hq']?.map((m) => m.text)).toEqual(['first', 'second']);
    apply(snapshot('log-a'));
    expect(useAppStore.getState().messages['hq']).toHaveLength(2);
    apply(snapshot('log-b'));
    expect(useAppStore.getState().messages).toEqual({});
  });
});
