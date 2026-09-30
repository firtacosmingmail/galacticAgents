import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, EventEnvelope, StatusRecord } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase, type Database } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { AgentRuntime, type SpawnRequest } from './agent-runtime.js';
import { StatusStore } from './status-store.js';
import { TranscriptPipeline } from './transcripts.js';

const USER = { type: 'user' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Rig {
  db: Database;
  log: EventLog;
  runtime: AgentRuntime;
  statuses: StatusStore;
  transcripts: TranscriptPipeline;
  adapter: FakeAdapter;
  events: EventEnvelope[];
  eventsOf(agentId: string): string[];
  waitFor(pred: () => boolean, ms?: number): Promise<void>;
  status(agentId: string): StatusRecord | undefined;
}

const rigs: Rig[] = [];
function make(opts: { speed?: number; maxConcurrentAgents?: number; stallMs?: number } = {}): Rig {
  const db = openDatabase(':memory:');
  const log = new EventLog(db);
  const events: EventEnvelope[] = [];
  log.subscribe((e) => events.push(e));
  const statuses = new StatusStore({
    capsOf: (id) => log.tables.agents.get(id)?.caps,
    defaultCaps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    stallThresholdMs: () => opts.stallMs ?? 30_000,
    flushMs: 10,
  });
  log.subscribe((e) => statuses.fold(e));
  const transcripts = new TranscriptPipeline(db, { flushMs: 10 });
  const adapter = new FakeAdapter({ speed: opts.speed ?? 0 });
  const runtime = new AgentRuntime({
    log,
    adapters: [adapter],
    transcripts,
    statuses,
    caps: {
      maxConcurrentAgents: opts.maxConcurrentAgents ?? 4,
      defaults: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    },
  });
  const rig: Rig = {
    db,
    log,
    runtime,
    statuses,
    transcripts,
    adapter,
    events,
    eventsOf: (agentId) =>
      events
        .filter((e) => 'agentId' in e.event && e.event.agentId === agentId)
        .map((e) => e.event.type),
    waitFor: (pred, ms = 3_000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const tick = () => {
          if (pred()) resolve();
          else if (Date.now() - t0 > ms)
            reject(
              new Error(
                `timeout; events: ${rig.eventsOf('*')}${JSON.stringify(events.map((e) => e.event.type))}`,
              ),
            );
          else setTimeout(tick, 5);
        };
        tick();
      }),
    status: (agentId) => statuses.get(agentId),
  };
  rigs.push(rig);
  return rig;
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.runtime.dispose();
    r.statuses.dispose();
    r.transcripts.dispose();
    r.db.close();
  }
});

const req = (prompt: string, extra: Partial<SpawnRequest> = {}): SpawnRequest => ({
  role: 'steward',
  runtime: 'fake',
  prompt,
  cwd: '/tmp',
  ...extra,
});

async function spawnOk(rig: Rig, r: SpawnRequest): Promise<Agent> {
  const result = await rig.runtime.spawn(r);
  if (!result.ok) throw new Error(result.reason);
  return result.agent;
}

describe('AgentRuntime — routing', () => {
  it('runs a fake agent to the end: rows, events in the log, transcript chunks, status record', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:happy'));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.finished'));
    expect(rig.log.tables.agents.get(agent.id)).toMatchObject({
      id: agent.id,
      role: 'steward',
      runtime: 'fake',
      sessionRef: expect.stringMatching(/^fake:happy:/),
      caps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    });
    // A procedural asteroid was created for the standalone agent, with its event.
    expect(rig.log.tables.bodies.get(agent.bodyId)).toMatchObject({ kind: 'asteroid' });
    expect(rig.events[0]!.event.type).toBe('body.created');
    expect(rig.eventsOf(agent.id)).toEqual([
      'agent.spawned',
      'agent.tool_call',
      'agent.progress',
      'agent.tool_call',
      'agent.progress',
      'agent.tool_call',
      'agent.finished',
    ]);
    // Output went to transcripts, never to the log.
    expect(rig.events.some((e) => e.event.type === 'agent.output')).toBe(false);
    rig.transcripts.flush();
    expect(rig.transcripts.read(agent.id).map((c) => [c.kind, c.text])).toEqual([
      ['thinking', 'Looking at the task.'],
      ['tool', 'Read README.md (42 lines)'],
      ['text', 'All 12 tests pass.'],
    ]);
    await sleep(20);
    expect(rig.status(agent.id)).toMatchObject({
      state: 'finished',
      currentActivity: 'Done: fixed the flaky date test.',
      costSoFar: { usd: 0.0042 },
      caps: { toolCalls: { used: 3, limit: 100 } },
    });
    expect(rig.runtime.liveAgents()).toEqual([]);
  });

  it('refuses an unknown runtime without creating anything', async () => {
    const rig = make();
    const result = await rig.runtime.spawn(req('x', { runtime: 'pty' }));
    expect(result).toEqual({ ok: false, reason: 'no adapter for runtime pty' });
    expect(rig.log.tables.agents.all()).toEqual([]);
  });
});

