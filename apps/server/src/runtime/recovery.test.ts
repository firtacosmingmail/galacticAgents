import { afterEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase, type Database } from '../db/database.js';
import { answerQuestion } from '../domain/questions.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * Restart recovery (P1-14, P1-15) with the fake adapter. "The server" is a `composeRuntime`
 * over one database; a restart is a second composition over the same database with a fresh
 * adapter that shares the fake's session store (what a real runtime keeps on disk).
 */

const USER = { type: 'user' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dbs: Database[] = [];
const lives: ComposedRuntime[] = [];
function boot(db: Database, sessionStore: Map<string, number>, speed = 0): ComposedRuntime {
  const composed = composeRuntime(db, {
    adapters: [new FakeAdapter({ speed, sessionStore })],
    flushMs: 10,
  });
  lives.push(composed);
  return composed;
}
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dbs.splice(0)) d.close();
});

const eventsOf = (c: ComposedRuntime, agentId: string): string[] =>
  c.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .filter((e: EventEnvelope) => 'agentId' in e.event && e.event.agentId === agentId)
    .map((e) => e.event.type);
const agentEventsOf = (c: ComposedRuntime, agentId: string): string[] =>
  eventsOf(c, agentId).filter((t) => t.startsWith('agent.'));
const waitFor = (pred: () => boolean, what: string, ms = 3_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () =>
      pred()
        ? resolve()
        : Date.now() - t0 > ms
          ? reject(new Error(`timeout: ${what}`))
          : setTimeout(tick, 10);
    tick();
  });

describe('restart recovery', () => {
  it('a clean shutdown marks live agents interrupted (not stopped); the next start resumes them', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'waiting_for_input', 'question');
    expect(first.log.tables.agents.get(id)?.meta).toMatchObject({
      cwd: '/tmp/w',
      prompt: 'scenario:asks',
    });

    await first.shutdown();
    expect(agentEventsOf(first, id).at(-1)).toBe('agent.interrupted');
    expect(eventsOf(first, id)).toContain('question.cancelled'); // P1-34: re-asked on resume
    expect(eventsOf(first, id)).not.toContain('agent.stopped');
    expect(first.statuses.get(id)).toMatchObject({
      state: 'interrupted',
      currentActivity: 'server shutdown',
    });

    const second = boot(db, sessions);
    expect(second.statuses.get(id)?.state).toBe('interrupted'); // rebuilt from the log
    const report = await second.recover();
    expect(report).toEqual({ resumed: [id], needAttention: [] });
    await waitFor(
      () => second.statuses.get(id)?.state === 'waiting_for_input',
      'question re-asked',
    );
    expect(eventsOf(second, id).filter((t) => t === 'agent.spawned')).toHaveLength(2);
    const q = second.statuses.get(id)!.pendingQuestionId!;
    await second.runtime.answer(q, 'ISO 8601', USER);
    await waitFor(() => second.statuses.get(id)?.state === 'finished', 'finished after resume');
  });

  it('a server that died (kill -9) leaves live states; the next start interrupts and resumes them', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'waiting_for_input', 'question');
    // No shutdown: the first server simply ceases to exist (its fake session stays blocked on
    // the question, so it emits nothing more).
    lives.splice(lives.indexOf(first), 1);

    const second = boot(db, sessions);
    expect(second.statuses.get(id)?.state).toBe('waiting_for_input'); // the log still says so
    const report = await second.recover();
    expect(report.resumed).toEqual([id]);
    const types = eventsOf(second, id);
    expect(
      types.slice(types.indexOf('agent.needs_input') + 1, types.indexOf('agent.needs_input') + 4),
    ).toEqual(['agent.interrupted', 'question.cancelled', 'agent.spawned']);
    await waitFor(() => second.statuses.get(id)?.state === 'waiting_for_input', 're-asked');
    expect(second.statuses.get(id)?.currentActivity).toContain('Which date format');
    lives.push(first); // cleaned up by afterEach
  });

  it('messages queued at a shutdown are delivered first, keep their ids and survive a second restart', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:full',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'waiting_for_input', 'question');
    const questionId = first.statuses.get(id)!.pendingQuestionId!;
    // Queued while the agent is busy with its question: logged, never delivered.
    const queued = first.runtime.send(id, 'please also check the tests', { sender: USER });
    await first.shutdown();
    // The open question went with the session (P1-34): it cannot be answered any more.
    expect(first.log.tables.questions.get(questionId)?.status).toBe('cancelled');
    expect(() =>
      first.log.runCommand((ctx) =>
        answerQuestion(ctx, { questionId, answer: 'yes', answeredBy: USER }),
      ),
    ).toThrow(/cancelled/);

    // Second life: resumed, the message waits in the inbox with its original id — then the
    // server goes down again before the agent took it (P1-33).
    const second = boot(db, sessions);
    expect((await second.recover()).resumed).toEqual([id]);
    await waitFor(() => second.statuses.get(id)?.state === 'waiting_for_input', 're-asked');
    expect(
      second.runtime
        .inbox(id)!
        .pending()
        .map((m) => m.id),
    ).toEqual([queued.id]);
    await second.shutdown();

    // Third life: still pending, delivered once the agent is idle.
    const third = boot(db, sessions);
    expect((await third.recover()).resumed).toEqual([id]);
    await waitFor(() => third.statuses.get(id)?.state === 'waiting_for_input', 're-asked again');
    expect(
      third.runtime
        .inbox(id)!
        .pending()
        .map((m) => m.text),
    ).toEqual(['please also check the tests']);
    await third.runtime.answer(third.statuses.get(id)!.pendingQuestionId!, 'yes', USER);
    await waitFor(
      () =>
        third.statuses.get(id)?.state === 'waiting_for_input' &&
        third.statuses.get(id)?.pendingQuestionId !== undefined,
      'permission',
    );
    await third.runtime.answer(third.statuses.get(id)!.pendingQuestionId!, 'allow', USER);
    // `full` finishes on its first follow-up message: the redelivered one.
    await waitFor(() => third.statuses.get(id)?.state === 'finished', 'finished', 4_000);
    third.transcripts.flush();
    expect(third.transcripts.read(id).map((c) => c.text)).toContain(
      'received: please also check the tests',
    );
    const log = third.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
    // Redelivery logs no second message.sent; the delivery itself is logged once.
    expect(log.filter((e) => e.type === 'message.sent')).toHaveLength(1);
    expect(log.filter((e) => e.type === 'message.delivered')).toEqual([
      { type: 'message.delivered', messageId: queued.id, agentId: id },
    ]);
  });

  it('a delivered message is not delivered again after a crash (P1-33)', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'idle', 'idle');
    const sent = first.runtime.send(id, 'once', { sender: USER });
    await waitFor(() => eventsOf(first, id).includes('message.delivered'), 'delivered');
    expect(
      first.runtime
        .inbox(id)!
        .history()
        .map((m) => m.id),
    ).toEqual([sent.id]);
    lives.splice(lives.indexOf(first), 1); // kill -9

    const second = boot(db, sessions);
    expect((await second.recover()).resumed).toEqual([id]);
    expect(second.runtime.inbox(id)!.pending()).toEqual([]);
    lives.push(first);
  });

  it('a stop under way when the server shuts down ends as a stop and is not resumed (P1-32)', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'waiting_for_input', 'question');
    const stopping = first.runtime.stop(id, USER);
    await first.shutdown();
    await stopping;
    const types = agentEventsOf(first, id);
    expect(types).not.toContain('agent.interrupted');
    expect(types.filter((t) => ['agent.stopped', 'agent.failed'].includes(t))).toEqual([
      'agent.stopped',
    ]);
    const second = boot(db, sessions);
    expect(await second.recover()).toEqual({ resumed: [], needAttention: [] });
    expect(second.statuses.get(id)?.state).toBe('stopped');
  });

  it('a server that died while a stop was under way marks the agent stopped (P1-32)', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'waiting_for_input', 'question');
    // The stop was logged, then the server died before the agent's terminal event.
    first.log.runCommand(({ emit }) =>
      emit({ type: 'control.stop', target: { kind: 'agent', id }, by: USER }),
    );
    lives.splice(lives.indexOf(first), 1);

    const second = boot(db, sessions);
    expect(await second.recover()).toEqual({ resumed: [], needAttention: [] });
    expect(second.statuses.get(id)?.state).toBe('stopped');
    lives.push(first);
  });

  it('recoverAgent() refuses an agent that is not interrupted (P1-29)', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:asks',
      cwd: '/tmp/w',
      permissionPolicy: { rules: { destructive: 'deny' } },
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'waiting_for_input', 'question');
    const refused = await first.runtime.recoverAgent(id);
    expect(refused).toMatchObject({ ok: false });
    expect(agentEventsOf(first, id).filter((t) => t === 'agent.spawned')).toHaveLength(1);
    expect(first.log.tables.agents.get(id)?.meta).toMatchObject({
      permissionPolicy: { rules: { destructive: 'deny' } },
    });
  });

  it('agents that cannot be resumed stay interrupted and are reported', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const first = boot(db, sessions);
    const spawned = await first.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/tmp/w',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const id = spawned.agent.id;
    await waitFor(() => first.statuses.get(id)?.state === 'idle', 'idle');
    await first.shutdown();
    // Forget the session ref, as a runtime without resume support would have none.
    first.log.runCommand((ctx) => {
      const row = ctx.tables.agents.get(id)!;
      const { sessionRef: _ref, ...rest } = row;
      ctx.tables.agents.upsert(rest);
    });
    const second = boot(db, sessions);
    const report = await second.recover();
    expect(report).toEqual({ resumed: [], needAttention: [id] });
    expect(second.statuses.get(id)?.state).toBe('interrupted');
    await sleep(20);
    expect(second.runtime.liveAgents()).toEqual([]);
  });
});

