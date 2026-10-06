// @vitest-environment node
//
// P8-01 — replay vs snapshot for budgets: budgets set, lowered and removed, cost reports folded
// into each agent's spend (cumulative per session, a fresh session adding a meter), the notices
// and a refused spawn. The reducer folds `spend` with the protocol's `foldSpend` from the
// snapshot on, as the server folds its `agent_spend` table; at every commit they must agree.
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, EventEnvelope, Id, Snapshot } from '@galactic/protocol';
import {
  FakeAdapter,
  composeRuntime,
  openDatabase,
  type ComposedRuntime,
  type FakeScenario,
} from '@galactic/server';
import { applyEvent, applySnapshot, type WorldState } from './reduce.js';
import { budgetOf, budgetText } from '../panel/status/status-model.js';

const USER: Actor = { type: 'user' };
const LOCAL = { origin: 'local' as const };

const SCENARIOS: Record<string, FakeScenario> = {
  spend: {
    steps: [{ kind: 'output', text: 'working' }],
    onMessage: (message) => {
      const m = /^cost ([\d.]+)$/.exec(message);
      return m ? [{ kind: 'cost', cost: { usd: Number(m[1]) } }] : [];
    },
  },
};

function tickingClock(): () => string {
  let t = Date.parse('2026-10-05T09:00:00.000Z');
  return () => new Date((t += 1000)).toISOString();
}

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function tables(w: WorldState) {
  const { seq: _seq, statuses: _statuses, ...rest } = w;
  return rest;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('replay vs snapshot conformance: budgets (P8-01)', () => {
  it('folding the recorded log gives the server snapshot, spend included, at every commit', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 0, scenarios: SCENARIOS })],
      log: { now: tickingClock() },
      flushMs: 10,
    });
    lives.push(composed);
    const { log, commands, runtime } = composed;
    const start: Snapshot = { ...log.snapshot(), statuses: [] };
    const recorded: EventEnvelope[] = [];
    const checkpoints: Snapshot[] = [];
    log.subscribe((env) => {
      recorded.push(env);
      if (log.currentSeq() === env.seq) checkpoints.push({ ...log.snapshot(), statuses: [] });
    });

    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const hq = (
      await commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', cwd: '/w/hq', prompt: 'x' })
    ).value;
    const wk = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        supervisorId: hq.id,
        prompt: 'x',
      })
    ).value;
    const tasks: Id[] = [];
    for (const d of ['a', 'b']) {
      tasks.push((await commands.createTask({ description: d, projectId: project.id })).value.id);
    }
    await commands.setBudget({ kind: 'project', id: project.id }, 1, USER, LOCAL);
    await commands.setBudget({ kind: 'task', id: tasks[0]! }, 0.5, USER, LOCAL);

    const s1 = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[0]!,
        supervisorId: wk.id,
        prompt: 'scenario:spend',
      })
    ).value;
    const spent = (usd: number) => Math.abs((log.tables.spend.get(s1.id)?.usd ?? 0) - usd) < 1e-9;
    await until(() => composed.statuses.get(s1.id)?.state === 'idle');
    for (const usd of [0.3, 0.45, 0.6, 1.1]) {
      runtime.send(s1.id, `cost ${usd}`, { sender: USER });
      await until(() => spent(usd));
    }
    // A fresh session on the same row (a renewal): a second meter that adds up.
    await runtime.renewSession(s1.id, 'scenario:spend');
    await until(() => composed.statuses.get(s1.id)?.state === 'idle');
    runtime.send(s1.id, 'cost 0.2', { sender: USER });
    await until(() => spent(1.3));
    await until(() => recorded.some((e) => e.event.type === 'budget.exceeded'));
    await commands
      .spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: tasks[1]!,
        supervisorId: wk.id,
        prompt: 'scenario:echo',
      })
      .catch(() => {});
    await commands.setBudget({ kind: 'project', id: project.id }, null, USER, LOCAL);
    await commands.control(
      { kind: 'task', id: tasks[1]! },
      { action: 'edit', changes: { budgetUsd: 2 } },
      USER,
      LOCAL,
    );

    // A card's budget: edited by the user, dropped, given again, carried to the task on approval.
    const card = (
      await commands.createProposal({
        requestText: 'rename the logs',
        kind: 'asteroid',
        proposedBody: { kind: 'asteroid', name: 'Rename logs' },
        workspace: '/w/logs',
        rationale: 'small',
        meta: { request: { type: 'standalone_task', name: 'Rename logs' } },
      })
    ).value;
    for (const budgetUsd of [3, null, 4]) {
      await commands.decideProposal(card.id, { decision: 'edit', changes: { budgetUsd } }, USER);
    }
    await commands.decideProposal(card.id, { decision: 'approve' }, USER);

    const types = new Set(recorded.map((e) => e.event.type));
    for (const t of [
      'budget.set',
      'budget.warning',
      'budget.exceeded',
      'budget.spawn_refused',
    ] as const) {
      expect(types, t).toContain(t);
    }

    let world = applySnapshot(start);
    let next = 0;
    for (const checkpoint of checkpoints) {
      while (next < recorded.length && recorded[next]!.seq <= checkpoint.seq) {
        world = applyEvent(world, recorded[next++]!);
      }
      expect(tables(world), `at seq ${checkpoint.seq}`).toEqual(tables(applySnapshot(checkpoint)));
    }
    expect(world.spend[s1.id]?.usd).toBeCloseTo(1.3);
    expect(Object.keys(world.spend[s1.id]?.sessions ?? {})).toHaveLength(2);

    // The panel's reading of it.
    const task = budgetOf(world, { kind: 'task', id: tasks[0]! });
    expect(task).toMatchObject({ budgetUsd: 0.5, level: 'exceeded' });
    expect(budgetText(task)).toBe('$1.30 of $0.50 (260%) — exceeded: new agents are refused');
    expect(budgetText(budgetOf(world, { kind: 'project', id: project.id }))).toMatch(
      /^no budget · \$1\.30 spent \(1 of 2 agents did not report a cost\)$/,
    );
    expect(budgetText(budgetOf(world, { kind: 'task', id: tasks[1]! }))).toBe(
      '$0.00 of $2.00 (0%)',
    );
  });
});
