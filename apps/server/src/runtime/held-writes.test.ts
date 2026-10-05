import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Event, EventEnvelope } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { SCENARIOS, type FakeScenario, type FakeStep } from '../adapters/fake/scenario.js';
import { isStorageFailure, openDatabase, type Database } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { tickingClock } from '../test/world.js';
import { AgentRuntime, type SpawnRequest } from './agent-runtime.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';
import { StatusStore } from './status-store.js';
import { TranscriptPipeline } from './transcripts.js';

/**
 * Agent events held for a full disk (P8-04, review fixes): nothing commits ahead of them, the
 * user's actions are refused whole meanwhile, `agent.spawned` is held like the rest (so a restart
 * resumes the session), held events keep their time, and the queue stays bounded.
 *
 * A full disk: the log's event insert fails with SQLITE_FULL while the switch is on (the drills
 * fill a real file instead, `test/drills/disk-full.test.ts`). Every command inserts an event, so
 * every command is refused whole, as on a full disk.
 */

function diskOf(log: EventLog): { fill(): void; restore(): void } {
  const insert = (log as unknown as { insertEvent: { run: (...args: unknown[]) => unknown } })
    .insertEvent;
  const run = insert.run.bind(insert);
  let full = false;
  insert.run = (...args: unknown[]) => {
    if (full) throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    return run(...args);
  };
  return { fill: () => void (full = true), restore: () => void (full = false) };
}

function fillDisk(log: EventLog): () => void {
  const disk = diskOf(log);
  disk.fill();
  return () => disk.restore();
}

const USER = { type: 'user' } as const;
const SYSTEM = { type: 'system' } as const;
const HOUR = 3_600_000;

/** Waits for a message: "finish" finishes, "tools <n>" makes n tool calls then idles. */
const WAITER: FakeScenario = {
  steps: [{ kind: 'output', text: 'ready' }],
  onMessage: (message) => {
    if (message === 'finish') return [{ kind: 'finish', result: 'done' }];
    const tools = /^tools (\d+)$/.exec(message);
    if (tools) {
      return [
        ...Array.from({ length: Number(tools[1]) }, (_, i): FakeStep => ({
          kind: 'tool_call',
          toolName: 'Read',
          input: { file_path: `src/${i}.ts`, padding: 'x'.repeat(200) },
        })),
        { kind: 'idle' },
      ];
    }
    return [{ kind: 'output', text: `echo: ${message}` }];
  },
};

interface Rig {
  db: Database;
  log: EventLog;
  runtime: AgentRuntime;
  clock: ReturnType<typeof tickingClock>;
  errors: string[];
  types(agentId?: string): string[];
  all(): EventEnvelope[];
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function rig(opts: { heldLimits?: { events?: number; bytes?: number } } = {}): Rig {
  const db = openDatabase(':memory:');
  const clock = tickingClock();
  const log = new EventLog(db, { now: clock });
  const statuses = new StatusStore({
    capsOf: (id) => log.tables.agents.get(id)?.caps,
    defaultCaps: { maxWallClockMs: 60_000, maxToolCalls: 1_000 },
    stallThresholdMs: () => 30_000,
    flushMs: 10,
  });
  log.subscribe((e) => statuses.fold(e));
  const transcripts = new TranscriptPipeline(db, { flushMs: 10 });
  const errors: string[] = [];
  const runtime = new AgentRuntime({
    log,
    adapters: [new FakeAdapter({ speed: 0, scenarios: { ...SCENARIOS, waiter: WAITER } })],
    transcripts,
    statuses,
    caps: { maxConcurrentAgents: 4, defaults: { maxWallClockMs: 60_000, maxToolCalls: 1_000 } },
    // No automatic retry inside a test: the test says when space returns.
    storageRetryMs: 60_000,
    ...(opts.heldLimits ? { heldLimits: opts.heldLimits } : {}),
    onError: (error, context) =>
      errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
  });
  cleanups.push(async () => {
    await runtime.dispose();
    statuses.dispose();
    transcripts.dispose();
    db.close();
  });
  const all = () => log.eventsSince(0, Number.MAX_SAFE_INTEGER);
  return {
    db,
    log,
    runtime,
    clock,
    errors,
    all,
    types: (agentId) =>
      all()
        .filter((e) => !agentId || ('agentId' in e.event && e.event.agentId === agentId))
        .map((e) => e.event.type),
  };
}

const req = (prompt: string): SpawnRequest => ({
  role: 'steward',
  runtime: 'fake',
  prompt,
  cwd: '/tmp',
});

async function spawn(r: Rig, prompt = 'scenario:waiter'): Promise<Agent> {
  const result = await r.runtime.spawn(req(prompt));
  if (!result.ok) throw new Error(result.reason);
  await until(() => r.types(result.agent.id).includes('agent.idle'), 'its first turn');
  return result.agent;
}

const until = (pred: () => boolean, what: string, ms = 3_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () =>
      pred()
        ? resolve()
        : Date.now() - t0 > ms
          ? reject(new Error(`timeout: ${what}`))
          : setTimeout(tick, 5);
    tick();
  });

