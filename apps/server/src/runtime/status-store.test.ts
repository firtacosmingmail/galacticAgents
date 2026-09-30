import { afterEach, describe, expect, it } from 'vitest';
import type { Event, EventEnvelope, StatusRecord } from '@galactic/protocol';
import { StatusStore } from './status-store.js';

const T0 = Date.parse('2026-09-30T10:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 10 };

const stores: StatusStore[] = [];
function make(opts: Partial<ConstructorParameters<typeof StatusStore>[0]> = {}) {
  let now = T0;
  const store = new StatusStore({
    capsOf: () => CAPS,
    defaultCaps: CAPS,
    stallThresholdMs: (runtime) => (runtime === 'fake' ? 300 : 30_000),
    flushMs: 10,
    now: () => now,
    ...opts,
  });
  stores.push(store);
  return { store, setNow: (ms: number) => (now = T0 + ms) };
}
afterEach(() => {
  for (const s of stores.splice(0)) s.dispose();
});

/** A recorded log: seq and time assigned in order, 1 s apart. */
function log(events: Event[]): EventEnvelope[] {
  return events.map((event, i) => ({ seq: i + 1, at: at(i * 1000), event }));
}

const spawned: Event = {
  type: 'agent.spawned',
  agentId: 'a-1',
  role: 'steward',
  runtime: 'fake',
  bodyId: 'b-1',
  sessionRef: 'fake:happy:x:0',
};

describe('StatusStore — folding', () => {
  it('walks an agent through every state', () => {
    const { store, setNow } = make();
    const events = log([
      spawned,
      {
        type: 'agent.tool_call',
        agentId: 'a-1',
        toolName: 'Read',
        input: { file_path: 'README.md' },
      },
      {
        type: 'agent.progress',
        agentId: 'a-1',
        summary: 'Editing',
        progress: { done: 1, total: 3 },
      },
      {
        type: 'agent.needs_input',
        agentId: 'a-1',
        questionId: 'q-1',
        kind: 'clarification',
        question: { text: 'Which format?' },
      },
      {
        type: 'question.answered',
        questionId: 'q-1',
        answer: 'ISO',
        answeredBy: { type: 'user' },
        version: 1,
      },
      { type: 'agent.idle', agentId: 'a-1', cost: { usd: 0.01 } },
      { type: 'agent.paused', agentId: 'a-1', by: { type: 'user' } },
      { type: 'agent.resumed', agentId: 'a-1', by: { type: 'user' } },
      { type: 'agent.stalled', agentId: 'a-1', silentForMs: 5000 },
      {
        type: 'agent.finished',
        agentId: 'a-1',
        result: 'Done',
        cost: { usd: 0.05, inputTokens: 10, outputTokens: 5 },
      },
    ]);
    const states: string[] = [];
    for (const e of events) {
      setNow(e.seq * 1000);
      store.fold(e);
      states.push(store.get('a-1')!.state);
    }
    expect(states).toEqual([
      'starting',
      'working',
      'working',
      'waiting_for_input',
      'working',
      'idle',
      'paused',
      'working',
      'stalled',
      'finished',
    ]);
    const r = store.get('a-1')!;
    expect(r).toMatchObject({
      agentId: 'a-1',
      state: 'finished',
      currentActivity: 'Done',
      progress: { done: 1, total: 3 },
      costSoFar: { usd: 0.05, inputTokens: 10, outputTokens: 5 },
      lastEventAt: at(9000),
      caps: { wallClockMs: { used: 9000, limit: 60_000 }, toolCalls: { used: 1, limit: 10 } },
    });
    expect(r.pendingQuestionId).toBeUndefined();
    // After the question: pending id set, activity describes it.
    store.rebuild(events.slice(0, 4));
    expect(store.get('a-1')).toMatchObject({
      state: 'waiting_for_input',
      pendingQuestionId: 'q-1',
      currentActivity: 'Question: Which format?',
    });
  });

  it('a failed agent keeps its error as the activity; a stopped one keeps its last activity', () => {
    const { store } = make();
    store.rebuild(
      log([spawned, { type: 'agent.failed', agentId: 'a-1', error: 'boom', reason: 'crash' }]),
    );
    expect(store.get('a-1')).toMatchObject({ state: 'failed', currentActivity: 'boom' });
    store.rebuild(
      log([
        spawned,
        {
          type: 'agent.tool_call',
          agentId: 'a-1',
          toolName: 'Bash',
          input: { command: 'pnpm test' },
        },
        { type: 'agent.stopped', agentId: 'a-1', by: { type: 'user' } },
      ]),
    );
    expect(store.get('a-1')).toMatchObject({
      state: 'stopped',
      currentActivity: 'Bash: pnpm test',
    });
    // An ended agent's wall clock stops moving.
    store.tick(T0 + 999_999);
    expect(store.get('a-1')!.caps.wallClockMs.used).toBe(2000);
  });

  it('events during a pause do not leave the paused state; resume restores waiting when a question is open', () => {
    const { store } = make();
    store.rebuild(
      log([
        spawned,
        {
          type: 'agent.needs_input',
          agentId: 'a-1',
          questionId: 'q-1',
          kind: 'permission',
          question: { text: 'rm -rf?' },
        },
        { type: 'agent.paused', agentId: 'a-1', by: { type: 'user' } },
        { type: 'agent.progress', agentId: 'a-1', summary: 'still paused' },
        { type: 'agent.resumed', agentId: 'a-1', by: { type: 'user' } },
      ]),
    );
    expect(store.get('a-1')).toMatchObject({
      state: 'waiting_for_input',
      pendingQuestionId: 'q-1',
      currentActivity: 'still paused',
    });
  });
});

describe('StatusStore — rebuild and diffs', () => {
  it('replaying a recorded log yields identical records to folding it live', () => {
    const events = log([
      spawned,
      { type: 'agent.tool_call', agentId: 'a-1', toolName: 'Grep' },
      {
        type: 'agent.spawned',
        agentId: 'a-2',
        role: 'waykeeper',
        runtime: 'claude-sdk',
        bodyId: 'b-2',
      },
      { type: 'agent.progress', agentId: 'a-2', summary: 'planning' },
      { type: 'agent.idle', agentId: 'a-1' },
      { type: 'agent.failed', agentId: 'a-2', error: 'x', reason: 'runtime' },
    ]);
    const liveStore = make();
    for (const e of events) {
      liveStore.setNow(e.seq * 1000);
      liveStore.store.fold(e);
    }
    const rebuilt = make();
    rebuilt.setNow(6000);
    rebuilt.store.rebuild(events);
    expect(rebuilt.store.all()).toEqual(liveStore.store.all());
    expect(rebuilt.store.live().map((r) => r.agentId)).toEqual(['a-1']);
  });

  it('batches diffs: many folds, one flush with the latest record per agent', async () => {
    const { store } = make({ flushMs: 30 });
    const batches: StatusRecord[][] = [];
    store.subscribe((records) => batches.push(records));
    const events = log([
      spawned,
      { type: 'agent.tool_call', agentId: 'a-1', toolName: 'Read' },
      { type: 'agent.tool_call', agentId: 'a-1', toolName: 'Edit' },
      { type: 'agent.spawned', agentId: 'a-2', role: 'steward', runtime: 'fake', bodyId: 'b-2' },
    ]);
    for (const e of events) store.fold(e);
    expect(batches).toEqual([]);
    await new Promise((r) => setTimeout(r, 60));
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((r) => [r.agentId, r.state, r.currentActivity])).toEqual([
      ['a-1', 'working', 'Edit'],
      ['a-2', 'starting', undefined],
    ]);
    store.fold({ seq: 5, at: at(5000), event: { type: 'agent.idle', agentId: 'a-1' } });
    await new Promise((r) => setTimeout(r, 60));
    expect(batches).toHaveLength(2);
    expect(batches[1]!.map((r) => r.agentId)).toEqual(['a-1']);
  });
});