describe('AgentRuntime — inbox (P1-07)', () => {
  it('queues two messages while working and delivers them in order after idle; interrupt goes first', async () => {
    const rig = make({ speed: 1 });
    const agent = await spawnOk(rig, req('scenario:long'));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.progress'));
    const m1 = rig.runtime.send(agent.id, 'first', { sender: USER });
    const m2 = rig.runtime.send(agent.id, 'second', { sender: { type: 'agent', id: 'a-super' } });
    expect(
      rig.runtime
        .inbox(agent.id)!
        .pending()
        .map((m) => m.text),
    ).toEqual(['first', 'second']);
    rig.runtime.send(agent.id, 'urgent', { sender: USER, interrupt: true });
    // The interrupted turn ends with idle; then urgent, first, second are delivered one per idle.
    await rig.waitFor(() => rig.eventsOf(agent.id).filter((t) => t === 'agent.idle').length >= 4);
    rig.transcripts.flush();
    const received = rig.transcripts
      .read(agent.id)
      .map((c) => c.text)
      .filter((t) => t.startsWith('received:'));
    expect(received).toEqual(['received: urgent', 'received: first', 'received: second']);
    const history = rig.runtime.inbox(agent.id)!.history();
    expect(history.map((m) => [m.text, m.sender.type, m.interrupt])).toEqual([
      ['urgent', 'user', true],
      ['first', 'user', false],
      ['second', 'agent', false],
    ]);
    expect(history[1]!.id).toBe(m1.id);
    expect(history[2]!.id).toBe(m2.id);
    expect(rig.eventsOf(agent.id).includes('agent.finished')).toBe(false); // the long job was cut short
  });
});

describe('AgentRuntime — questions, pause, stop', () => {
  it('answers a clarification through the runtime and logs question.answered', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    const questionId = rig.status(agent.id)!.pendingQuestionId!;
    await rig.runtime.answer(questionId, 'ISO 8601', USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.finished'));
    expect(rig.events.map((e) => e.event.type)).toContain('question.answered');
    await expect(rig.runtime.answer(questionId, 'again', USER)).rejects.toThrow(/no open question/);
  });

  it('pause records control.pause, holds delivery, resume delivers', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:echo'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'idle');
    await rig.runtime.pause(agent.id, USER);
    rig.runtime.send(agent.id, 'held', { sender: USER });
    await sleep(30);
    expect(rig.status(agent.id)?.state).toBe('paused');
    rig.transcripts.flush();
    expect(rig.transcripts.read(agent.id).map((c) => c.text)).not.toContain('received: held');
    await rig.runtime.resumeAgent(agent.id, USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).filter((t) => t === 'agent.idle').length === 2);
    rig.transcripts.flush();
    expect(rig.transcripts.read(agent.id).map((c) => c.text)).toContain('received: held');
    const types = rig.events.map((e) => e.event.type);
    expect(types).toContain('control.pause');
    expect(types).toContain('control.resume');
    expect(types.indexOf('control.pause')).toBeLessThan(types.indexOf('agent.paused'));
  });

  it('stop records control.stop then the adapter reports agent.stopped; sends are refused afterwards', async () => {
    const rig = make({ speed: 1 });
    const agent = await spawnOk(rig, req('scenario:long'));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.progress'));
    await rig.runtime.stop(agent.id, USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.stopped'));
    expect(rig.status(agent.id)?.state).toBe('stopped');
    expect(() => rig.runtime.send(agent.id, 'x', { sender: USER })).toThrow(/not running/);
    expect(rig.runtime.caps.liveCount).toBe(0);
  });
});

