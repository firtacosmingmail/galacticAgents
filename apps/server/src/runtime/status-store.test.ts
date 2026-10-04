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
      'idle', // resume restores what the agent was doing before the pause
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

  it('stays waiting_for_input while any of two open questions is unanswered (P4-11)', () => {
    const { store } = make();
    const ask = (questionId: string): Event => ({
      type: 'agent.needs_input',
      agentId: 'a-1',
      questionId,
      kind: 'permission',
      question: { text: `allow ${questionId}?` },
    });
    const answer = (questionId: string): Event => ({
      type: 'question.answered',
      questionId,
      answer: 'allow',
      answeredBy: { type: 'user' },
      version: 1,
    });
    const events = log([spawned, ask('q-1'), ask('q-2'), answer('q-2'), answer('q-1')]);
    const seen: Partial<StatusRecord>[] = [];
    for (const e of events) {
      store.fold(e);
      const { state, pendingQuestionId } = store.get('a-1')!;
      seen.push({ state, ...(pendingQuestionId ? { pendingQuestionId } : {}) });
    }
    expect(seen.slice(1)).toEqual([
      { state: 'waiting_for_input', pendingQuestionId: 'q-1' },
      { state: 'waiting_for_input', pendingQuestionId: 'q-2' },
      // The newer one answered: the older is still open.
      { state: 'waiting_for_input', pendingQuestionId: 'q-1' },
      { state: 'working' },
    ]);

    // A cancelled question leaves the other one waiting too; a rebuild agrees.
    const second = make().store;
    second.rebuild(
      log([
        spawned,
        ask('q-1'),
        ask('q-2'),
        {
          type: 'question.cancelled',
          questionId: 'q-1',
          agentId: 'a-1',
          reason: 'gone',
          version: 1,
        },
      ]),
    );
    expect(second.get('a-1')).toMatchObject({
      state: 'waiting_for_input',
      pendingQuestionId: 'q-2',
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

  it('marks only records that changed: a stall check that finds nothing sends nothing (P1-25)', async () => {
    const { store } = make();
    const batches: StatusRecord[][] = [];
    store.subscribe((records) => batches.push(records));
    store.fold({ seq: 1, at: at(0), event: spawned });
    store.fold({
      seq: 2,
      at: at(100),
      event: { type: 'agent.progress', agentId: 'a-1', summary: 'go' },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(batches).toHaveLength(1);
    store.tick(T0 + 200); // no stall yet: nothing dirty
    await new Promise((r) => setTimeout(r, 30));
    expect(batches).toHaveLength(1);
    store.tick(T0 + 500); // stalled: one diff, with the clock as of the tick
    await new Promise((r) => setTimeout(r, 30));
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([
      expect.objectContaining({
        state: 'stalled',
        startedAt: at(0),
        caps: expect.objectContaining({ wallClockMs: { used: 500, limit: 60_000 } }),
      }),
    ]);
  });
});

describe('StatusStore — ended records are a sink (P1-17)', () => {
  it('ignores any event after a terminal one except a new agent.spawned', () => {
    const { store } = make();
    store.rebuild(
      log([
        spawned,
        { type: 'agent.failed', agentId: 'a-1', error: 'tool-call cap', reason: 'cap' },
        { type: 'agent.stopped', agentId: 'a-1', by: { type: 'system' } },
        { type: 'agent.progress', agentId: 'a-1', summary: 'ghost' },
      ]),
    );
    expect(store.get('a-1')).toMatchObject({ state: 'failed', currentActivity: 'tool-call cap' });
    store.fold({ seq: 5, at: at(5000), event: spawned });
    expect(store.get('a-1')).toMatchObject({ state: 'starting', startedAt: at(5000) });
  });
});

describe('StatusStore — retention of ended records (P1-16)', () => {
  const ended = (id: string, atMs: number): EventEnvelope[] => [
    { seq: 1, at: at(atMs), event: { ...spawned, agentId: id, type: 'agent.spawned' } },
    { seq: 2, at: at(atMs + 1), event: { type: 'agent.finished', agentId: id } },
  ];

  it('drops ended records past the retention period and announces them', async () => {
    const { store, setNow } = make({ retainEndedMs: 10_000, flushMs: 5 });
    const removedSeen: string[] = [];
    store.subscribe((_records, removed) => removedSeen.push(...removed));
    for (const e of ended('old', 0)) store.fold(e);
    for (const e of ended('fresh', 8_000)) store.fold(e);
    store.fold({ seq: 3, at: at(9_000), event: { ...spawned, agentId: 'live' } });
    setNow(12_000);
    expect(store.prune()).toEqual(['old']);
    expect(store.all().map((r) => r.agentId)).toEqual(['fresh', 'live']);
    await new Promise((r) => setTimeout(r, 20));
    expect(removedSeen).toEqual(['old']);
    setNow(30_000);
    store.tick(); // the ticker prunes too; live agents are never dropped
    expect(store.all().map((r) => r.agentId)).toEqual(['live']);
  });

  it('keeps at most maxEnded ended records, oldest dropped first', () => {
    const { store } = make({ maxEnded: 2, retainEndedMs: 1e9 });
    for (let i = 0; i < 5; i++) for (const e of ended(`a-${i}`, i * 1000)) store.fold(e);
    expect(store.prune()).toEqual(['a-0', 'a-1', 'a-2']);
    expect(store.all().map((r) => r.agentId)).toEqual(['a-3', 'a-4']);
  });

  it('a rebuild from the log brings a dropped record back only until the next prune', () => {
    const { store, setNow } = make({ retainEndedMs: 10_000 });
    store.rebuild(ended('old', 0));
    setNow(20_000);
    expect(store.prune()).toEqual(['old']);
    store.rebuild(ended('old', 0));
    expect(store.get('old')?.state).toBe('finished');
    expect(store.prune()).toEqual(['old']);
  });
});
