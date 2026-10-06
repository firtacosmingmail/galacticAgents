import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Event, EventEnvelope, Id } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { projectHierarchy } from '../test/hierarchy.js';
import { DomainError } from './errors.js';

/**
 * P8-01: dollar budgets through the real composition — `setBudget` and its remote rule, the spend
 * projection fed by fake cost reports, the warning and the exceeded notice (once each), the
 * refused spawn (a `conflict` and a `budget.spawn_refused`, nothing else written) and the
 * Harmonizer's chat lines, and the spend surviving a restart without double counting.
 */

const USER: Actor = { type: 'user' };
const LOCAL = { origin: 'local' as const };
const REMOTE = { origin: 'remote' as const };

/** `cost <usd>` makes the session report that running total at the end of the turn. */
const SCENARIOS: Record<string, FakeScenario> = {
  spend: {
    steps: [{ kind: 'output', text: 'working' }],
    onMessage: (message) => {
      const m = /^cost ([\d.]+)$/.exec(message);
      return m ? [{ kind: 'cost', cost: { usd: Number(m[1]) } }] : [];
    },
  },
};

const lives: ComposedRuntime[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function boot(path = ':memory:', warnAtPercent?: number) {
  const composed = composeRuntime(openDatabase(path), {
    adapters: [new FakeAdapter({ speed: 0, scenarios: SCENARIOS })],
    flushMs: 10,
    caps: { maxConcurrentAgents: 8 },
    ...(warnAtPercent !== undefined ? { budgets: { warnAtPercent } } : {}),
  });
  lives.push(composed);
  return composed;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

function recorder(c: ComposedRuntime) {
  const seen: EventEnvelope[] = [];
  c.log.subscribe((e) => seen.push(e));
  return {
    of: <T extends Event['type']>(type: T) =>
      seen.map((e) => e.event).filter((e): e is Extract<Event, { type: T }> => e.type === type),
  };
}

/** The system lines in an agent's chat (`message.sent` from the system, not turn prompts). */
function chatLines(c: ComposedRuntime, agentId: Id): string[] {
  return c.log
    .latestOf('message.sent', agentId, 100)
    .map((e) => e.event)
    .filter(
      (e): e is Extract<Event, { type: 'message.sent' }> =>
        e.type === 'message.sent' && e.sender.type === 'system' && !e.turn,
    )
    .map((e) => e.text);
}

async function setup(c: ComposedRuntime, tasks = 2) {
  const project = (await c.commands.createProject({ name: 'CSV tool', workspace: '/w/csv' })).value;
  const { harmonizer, waykeeper } = await projectHierarchy(c.commands, project.id, {
    harmonizer: 'scenario:echo',
    waykeeper: 'scenario:echo',
  });
  const ids: Id[] = [];
  for (let i = 0; i < tasks; i++) {
    ids.push(
      (await c.commands.createTask({ description: `task ${i}`, projectId: project.id })).value.id,
    );
  }
  return { project, harmonizer, waykeeper, tasks: ids };
}

const spendOf = (c: ComposedRuntime, id: Id) => c.log.tables.spend.get(id)?.usd ?? 0;

async function report(c: ComposedRuntime, stewardId: Id, usd: number) {
  c.runtime.send(stewardId, `cost ${usd}`, { sender: USER });
  await until(() => Math.abs(spendOf(c, stewardId) - usd) < 1e-9);
}

describe('setBudget (P8-01)', () => {
  it('sets, lowers and removes a budget, logging budget.set with the row change', async () => {
    const c = boot();
    const rec = recorder(c);
    const { project, tasks } = await setup(c, 1);
    const target = { kind: 'project' as const, id: project.id };

    await c.commands.setBudget(target, 5, USER, REMOTE); // setting is a tightening: from anywhere
    expect(c.log.tables.projects.get(project.id)?.budgetUsd).toBe(5);
    await c.commands.setBudget(target, 2, USER, REMOTE); // lowering too
    expect(rec.of('budget.set')).toEqual([
      { type: 'budget.set', target, usd: 5, by: USER },
      { type: 'budget.set', target, usd: 2, previousUsd: 5, by: USER },
    ]);
    expect(rec.of('project.updated').at(-1)?.changes).toEqual({ budgetUsd: 2 });

    // Raising or removing is a loosening: refused for a remote or unknown origin.
    for (const usd of [3, null]) {
      const error = await refusal(c.commands.setBudget(target, usd, USER, REMOTE));
      expect(error.message).toMatch(/works only from this machine/);
      await refusal(c.commands.setBudget(target, usd, { type: 'agent', id: 'a-x' }));
    }
    await c.commands.setBudget(target, null, USER, LOCAL);
    expect(c.log.tables.projects.get(project.id)?.budgetUsd).toBeUndefined();
    expect(rec.of('budget.set').at(-1)).toEqual({
      type: 'budget.set',
      target,
      previousUsd: 2,
      by: USER,
    });

    // Not through an update (the types leave it out; an untyped caller is refused), and only a
    // positive amount.
    const untyped = { budgetUsd: 4 } as object;
    await refusal(c.commands.updateProject(project.id, untyped));
    await refusal(c.commands.updateTask(tasks[0]!, untyped));
    await refusal(c.commands.setBudget(target, -1, USER, LOCAL));

    // The panel's edit carries it: control.edit plus budget.set, in one transaction.
    await c.commands.control(
      { kind: 'task', id: tasks[0]! },
      { action: 'edit', changes: { budgetUsd: 0.5, priority: 'high' } },
      USER,
      LOCAL,
    );
    expect(c.log.tables.tasks.get(tasks[0]!)).toMatchObject({ budgetUsd: 0.5, priority: 'high' });
    expect(rec.of('control.edit').at(-1)?.changes).toEqual({ priority: 'high', budgetUsd: 0.5 });
    const raise = await refusal(
      c.commands.control(
        { kind: 'task', id: tasks[0]! },
        { action: 'edit', changes: { budgetUsd: 9 } },
        USER,
        REMOTE,
      ),
    );
    expect(raise.message).toMatch(/only from this machine/);
    expect(c.log.tables.tasks.get(tasks[0]!)?.budgetUsd).toBe(0.5);
  });
});

describe('budgets on cards (P8-01)', () => {
  it('a work card carries the user’s budget to the work it creates; a plan card to its project', async () => {
    const c = boot();
    const rec = recorder(c);
    const { value: card } = await c.commands.createProposal({
      requestText: 'rename the logs',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Rename logs' },
      workspace: '/w/logs',
      rationale: 'small',
      meta: { request: { type: 'standalone_task', name: 'Rename logs' } },
    });
    // The budget on a card is the user's to give, like its trust level.
    const brain = await refusal(
      c.commands.decideProposal(
        card.id,
        { decision: 'edit', changes: { budgetUsd: 3 } },
        { type: 'agent', id: 'a-hq' },
      ),
    );
    expect(brain.message).toMatch(/only the user sets a card's budget/);
    await c.commands.decideProposal(card.id, { decision: 'edit', changes: { budgetUsd: 3 } }, USER);
    expect(c.log.tables.proposals.get(card.id)?.meta?.['budgetUsd']).toBe(3);
    expect(rec.of('proposal.edited').at(-1)?.changes).toEqual({ budgetUsd: 3 });
    await c.commands.decideProposal(card.id, { decision: 'approve' }, USER, REMOTE);
    const task = c.log.tables.tasks.all()[0]!;
    expect(task.budgetUsd).toBe(3);
    expect(rec.of('budget.set').at(-1)).toEqual({
      type: 'budget.set',
      target: { kind: 'task', id: task.id },
      usd: 3,
      by: USER,
    });

    // A plan card: only its budget may be edited, and the approval gives it to the project.
    const { project, waykeeper } = await setup(c, 0);
    const { value: plan } = await c.commands.proposePlan({
      projectId: project.id,
      waykeeperId: waykeeper.id,
      summary: 'Two files',
      tasks: [{ description: 'a' }, { description: 'b' }],
    });
    await refusal(
      c.commands.decideProposal(
        plan.proposal.id,
        { decision: 'edit', changes: { workspace: '/elsewhere' } },
        USER,
      ),
    );
    await c.commands.decideProposal(
      plan.proposal.id,
      { decision: 'edit', changes: { budgetUsd: 10 } },
      USER,
    );
    await c.commands.decideProposal(plan.proposal.id, { decision: 'approve' }, USER, LOCAL);
    expect(c.log.tables.projects.get(project.id)?.budgetUsd).toBe(10);
    expect(c.log.tables.proposals.get(plan.proposal.id)?.state).toBe('approved');
  });
});

describe('budgets against reported cost (P8-01)', () => {
  it('warns once, exceeds once, keeps running agents and refuses new spawns until raised', async () => {
    const c = boot();
    const rec = recorder(c);
    const { project, harmonizer, waykeeper, tasks } = await setup(c, 3);
    await c.commands.setBudget({ kind: 'project', id: project.id }, 1, USER, LOCAL);
    const s1 = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[0]!,
        supervisorId: waykeeper.id,
        prompt: 'scenario:spend',
      })
    ).value;
    await until(() => c.statuses.get(s1.id)?.state === 'idle');

    await report(c, s1.id, 0.5);
    expect(rec.of('budget.warning')).toHaveLength(0);
    await report(c, s1.id, 0.85);
    await until(() => rec.of('budget.warning').length === 1);
    expect(rec.of('budget.warning')[0]).toEqual({
      type: 'budget.warning',
      target: { kind: 'project', id: project.id },
      spentUsd: 0.85,
      budgetUsd: 1,
      warnAtPercent: 80,
    });
    await report(c, s1.id, 0.9); // still in the warning band: no second warning
    await report(c, s1.id, 1.2);
    await until(() => rec.of('budget.exceeded').length === 1);
    await report(c, s1.id, 1.5);
    expect(rec.of('budget.warning')).toHaveLength(1);
    expect(rec.of('budget.exceeded')).toHaveLength(1);
    // The running Steward is not stopped for money (SPEC decision 98).
    expect(c.statuses.get(s1.id)?.state).toBe('idle');

    // A new Steward for the project is refused; nothing but the refusal is written.
    const before = c.log.tables.agents.all().length;
    const error = await refusal(
      c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[1]!,
        supervisorId: waykeeper.id,
        prompt: 'scenario:echo',
      }),
    );
    expect(error.code).toBe('conflict');
    expect(error.message).toMatch(
      /^budget exceeded: project "CSV tool" \(.+\) has spent \$1\.50 of its \$1\.00 budget/,
    );
    expect(c.log.tables.agents.all()).toHaveLength(before);
    expect(rec.of('budget.spawn_refused')).toMatchObject([
      {
        target: { kind: 'project', id: project.id },
        role: 'steward',
        taskId: tasks[1],
        supervisorId: waykeeper.id,
        spentUsd: 1.5,
        budgetUsd: 1,
      },
    ]);
    // The same spawn retried: refused again, but not logged again (once an hour per work).
    const stewardFor = (taskId: string) =>
      c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId,
        supervisorId: waykeeper.id,
        prompt: 'scenario:echo',
      });
    for (let i = 0; i < 3; i++) {
      expect((await refusal(stewardFor(tasks[1]!))).code).toBe('conflict');
    }
    expect(rec.of('budget.spawn_refused')).toHaveLength(1);
    // Another task's spawn is logged: other work. Still one chat line until the budget changes.
    await refusal(stewardFor(tasks[2]!));
    expect(rec.of('budget.spawn_refused')).toHaveLength(2);

    // The Harmonizer's chat shows the warning, the exceeded budget and the refusal.
    await until(() => chatLines(c, harmonizer.id).length === 3);
    const lines = chatLines(c, harmonizer.id);
    expect(lines[0]).toMatch(
      /^Budget warning: project "CSV tool" .* has spent \$0\.85 of its \$1\.00 budget \(85%; the warning is at 80%\)/,
    );
    expect(lines[1]).toMatch(
      /^Budget exceeded: project "CSV tool" .* has spent \$1\.20 of its \$1\.00 budget\. Its running agents go on/,
    );
    expect(lines[2]).toMatch(
      /^Spawn refused: a new steward for task .* has spent \$1\.50 of its \$1\.00 budget/,
    );

    // Raised (locally): the notices re-arm and the spawn goes through.
    await c.commands.setBudget({ kind: 'project', id: project.id }, 5, USER, LOCAL);
    const s2 = await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: tasks[1]!,
      supervisorId: waykeeper.id,
      prompt: 'scenario:echo',
    });
    expect(s2.value.taskId).toBe(tasks[1]);
    // Lowered below the spend: exceeded at once, judged afresh for the new value.
    await c.commands.setBudget({ kind: 'project', id: project.id }, 1.4, USER, LOCAL);
    await until(() => rec.of('budget.exceeded').length === 2);
    expect(rec.of('budget.exceeded')[1]).toMatchObject({ spentUsd: 1.5, budgetUsd: 1.4 });
  });

  it('a task budget binds its Stewards; the Harmonizer is never refused', async () => {
    const c = boot(':memory:', 50);
    const { harmonizer, waykeeper, tasks } = await setup(c, 1);
    const asteroid = (await c.commands.createTask({ description: 'one-off' })).value;
    await c.commands.setBudget({ kind: 'task', id: tasks[0]! }, 0.2, USER, LOCAL);
    await c.commands.setBudget({ kind: 'task', id: asteroid.id }, 0.1, USER, LOCAL);
    const s1 = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[0]!,
        supervisorId: waykeeper.id,
        prompt: 'scenario:spend',
      })
    ).value;
    await until(() => c.statuses.get(s1.id)?.state === 'idle');
    await report(c, s1.id, 0.12); // 60 % with the threshold at 50 %
    await until(() => c.log.eventsSince(0).some((e) => e.event.type === 'budget.warning'));
    await report(c, s1.id, 0.25);
    await c.commands.stopAgent(s1.id, USER);
    const error = await refusal(
      c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[0]!,
        supervisorId: waykeeper.id,
        prompt: 'scenario:echo',
      }),
    );
    expect(error.message).toMatch(/^budget exceeded: task "task 0"/);
    // An asteroid task's Steward is the Harmonizer's; the Harmonizer itself is never refused.
    const s2 = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: asteroid.id,
        supervisorId: harmonizer.id,
        cwd: '/w/one-off',
        prompt: 'scenario:spend',
      })
    ).value;
    await until(() => c.statuses.get(s2.id)?.state === 'idle');
    await report(c, s2.id, 0.3);
    await c.commands.stopAgent(harmonizer.id, USER);
    await until(() => c.statuses.get(harmonizer.id)?.state === 'stopped');
    const hq = await c.commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      cwd: '/w/hq',
      prompt: 'scenario:echo',
    });
    expect(hq.value.role).toBe('harmonizer');
  });

  it('the spend survives a restart without counting twice, and old logs are folded once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'galactic-budget-'));
    dirs.push(dir);
    const path = join(dir, 'galactic.sqlite');
    const c1 = boot(path);
    const { project, waykeeper, tasks } = await setup(c1, 1);
    await c1.commands.setBudget({ kind: 'project', id: project.id }, 1, USER, LOCAL);
    const s1 = (
      await c1.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[0]!,
        supervisorId: waykeeper.id,
        prompt: 'scenario:spend',
      })
    ).value;
    await until(() => c1.statuses.get(s1.id)?.state === 'idle');
    await report(c1, s1.id, 0.9);
    await until(() => c1.log.eventsSince(0).some((e) => e.event.type === 'budget.warning'));
    const before = c1.log.tables.spend.get(s1.id);
    await c1.shutdown();
    lives.splice(lives.indexOf(c1), 1);

    // The next start: the spend is the table's, the warning is not given again.
    const c2 = boot(path);
    expect(c2.log.tables.spend.get(s1.id)).toEqual(before);
    expect(c2.log.snapshot().spend).toContainEqual(before);
    const warnings = () =>
      c2.log.eventsSince(0).filter((e) => e.event.type === 'budget.warning').length;
    expect(warnings()).toBe(1);
    await c2.dispose();
    lives.splice(lives.indexOf(c2), 1);

    // A log written before the projection (migration 0012) is folded once at the next start.
    const db = openDatabase(path);
    db.prepare('DELETE FROM agent_spend').run();
    db.prepare('DELETE FROM budget_notices').run();
    db.prepare("DELETE FROM settings WHERE key = 'budget_projection'").run();
    db.close();
    const c3 = boot(path);
    expect(c3.log.tables.spend.get(s1.id)).toEqual(before);
    expect(c3.log.tables.budgetNotices.get({ kind: 'project', id: project.id })).toEqual({
      level: 'warning',
      budgetUsd: 1,
    });
    expect(c3.log.eventsSince(0).filter((e) => e.event.type === 'budget.warning')).toHaveLength(1);
  });
});