describe('AgentRuntime — hard caps (P1-02)', () => {
  it('refuses a spawn over the concurrency cap with the reason in agent.failed', async () => {
    const rig = make({ maxConcurrentAgents: 1, speed: 1 });
    const first = await spawnOk(rig, req('scenario:long'));
    const second = await rig.runtime.spawn(req('scenario:long'));
    expect(second).toEqual({ ok: false, reason: 'concurrency cap: 1 of 1 agents already running' });
    const failed = rig.events.find((e) => e.event.type === 'agent.failed')!.event;
    expect(failed).toMatchObject({
      type: 'agent.failed',
      reason: 'cap',
      error: 'concurrency cap: 1 of 1 agents already running',
    });
    expect(rig.log.tables.agents.all()).toHaveLength(2); // the refused agent exists, as failed
    await rig.runtime.stop(first.id, USER);
    await rig.waitFor(() => rig.eventsOf(first.id).includes('agent.stopped'));
    expect((await rig.runtime.spawn(req('scenario:echo'))).ok).toBe(true);
  });

  it('a tool-call cap stops the agent gracefully and fails it with reason cap', async () => {
    const rig = make({ speed: 1 });
    const agent = await spawnOk(rig, req('scenario:happy', { caps: { maxToolCalls: 2 } }));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.failed'));
    const types = rig.eventsOf(agent.id);
    expect(types.filter((t) => t === 'agent.tool_call')).toHaveLength(3); // the third one tripped it
    expect(types.at(-1)).toBe('agent.failed');
    expect(types).toContain('agent.stopped');
    expect(types).not.toContain('agent.finished');
    const failed = rig.events.find((e) => e.event.type === 'agent.failed')!.event as {
      error: string;
      reason: string;
    };
    expect(failed).toMatchObject({ reason: 'cap', error: 'tool-call cap: 3 calls, limit 2' });
    await sleep(20);
    expect(rig.status(agent.id)).toMatchObject({
      state: 'failed',
      currentActivity: 'tool-call cap: 3 calls, limit 2',
    });
  });

  it('a wall-clock cap fails the agent with reason cap', async () => {
    const rig = make({ speed: 1 });
    const agent = await spawnOk(rig, req('scenario:long', { caps: { maxWallClockMs: 120 } }));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.failed'));
    const failed = rig.events.find((e) => e.event.type === 'agent.failed')!.event as {
      error: string;
      reason: string;
    };
    expect(failed).toMatchObject({ reason: 'cap', error: 'wall-clock cap: 120 ms elapsed' });
    expect(rig.eventsOf(agent.id)).not.toContain('agent.finished');
  });
});

describe('AgentRuntime — status store wiring (P1-05)', () => {
  it('a silent fake agent turns stalled and recovers; records match a rebuild from the log', async () => {
    const rig = make({ speed: 0.25, stallMs: 60 });
    rig.statuses.start();
    const agent = await spawnOk(rig, req('scenario:stalls'));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.stalled'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'idle');
    const live = rig.statuses.all();
    const fresh = new StatusStore({
      capsOf: (id) => rig.log.tables.agents.get(id)?.caps,
      defaultCaps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
      stallThresholdMs: () => 60,
    });
    fresh.rebuild(rig.log.eventsSince(0));
    const strip = (r: StatusRecord) => ({ ...r, caps: undefined });
    expect(fresh.all().map(strip)).toEqual(live.map(strip));
    fresh.dispose();
  });

  it('resume() re-opens a fake session from its ref after an in-process restart', async () => {
    const sessionStore = new Map<string, number>();
    const first = make();
    const adapter1 = new FakeAdapter({ speed: 0, sessionStore });
    const runtime1 = new AgentRuntime({
      log: first.log,
      adapters: [adapter1],
      transcripts: first.transcripts,
      statuses: first.statuses,
    });
    const spawned = await runtime1.spawn(req('scenario:asks'));
    if (!spawned.ok) throw new Error(spawned.reason);
    await first.waitFor(() => first.status(spawned.agent.id)?.state === 'waiting_for_input');
    await adapter1.dispose(); // the "server" dies mid-question

    const adapter2 = new FakeAdapter({ speed: 0, sessionStore });
    const runtime2 = new AgentRuntime({
      log: first.log,
      adapters: [adapter2],
      transcripts: first.transcripts,
      statuses: first.statuses,
    });
    const row = first.log.tables.agents.get(spawned.agent.id)!;
    const resumed = await runtime2.resume(row, { prompt: 'scenario:asks', cwd: '/tmp' });
    expect(resumed.ok).toBe(true);
    await first.waitFor(
      () => first.eventsOf(row.id).filter((t) => t === 'agent.needs_input').length === 2,
    );
    const q = first.status(row.id)!.pendingQuestionId!;
    await runtime2.answer(q, 'EU', USER);
    await first.waitFor(() => first.eventsOf(row.id).includes('agent.finished'));
    expect(first.eventsOf(row.id).filter((t) => t === 'agent.spawned')).toHaveLength(2);
    await runtime2.dispose();
    await runtime1.dispose();
  });
});
