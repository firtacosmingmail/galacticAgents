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
    expect(eventsOf(first, id).at(-1)).toBe('agent.interrupted');
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
      types.slice(types.indexOf('agent.needs_input') + 1, types.indexOf('agent.needs_input') + 3),
    ).toEqual(['agent.interrupted', 'agent.spawned']);
    await waitFor(() => second.statuses.get(id)?.state === 'waiting_for_input', 're-asked');
    expect(second.statuses.get(id)?.currentActivity).toContain('Which date format');
    lives.push(first); // cleaned up by afterEach
  });

  it('messages sent and answers given while the server was down are delivered first', async () => {
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
    first.runtime.send(id, 'please also check the tests', { sender: USER });
    await first.shutdown();

    // "While down": the user answers the open question from another client, straight into the log.
    first.log.runCommand((ctx) =>
      answerQuestion(ctx, questionId, 'yes', USER, new Date().toISOString()),
    );

    const second = boot(db, sessions);
    const report = await second.recover();
    expect(report.resumed).toEqual([id]);
    // The resumed fake re-asks the clarification; both pending items wait in the inbox.
    await waitFor(() => second.statuses.get(id)?.state === 'waiting_for_input', 're-asked');
    expect(
      second.runtime
        .inbox(id)!
        .pending()
        .map((m) => m.text),
    ).toEqual([
      'please also check the tests',
      'Answer to your earlier question "Fix all three?": yes',
    ]);
    const q2 = second.statuses.get(id)!.pendingQuestionId!;
    await second.runtime.answer(q2, 'yes', USER);
    await waitFor(
      () =>
        second.statuses.get(id)?.pendingQuestionId !== undefined &&
        second.statuses.get(id)?.pendingQuestionId !== q2,
      'permission',
    );
    await second.runtime.answer(second.statuses.get(id)!.pendingQuestionId!, 'allow', USER);
    // `full` finishes on its first follow-up message: the redelivered one.
    await waitFor(() => second.statuses.get(id)?.state === 'finished', 'finished', 4_000);
    second.transcripts.flush();
    const texts = second.transcripts.read(id).map((c) => c.text);
    expect(texts).toContain('received: please also check the tests');
    // Redelivery does not log the message a second time.
    expect(
      second.log
        .eventsSince(0, Number.MAX_SAFE_INTEGER)
        .filter((e) => e.event.type === 'message.sent'),
    ).toHaveLength(1);
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