const userPin = (agentId: string): Event => ({
  type: 'control.pause',
  target: { kind: 'agent', id: agentId },
  by: USER,
});

describe('held agent events (P8-04 review)', () => {
  it('nothing commits ahead of them: a later command drains them first, and they keep their time', async () => {
    const r = rig();
    const agent = await spawn(r);
    const restore = fillDisk(r.log);
    r.runtime.send(agent.id, 'finish', { sender: SYSTEM });
    await until(() => !r.runtime.liveAgents().some((a) => a.id === agent.id), 'the finish');
    expect(r.runtime.heldWrites).toBeGreaterThanOrEqual(3); // sent, delivered, finished
    const heldSince = r.runtime.storageState().since!;

    // Still full: a command is refused whole with the storage error, and writes nothing.
    const seq = r.log.currentSeq();
    let refused: unknown;
    try {
      r.log.runCommand(({ emit }) => emit(userPin(agent.id)));
    } catch (error) {
      refused = error;
    }
    expect(isStorageFailure(refused), String(refused)).toBe(true);
    expect((refused as Error).message).toMatch(/agent events wait to be written/);
    expect(r.log.currentSeq()).toBe(seq);

    // Space returns an hour later: the next command writes the held events first, in order.
    r.clock.advance(HOUR);
    restore();
    r.log.runCommand(({ emit }) => emit(userPin(agent.id)));
    expect(r.runtime.heldWrites).toBe(0);
    const tail = r.all().slice(-4);
    expect(tail.map((e) => e.event.type)).toEqual([
      'message.sent',
      'message.delivered',
      'agent.finished',
      'control.pause',
    ]);
    // The held events carry the time they happened, not the time they were written.
    for (const e of tail.slice(0, 3)) {
      expect(Date.parse(e.at)).toBeLessThan(Date.parse(heldSince) + HOUR);
      expect(Date.parse(e.at)).toBeGreaterThanOrEqual(Date.parse(heldSince));
    }
    expect(Date.parse(tail[3]!.at)).toBeGreaterThanOrEqual(Date.parse(heldSince) + HOUR);
    expect(r.errors.some((e) => /writes work again: \d+ held agent events written/.test(e))).toBe(
      true,
    );
  });

  it("refuses the user's actions whole while events are held; an agent's are held", async () => {
    const r = rig();
    const busy = await spawn(r);
    const other = await spawn(r);
    const restore = fillDisk(r.log);
    r.runtime.send(busy.id, 'finish', { sender: SYSTEM });
    await until(() => r.runtime.heldWrites >= 3, 'held events');
    const held = r.runtime.heldWrites;

    await expect(r.runtime.pause(other.id, USER)).rejects.toSatisfy(isStorageFailure);
    expect(() => r.runtime.send(other.id, 'hello', { sender: USER })).toThrow(/disk is full/);
    await expect(r.runtime.stop(other.id, USER)).rejects.toSatisfy(isStorageFailure);
    expect(r.runtime.heldWrites).toBe(held);
    expect(r.runtime.liveAgents().some((a) => a.id === other.id)).toBe(true);
    // An agent's line (a supervisor's) is held behind the others instead.
    r.runtime.send(other.id, 'from the Waykeeper', {
      sender: { type: 'agent', id: busy.id },
    });
    expect(r.runtime.heldWrites).toBeGreaterThan(held);

    restore();
    await r.runtime.pause(other.id, USER);
    const types = r.types();
    expect(types.indexOf('agent.finished')).toBeLessThan(types.lastIndexOf('control.pause'));
    expect(r.runtime.heldWrites).toBe(0);
  });

  it('keeps the queue bounded: the oldest agent output goes first, state changes stay', async () => {
    const r = rig({ heldLimits: { events: 10 } });
    const agent = await spawn(r);
    const restore = fillDisk(r.log);
    r.runtime.send(agent.id, 'tools 30', { sender: SYSTEM });
    // 33 events (the message, its delivery, 30 tool calls, the idle) into 10 places: the 23
    // oldest tool calls are dropped, the message, its delivery and the idle stay.
    await until(() => r.runtime.storageState().dropped === 23, 'the drops');
    const state = r.runtime.storageState();
    expect(state.held).toBe(10);
    expect(state).toMatchObject({ permanent: false, error: expect.stringMatching(/disk is full/) });
    expect(r.errors.filter((e) => /dropped from now on/.test(e))).toHaveLength(1);

    restore();
    expect(r.runtime.writeHeld()).toBe(0);
    const types = r.types(agent.id);
    expect(types.filter((t) => t === 'agent.tool_call').length).toBeLessThan(30);
    expect(types.at(-1)).toBe('agent.idle'); // the state change was kept
    expect(r.errors.some((e) => /older agent output events were dropped/.test(e))).toBe(true);
    expect(r.runtime.storageState()).toEqual({ held: 0, bytes: 0, dropped: 0, permanent: false });
  });

  it('says loudly when the database cannot be written at all (read-only)', async () => {
    const r = rig();
    const agent = await spawn(r);
    r.db.pragma('query_only = ON');
    r.runtime.send(agent.id, 'finish', { sender: SYSTEM });
    await until(() => r.runtime.heldWrites > 0, 'held');
    expect(r.runtime.storageState()).toMatchObject({ permanent: true });
    expect(
      r.errors.some((e) => e.startsWith('storage (permanent): attempt to write a readonly')),
    ).toBe(true);
    r.db.pragma('query_only = OFF');
    await until(() => !r.runtime.liveAgents().some((a) => a.id === agent.id), 'the finish');
    expect(r.runtime.writeHeld()).toBe(0);
    expect(r.types(agent.id).at(-1)).toBe('agent.finished');
  });
});

