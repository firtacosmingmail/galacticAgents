import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Id, WorkState } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase, type Database } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { EventLog } from '../domain/event-log.js';
import { setTaskState } from '../domain/states.js';
import { DEFAULT_CAPS } from './caps.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P2-15 through the runtime composition: derived task and project states are written to the rows
 * as `*.state_changed` events without `by`, from the fake adapter's real event stream.
 */

const USER: Actor = { type: 'user' };

const dbs: Database[] = [];
const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dbs.splice(0)) d.close();
});

function freshDb(): Database {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

function boot(db: Database, opts: { speed?: number; sessions?: Map<string, number> } = {}) {
  const errors: unknown[] = [];
  const composed = composeRuntime(db, {
    adapters: [
      new FakeAdapter({
        speed: opts.speed ?? 0,
        ...(opts.sessions ? { sessionStore: opts.sessions } : {}),
      }),
    ],
    flushMs: 10,
    onError: (e) => errors.push(e),
  });
  lives.push(composed);
  return { ...composed, errors };
}

/** Bodies are catalogue rows (seeded without events, as P2-02's migration does). */
function seedBodies(log: EventLog): void {
  for (const id of ['b-mars', 'b-venus']) {
    if (!log.tables.bodies.get(id)) log.tables.bodies.insert({ id, kind: 'planet', name: id });
  }
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const stateChanges = (log: EventLog, kind: 'task' | 'project', id: Id) =>
  log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map((e) => e.event)
    .filter((e) =>
      kind === 'task'
        ? e.type === 'task.state_changed' && e.taskId === id
        : e.type === 'project.state_changed' && e.projectId === id,
    ) as { to: WorkState; by?: Actor }[];
const trail = (log: EventLog, kind: 'task' | 'project', id: Id) =>
  stateChanges(log, kind, id).map((e) => e.to);

async function projectWithTask(c: ComposedRuntime) {
  seedBodies(c.log);
  const project = (
    await c.commands.createProject({ name: 'CSV', workspace: '/w/csv', bodyId: 'b-mars' })
  ).value;
  const task = (await c.commands.createTask({ description: 'Parse', projectId: project.id }))
    .value;
  return { project, task };
}

describe('work state derivation through the runtime', () => {
  it('a Steward asking the user blocks its task and project; the answer unblocks them', async () => {
    const c = boot(freshDb(), { speed: 5 }); // `long` runs ~5 s: the Waykeeper stays alive
    const { project, task } = await projectWithTask(c);
    const { log, commands } = c;
    const waykeeper = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        prompt: 'scenario:long',
      })
    ).value;
    const steward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: waykeeper.id,
        prompt: 'scenario:asks',
      })
    ).value;
    await until(
      () => log.tables.questions.all().some((q) => q.originAgentId === steward.id),
      'the question',
    );
    let question = log.tables.questions.all().find((q) => q.originAgentId === steward.id)!;
    if (question.holder.type !== 'user') {
      // Held by the Waykeeper (P2-03 routing): not the user's to answer, so not blocked on user.
      expect(log.tables.tasks.get(task.id)!.state).toBe('in_progress');
      question = (await commands.escalateQuestion(question.id, question.holder)).value;
    }
    expect(question.holder.type).toBe('user');
    expect(log.tables.tasks.get(task.id)!.state).toBe('blocked_on_user');
    expect(log.tables.projects.get(project.id)!.state).toBe('blocked_on_user');

    await commands.answerQuestion({
      questionId: question.id,
      answer: 'ISO 8601',
      by: USER,
      version: question.version,
    });
    await until(() => c.statuses.get(steward.id)?.state === 'finished', 'the Steward finishes');
    expect(trail(log, 'task', task.id)).toEqual([
      'in_progress',
      'blocked_on_user',
      'in_progress',
      'awaiting_closure',
    ]);
    // Every derived change is written without `by`.
    expect(stateChanges(log, 'task', task.id).every((e) => e.by === undefined)).toBe(true);
    // The Waykeeper still works and the task waits on it: the project is in progress.
    expect(log.tables.projects.get(project.id)!.state).toBe('in_progress');

    // The Waykeeper closes the task; with the Waykeeper stopped every task is closed.
    await commands.closeTask(task.id, { type: 'agent', id: waykeeper.id });
    expect(log.tables.tasks.get(task.id)!.state).toBe('completed');
    await commands.stopAgent(waykeeper.id, USER);
    await until(() => c.statuses.get(waykeeper.id)?.state === 'stopped', 'the stop');
    expect(log.tables.tasks.get(task.id)!.state).toBe('completed');
    // Every task closed and nothing running: the user is asked to close the project.
    expect(log.tables.projects.get(project.id)!.state).toBe('awaiting_closure');
    expect(trail(log, 'project', project.id)).toEqual([
      'in_progress',
      'blocked_on_user',
      'in_progress',
      'awaiting_closure',
    ]);
    expect(c.errors).toEqual([]);
  });

  it('a failed Steward fails its task; a new Steward takes it up again', async () => {
    const c = boot(freshDb());
    const { task } = await projectWithTask(c);
    const first = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:fails',
      })
    ).value;
    await until(() => c.statuses.get(first.id)?.state === 'failed', 'the failure');
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('failed');
    const second = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:happy',
      })
    ).value;
    await until(() => c.statuses.get(second.id)?.state === 'finished', 'the retry');
    expect(trail(c.log, 'task', task.id)).toEqual([
      'in_progress',
      'failed',
      'in_progress',
      'awaiting_closure',
    ]);
  });

  it('an explicit state holds until an agent of the item is resumed', async () => {
    const c = boot(freshDb());
    const { project, task } = await projectWithTask(c);
    const agent = c.log.runCommand((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: DEFAULT_CAPS,
        taskId: task.id,
        projectId: project.id,
        bodyId: 'b-mars',
      }),
    ).value;
    const record = (e: Parameters<typeof c.commands.recordAgentEvent>[0]) =>
      c.commands.recordAgentEvent(e);
    await record({
      type: 'agent.spawned',
      agentId: agent.id,
      role: 'steward',
      runtime: 'fake',
      bodyId: 'b-mars',
    });
    await record({ type: 'agent.tool_call', agentId: agent.id, toolName: 'Read' });
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('in_progress');

    // A panel pause (P2-14 sets it with `by`) before the agent's own pause lands.
    c.log.runCommand((ctx) => setTaskState(ctx, task.id, 'paused', USER));
    await record({ type: 'agent.tool_call', agentId: agent.id, toolName: 'Grep' });
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('paused');
    await record({ type: 'agent.paused', agentId: agent.id, by: USER });
    await record({ type: 'agent.resumed', agentId: agent.id, by: USER });
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('in_progress');

    // A user-held question is blocked on user whatever the hold; its answer gives the work back.
    await record({
      type: 'agent.needs_input',
      agentId: agent.id,
      questionId: 'q-1',
      kind: 'permission',
      question: { text: 'May I push?' },
    });
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('blocked_on_user');
    expect(c.log.tables.projects.get(project.id)!.state).toBe('blocked_on_user');
    await c.commands.answerQuestion({ questionId: 'q-1', answer: 'yes', by: USER });
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('in_progress');
    expect(c.log.tables.projects.get(project.id)!.state).toBe('in_progress');

    // Sticky: a closed task is not reopened by a straggler.
    await c.commands.closeTask(task.id, USER);
    await record({ type: 'agent.tool_call', agentId: agent.id, toolName: 'Read' });
    expect(c.log.tables.tasks.get(task.id)!.state).toBe('completed');
  });

  it('never loops, and a restart over the same log writes nothing new', async () => {
    const db = freshDb();
    const c = boot(db);
    const { project, task } = await projectWithTask(c);
    const steward = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:happy',
      })
    ).value;
    await until(() => c.statuses.get(steward.id)?.state === 'finished', 'the Steward');
    const changes = c.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .filter((e) => e.event.type.endsWith('.state_changed'));
    // One change per derived state, never repeated back to back.
    expect(trail(c.log, 'task', task.id)).toEqual(['in_progress', 'awaiting_closure']);
    expect(trail(c.log, 'project', project.id)).toEqual(['in_progress']);
    await c.dispose();
    const seq = c.log.currentSeq();

    const again = boot(db);
    expect(again.log.currentSeq()).toBe(seq);
    expect(
      again.log.eventsSince(0, Number.MAX_SAFE_INTEGER).filter((e) => e.event.type.endsWith('.state_changed')),
    ).toEqual(changes);
  });

  it('reconcile repairs a state a crash left underived', async () => {
    const db = freshDb();
    // The project and task are derived as usual; then a Steward's events are committed by a log
    // with no deriver attached, as if the server crashed before deriving.
    const c0 = boot(db);
    const made = await projectWithTask(c0);
    await c0.dispose();
    const bare = new EventLog(db);
    const row = bare.runCommand((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: DEFAULT_CAPS,
        taskId: made.task.id,
        projectId: made.project.id,
        bodyId: 'b-mars',
      }),
    ).value;
    bare.runCommand((ctx) =>
      ctx.emit({ type: 'agent.spawned', agentId: row.id, role: 'steward', runtime: 'fake', bodyId: 'b-mars' }),
    );
    expect(bare.tables.tasks.get(made.task.id)!.state).toBe('approved');

    const c = boot(db);
    expect(c.log.tables.tasks.get(made.task.id)!.state).toBe('in_progress');
    expect(c.log.tables.projects.get(made.project.id)!.state).toBe('in_progress');
  });

  it('a restart marks running work interrupted; the resume takes it back to in progress', async () => {
    const db = freshDb();
    const sessions = new Map<string, number>();
    const first = boot(db, { speed: 5, sessions });
    const { project, task } = await projectWithTask(first);
    const steward = (
      await first.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:long',
      })
    ).value;
    await until(() => first.log.tables.tasks.get(task.id)!.state === 'in_progress', 'working');
    await first.shutdown();
    expect(first.log.tables.tasks.get(task.id)!.state).toBe('interrupted');
    expect(first.log.tables.projects.get(project.id)!.state).toBe('interrupted');

    const second = boot(db, { speed: 5, sessions });
    await second.recover();
    await until(() => second.statuses.get(steward.id)?.state !== 'interrupted', 'the resume');
    expect(second.log.tables.tasks.get(task.id)!.state).toBe('in_progress');
    expect(second.log.tables.projects.get(project.id)!.state).toBe('in_progress');
  });
});