describe('StatusStore — stall detection', () => {
  it('a silent working agent turns stalled after the threshold and back to working on the next event', () => {
    const { store, setNow } = make();
    store.fold({ seq: 1, at: at(0), event: spawned });
    store.fold({
      seq: 2,
      at: at(100),
      event: { type: 'agent.tool_call', agentId: 'a-1', toolName: 'Bash' },
    });
    store.tick(T0 + 350);
    expect(store.get('a-1')!.state).toBe('working'); // 250 ms of silence < 300
    store.tick(T0 + 450);
    expect(store.get('a-1')!.state).toBe('stalled');
    expect(store.get('a-1')!.caps.wallClockMs.used).toBe(450);
    setNow(500);
    store.fold({
      seq: 3,
      at: at(500),
      event: { type: 'agent.progress', agentId: 'a-1', summary: 'back' },
    });
    expect(store.get('a-1')!.state).toBe('working');
  });

  it('output keeps a working agent alive without any logged event, and wakes a stalled one', () => {
    const { store } = make();
    store.fold({ seq: 1, at: at(0), event: spawned });
    store.fold({
      seq: 2,
      at: at(0),
      event: { type: 'agent.progress', agentId: 'a-1', summary: 'go' },
    });
    store.touch('a-1', T0 + 250);
    store.tick(T0 + 500);
    expect(store.get('a-1')!.state).toBe('working'); // silence measured from the output
    store.tick(T0 + 600);
    expect(store.get('a-1')!.state).toBe('stalled');
    store.touch('a-1', T0 + 610);
    expect(store.get('a-1')!.state).toBe('working');
    expect(store.get('a-1')!.lastEventAt).toBe(at(610));
  });

  it('idle, paused and waiting agents never stall; thresholds are per runtime', () => {
    const { store } = make();
    store.rebuild(
      log([
        spawned,
        { type: 'agent.idle', agentId: 'a-1' },
        {
          type: 'agent.spawned',
          agentId: 'a-2',
          role: 'steward',
          runtime: 'claude-sdk',
          bodyId: 'b',
        },
        { type: 'agent.progress', agentId: 'a-2', summary: 'thinking' },
        { type: 'agent.spawned', agentId: 'a-3', role: 'steward', runtime: 'fake', bodyId: 'b' },
        {
          type: 'agent.needs_input',
          agentId: 'a-3',
          questionId: 'q',
          kind: 'clarification',
          question: { text: '?' },
        },
      ]),
    );
    store.tick(T0 + 20_000);
    expect(store.all().map((r) => [r.agentId, r.state])).toEqual([
      ['a-1', 'idle'],
      ['a-2', 'working'], // claude-sdk threshold is 30 s
      ['a-3', 'waiting_for_input'],
    ]);
    store.tick(T0 + 40_000);
    expect(store.get('a-2')!.state).toBe('stalled');
  });
});