describe('agent.spawned on a full disk (P8-04 review)', () => {
  const dbs: Database[] = [];
  const lives: ComposedRuntime[] = [];
  afterEach(async () => {
    for (const c of lives.splice(0)) await c.dispose().catch(() => {});
    for (const d of dbs.splice(0)) d.close();
  });

  it('is held and written, so a restart resumes the session instead of starting afresh', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = composeRuntime(db, {
      adapters: [new FakeAdapter({ speed: 0, sessionStore: sessions })],
      flushMs: 10,
    });
    lives.push(first);
    // The disk fills between the agent's row and its session starting.
    let restore: (() => void) | undefined;
    const off = first.log.subscribe(({ event }) => {
      if (event.type === 'agent.created' && !restore) restore = fillDisk(first.log);
    });
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/tmp/w',
    });
    off();
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    expect(first.runtime.heldWrites).toBeGreaterThan(0);
    expect(first.log.tables.agents.get(id)?.sessionRef).toBeUndefined();

    restore!();
    expect(first.runtime.writeHeld()).toBe(0);
    const ref = first.log.tables.agents.get(id)?.sessionRef;
    expect(ref).toMatch(/^fake:echo:/);
    expect(first.log.eventsSince(0).some((e) => e.event.type === 'agent.spawned')).toBe(true);
    await first.shutdown();

    const adapter = new FakeAdapter({ speed: 0, sessionStore: sessions });
    const resume = vi.spyOn(adapter, 'resumeSession');
    const second = composeRuntime(db, { adapters: [adapter], flushMs: 10 });
    lives.push(second);
    const report = await second.recover();
    expect(report.resumed).toEqual([id]);
    expect(resume).toHaveBeenCalledWith(ref, expect.anything());
    const reasons = second.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .flatMap(({ event: e }) => (e.type === 'agent.interrupted' ? [e.reason] : []));
    expect(reasons).not.toContain('server restarted before the agent started');
  });
});