describe('one Harmonizer at a time (wave-3 review)', () => {
  it('two concurrent spawns: exactly one Harmonizer runs', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const c = boot(db, new Map(), 1);
    const spawn = () =>
      c.commands.spawnAgent({
        role: 'harmonizer',
        runtime: 'fake',
        prompt: 'scenario:long',
        cwd: '/hq',
      });
    const results = await Promise.allSettled([spawn(), spawn()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(c.runtime.liveAgents().filter((a) => a.role === 'harmonizer')).toHaveLength(1);
  });

  it('a restart with two interrupted Harmonizers resumes only the newest', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const sessions = new Map<string, number>();
    const spawnH = (c: ComposedRuntime) =>
      c.commands.spawnAgent({
        role: 'harmonizer',
        runtime: 'fake',
        prompt: 'scenario:long',
        cwd: '/hq',
      });
    const first = boot(db, sessions, 1);
    const h1 = (await spawnH(first)).value;
    await first.shutdown(); // h1 interrupted
    const second = boot(db, sessions, 1);
    const h2 = (await spawnH(second)).value; // allowed: h1 is not running
    await second.shutdown(); // h2 interrupted too
    const third = boot(db, sessions, 1);
    const report = await third.recover();
    expect(report.resumed).toEqual([h2.id]);
    expect(report.needAttention).toContain(h1.id);
    expect((await third.runtime.recoverAgent(h1.id)).ok).toBe(false);
    expect(third.runtime.liveAgents().filter((a) => a.role === 'harmonizer')).toHaveLength(1);
  });
});
