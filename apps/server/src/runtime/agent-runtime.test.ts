import { afterEach, describe, expect, it } from 'vitest';
import type { Agent, Event, EventEnvelope, StatusRecord } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { SCENARIOS, type FakeScenario } from '../adapters/fake/scenario.js';
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
function make(
  opts: {
    speed?: number;
    maxConcurrentAgents?: number;
    stallMs?: number;
    inboxHistory?: number;
    scenarios?: Record<string, FakeScenario>;
    onError?: (error: unknown, context: string) => void;
  } = {},
): Rig {
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
  const adapter = new FakeAdapter({
    speed: opts.speed ?? 0,
    scenarios: { ...SCENARIOS, ...(opts.scenarios ?? {}) },
  });
  const runtime = new AgentRuntime({
    log,
    adapters: [adapter],
    transcripts,
    statuses,
    caps: {
      maxConcurrentAgents: opts.maxConcurrentAgents ?? 4,
      defaults: { maxWallClockMs: 60_000, maxToolCalls: 100 },
    },
    ...(opts.inboxHistory !== undefined ? { inboxHistory: opts.inboxHistory } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
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
    expect(rig.events.slice(0, 2).map((e) => e.event.type)).toEqual([
      'body.created',
      'agent.created',
    ]);
    // Everything the adapter emitted before the handle came back was held until agent.spawned.
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
    expect(rig.runtime.inbox(agent.id)).toBeUndefined(); // the runtime forgets ended sessions
  });

  it('redacts secrets in event payloads before they reach the log or the status store', async () => {
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const leaky: FakeScenario = {
      steps: [
        {
          kind: 'tool_call',
          toolName: 'Bash',
          input: { command: `export ANTHROPIC_API_KEY=${KEY}` },
        },
        { kind: 'progress', summary: `set ${KEY}` },
        {
          kind: 'permission',
          toolName: 'Bash',
          input: { command: `curl -H "Authorization: Bearer ${KEY}" https://api.example.com` },
          permissionAction: 'network',
          text: `call the API with ${KEY}?`,
        },
        { kind: 'finish', result: `done with ${KEY}` },
      ],
    };
    const rig = make({ scenarios: { leaky } });
    const agent = await spawnOk(rig, req('scenario:leaky'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    await rig.runtime.answer(rig.status(agent.id)!.pendingQuestionId!, 'allow', USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.finished'));
    await sleep(20);
    const logged = JSON.stringify(rig.log.eventsSince(0));
    expect(logged).not.toContain(KEY);
    expect(logged).toContain('[redacted:');
    expect(JSON.stringify(rig.statuses.all())).not.toContain(KEY);
    expect(rig.status(agent.id)?.currentActivity).toBe('done with [redacted:anthropic-key]');
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
    // Every message is in the log as message.sent, in send order, with the inbox's ids (P1-22).
    const sent = rig.events
      .filter((e) => e.event.type === 'message.sent')
      .map((e) => e.event as Extract<Event, { type: 'message.sent' }>);
    expect(sent.map((m) => [m.messageId, m.text, m.sender.type, m.interrupt])).toEqual([
      [m1.id, 'first', 'user', false],
      [m2.id, 'second', 'agent', false],
      [history[0]!.id, 'urgent', 'user', true],
    ]);
    expect(rig.eventsOf(agent.id).filter((t) => t === 'message.sent')).toHaveLength(3);
    // The adapter was never handed a message mid-turn: no delivery errors.
    expect(history.every((m) => m.error === undefined && m.deliveredAt !== undefined)).toBe(true);
  });

  it('keeps a bounded delivery history; the log has the rest', async () => {
    const rig = make({ inboxHistory: 2 });
    const agent = await spawnOk(rig, req('scenario:echo'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'idle');
    for (const text of ['one', 'two', 'three']) {
      rig.runtime.send(agent.id, text, { sender: USER });
      await rig.waitFor(() =>
        rig.runtime
          .inbox(agent.id)!
          .history()
          .some((m) => m.text === text),
      );
    }
    expect(
      rig.runtime
        .inbox(agent.id)!
        .history()
        .map((m) => m.text),
    ).toEqual(['two', 'three']);
    expect(rig.events.filter((e) => e.event.type === 'message.sent')).toHaveLength(3);
  });
});

describe('AgentRuntime — questions, pause, stop', () => {
  it('a question opens a row with agent.needs_input; the answer closes it and logs question.answered', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    const questionId = rig.status(agent.id)!.pendingQuestionId!;
    // The row and `question.opened` land in the same command as `agent.needs_input` (P1-23).
    const types = rig.events.map((e) => e.event.type);
    expect(types.indexOf('question.opened')).toBe(types.indexOf('agent.needs_input') + 1);
    expect(rig.log.tables.questions.get(questionId)).toMatchObject({
      id: questionId,
      kind: 'clarification',
      originAgentId: agent.id,
      holder: { type: 'user' },
      status: 'open',
      context: { text: 'Which date format should the export use?' },
      version: 0,
    });
    await rig.runtime.answer(questionId, 'ISO 8601', USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.finished'));
    const answered = rig.events.find((e) => e.event.type === 'question.answered')!.event;
    expect(answered).toMatchObject({
      questionId,
      answer: 'ISO 8601',
      answeredBy: USER,
      version: 1,
    });
    expect(rig.log.tables.questions.get(questionId)).toMatchObject({
      status: 'answered',
      answer: 'ISO 8601',
      answeredBy: { type: 'user' },
      version: 1,
    });
    await expect(rig.runtime.answer(questionId, 'again', USER)).rejects.toThrow(/no open question/);
  });

  it('the session ref lands on the row in the same command as agent.spawned', async () => {
    const rig = make();
    const seen: (string | undefined)[] = [];
    rig.log.subscribe((e) => {
      if (e.event.type === 'agent.spawned')
        seen.push(rig.log.tables.agents.get(e.event.agentId)?.sessionRef);
    });
    const agent = await spawnOk(rig, req('scenario:echo'));
    expect(seen).toEqual([agent.sessionRef]);
    expect(agent.sessionRef).toMatch(/^fake:echo:/);
  });

  it('drops a straggler from an ended agent and reports an event for an unknown one', async () => {
    const errors: string[] = [];
    const rig = make({ onError: (_e, context) => errors.push(context) });
    const before = rig.events.length;
    // An event about an agent nobody spawned: rejected at the door, reported once.
    rig.adapter.events.push({ type: 'agent.idle', agentId: 'a-stranger' });
    await sleep(20);
    expect(rig.events.length).toBe(before);
    expect(errors).toEqual(['routing agent.idle']);
    const agent = await spawnOk(rig, req('scenario:happy'));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.finished'));
    const after = rig.events.length;
    rig.adapter.events.push({ type: 'agent.stopped', agentId: agent.id, by: USER });
    await sleep(20);
    expect(rig.events.length).toBe(after); // one terminal event, the straggler is gone
    expect(errors).toEqual(['routing agent.idle']); // and it was expected, not an error
    expect(rig.status(agent.id)?.state).toBe('finished');
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
  it('refuses a spawn over the concurrency cap before writing anything', async () => {
    const rig = make({ maxConcurrentAgents: 1, speed: 1 });
    const first = await spawnOk(rig, req('scenario:long'));
    const before = rig.events.length;
    const second = await rig.runtime.spawn(req('scenario:long'));
    expect(second).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^concurrency cap: 1 of 1 agents already running/),
    });
    expect(rig.events).toHaveLength(before); // no row, no body, no event for the refused spawn
    expect(rig.log.tables.agents.all()).toHaveLength(1);
    expect(rig.log.tables.bodies.all().filter((b) => b.kind === 'asteroid')).toHaveLength(1);
    await rig.runtime.stop(first.id, USER);
    await rig.waitFor(() => rig.eventsOf(first.id).includes('agent.stopped'));
    expect((await rig.runtime.spawn(req('scenario:echo'))).ok).toBe(true);
  });

  it('a tool-call cap refuses the call, stops the agent and fails it with reason cap — one terminal event', async () => {
    const rig = make({ speed: 1 });
    const agent = await spawnOk(rig, req('scenario:happy', { caps: { maxToolCalls: 2 } }));
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.failed'));
    await sleep(50); // a straggling agent.stopped would land here
    const types = rig.eventsOf(agent.id);
    expect(types.filter((t) => t === 'agent.tool_call')).toHaveLength(2); // the third was refused
    expect(types.at(-1)).toBe('agent.failed');
    expect(
      types.filter((t) => ['agent.finished', 'agent.failed', 'agent.stopped'].includes(t)),
    ).toEqual(['agent.failed']);
    const failed = rig.events.find((e) => e.event.type === 'agent.failed')!.event as {
      error: string;
      reason: string;
    };
    expect(failed).toMatchObject({ reason: 'cap', error: 'tool-call cap: 2 calls made, limit 2' });
    expect(rig.status(agent.id)).toMatchObject({
      state: 'failed',
      currentActivity: 'tool-call cap: 2 calls made, limit 2',
    });
    expect(rig.runtime.liveAgents()).toEqual([]);
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

  it('a paused agent does not run down its wall-clock cap (review)', async () => {
    const rig = make({ speed: 1 });
    const agent = await spawnOk(rig, req('scenario:long', { caps: { maxWallClockMs: 150 } }));
    await rig.runtime.pause(agent.id, USER);
    await sleep(300);
    expect(rig.eventsOf(agent.id)).not.toContain('agent.failed');
    await rig.runtime.resumeAgent(agent.id, USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.failed'));
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

  it('recover() re-opens a fake session from its ref after an in-process restart', async () => {
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
    await runtime1.shutdown(); // the "server" goes down mid-question: the agent is interrupted
    await adapter1.dispose();

    const adapter2 = new FakeAdapter({ speed: 0, sessionStore });
    const runtime2 = new AgentRuntime({
      log: first.log,
      adapters: [adapter2],
      transcripts: first.transcripts,
      statuses: first.statuses,
    });
    const row = first.log.tables.agents.get(spawned.agent.id)!;
    const report = await runtime2.recover();
    expect(report).toEqual({ resumed: [row.id], needAttention: [] });
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

describe('AgentRuntime — phase review follow-ups (P1-32 … P1-34)', () => {
  const slowEcho: FakeScenario = {
    steps: [],
    onMessage: (m) => [
      { kind: 'silence', ms: 60 },
      { kind: 'output', text: `got ${m}` },
    ],
  };

  it('pause and resume right after a delivery lose no message (P1-33)', async () => {
    const errors: string[] = [];
    const rig = make({
      speed: 1,
      scenarios: { slow: slowEcho },
      onError: (e, c) => errors.push(`${c}: ${(e as Error).message}`),
    });
    const agent = await spawnOk(rig, req('scenario:slow'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'idle');
    rig.runtime.send(agent.id, 'one', { sender: USER });
    rig.runtime.send(agent.id, 'two', { sender: USER });
    await sleep(5);
    await rig.runtime.pause(agent.id, USER);
    await rig.runtime.resumeAgent(agent.id, USER);
    await rig.waitFor(
      () => rig.eventsOf(agent.id).filter((t) => t === 'message.delivered').length === 2,
    );
    expect(
      rig.runtime
        .inbox(agent.id)!
        .history()
        .map((m) => [m.text, m.error]),
    ).toEqual([
      ['one', undefined],
      ['two', undefined],
    ]);
    expect(errors.filter((e) => e.includes('mid-turn'))).toEqual([]);
  });

  it('an interrupt that withdraws a question cancels it; pause/resume does not bring it back (P1-34)', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    const q = rig.status(agent.id)!.pendingQuestionId!;
    rig.runtime.send(agent.id, 'never mind', { sender: USER, interrupt: true });
    await rig.waitFor(() => rig.log.tables.questions.get(q)?.status === 'cancelled');
    await rig.waitFor(() => rig.status(agent.id)?.pendingQuestionId === undefined);
    await rig.runtime.pause(agent.id, USER);
    await rig.runtime.resumeAgent(agent.id, USER);
    await sleep(20);
    expect(rig.status(agent.id)?.state).not.toBe('waiting_for_input');
    await expect(rig.runtime.answer(q, 'late', USER)).rejects.toThrow();
  });

  it('a stop cancels the open question in the same command as agent.stopped (P1-34)', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    const q = rig.status(agent.id)!.pendingQuestionId!;
    await rig.runtime.stop(agent.id, USER);
    await rig.waitFor(() => rig.eventsOf(agent.id).includes('agent.stopped'));
    expect(rig.log.tables.questions.get(q)?.status).toBe('cancelled');
    const seqOf = (type: string) =>
      rig.events.find(
        (e) => e.event.type === type && 'agentId' in e.event && e.event.agentId === agent.id,
      )!.seq;
    expect(seqOf('question.cancelled')).toBe(seqOf('agent.stopped') + 1);
  });

  it('a stop the adapter cannot carry out still ends the agent (P1-32)', async () => {
    const errors: string[] = [];
    const rig = make({ onError: (e) => errors.push((e as Error).message) });
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    const realStop = rig.adapter.stop.bind(rig.adapter);
    rig.adapter.stop = async () => {
      throw new Error('process will not die');
    };
    await rig.runtime.stop(agent.id, USER);
    expect(rig.status(agent.id)?.state).toBe('failed');
    expect(rig.runtime.liveAgents()).toEqual([]);
    expect(errors).toContain('process will not die');
    rig.adapter.stop = realStop;
  });

  it('refuses a message while a stop is under way instead of logging it (R11)', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    const realStop = rig.adapter.stop.bind(rig.adapter);
    let release: () => void = () => {};
    rig.adapter.stop = (id) =>
      new Promise<void>((resolve) => {
        release = () => void realStop(id).then(resolve);
      });
    const stopping = rig.runtime.stop(agent.id, USER);
    expect(() => rig.runtime.send(agent.id, 'too late', { sender: USER })).toThrow(/stopping/);
    expect(rig.eventsOf(agent.id)).not.toContain('message.sent');
    release();
    await stopping;
    rig.adapter.stop = realStop;
  });

  it('an interrupt while paused resumes the agent first (R9)', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    await rig.runtime.pause(agent.id, USER);
    await rig.runtime.interrupt(agent.id);
    await rig.waitFor(() => rig.status(agent.id)?.state === 'idle');
    const types = rig.events.map((e) => e.event.type);
    expect(types.indexOf('control.resume')).toBeGreaterThan(types.indexOf('control.pause'));
  });

  it('a cap hit before the session exists is acted on once it does (R11)', async () => {
    const rig = make();
    const realSpawn = rig.adapter.spawn.bind(rig.adapter);
    rig.adapter.spawn = async (opts) => {
      await sleep(30);
      return realSpawn(opts);
    };
    const agent = await spawnOk(rig, req('scenario:asks', { caps: { maxWallClockMs: 1 } }));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'failed');
    const failed = rig.events.find((e) => e.event.type === 'agent.failed')!.event;
    expect(failed).toMatchObject({ reason: 'cap' });
  });

  it('a failed resume leaves the agent interrupted in the log too (R11)', async () => {
    const rig = make();
    const agent = await spawnOk(rig, req('scenario:asks'));
    await rig.waitFor(() => rig.status(agent.id)?.state === 'waiting_for_input');
    await rig.runtime.shutdown();
    rig.adapter.resumeSession = async () => {
      throw new Error('session gone');
    };
    const result = await rig.runtime.recoverAgent(agent.id);
    expect(result).toEqual({ ok: false, reason: 'session gone' });
    const last = rig.events.filter((e) => e.event.type.startsWith('agent.')).at(-1)!.event;
    expect(last).toMatchObject({
      type: 'agent.interrupted',
      reason: 'resume failed: session gone',
    });
    expect(rig.status(agent.id)?.state).toBe('interrupted');
  });
});
