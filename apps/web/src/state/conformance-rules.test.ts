// @vitest-environment node
//
// P9-17 — replay vs snapshot for "Allow similar" rules: a rule made from a permission card (the
// answer and `permission.rule_added`), a call it allowed (`permission.decided{ruleId}`), a rule
// removed by the user, another made, and the project closed (its rules removed by the system).
// The reducer folds the rules onto the project's row as the server stores them; at every commit
// they must agree.
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

const USER: Actor = { type: 'user' };

const SCENARIOS: Record<string, FakeScenario> = {
  installs: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'npm install left-pad' },
        permissionAction: 'network',
      },
      { kind: 'tool_call', toolName: 'Bash', input: { command: 'npm install right-pad' } },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'curl https://example.com' },
        permissionAction: 'network',
      },
      { kind: 'finish', result: 'done' },
    ],
  },
};

function tickingClock(): () => string {
  let t = Date.parse('2026-10-12T09:00:00.000Z');
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

describe('replay vs snapshot conformance: "Allow similar" rules (P9-17)', () => {
  it('folding the recorded log gives the server snapshot, rules included, at every commit', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 0, scenarios: SCENARIOS })],
      log: { now: tickingClock() },
      flushMs: 10,
    });
    lives.push(composed);
    const { log, commands, runtime, statuses } = composed;
    const start: Snapshot = { ...log.snapshot(), statuses: [] };
    const recorded: EventEnvelope[] = [];
    const checkpoints: Snapshot[] = [];
    log.subscribe((env) => {
      recorded.push(env);
      if (log.currentSeq() === env.seq) checkpoints.push({ ...log.snapshot(), statuses: [] });
    });

    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (await commands.createTask({ description: 'deps', projectId: project.id })).value;
    const spawned = await runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:installs',
      cwd: '/w/csv',
      taskId: task.id,
      projectId: project.id,
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    const steward = spawned.agent.id;
    const pending = () => statuses.get(steward)?.pendingQuestionId;
    await until(() => pending() !== undefined);
    const q1 = pending()!;

    const made = await commands.allowSimilar({
      questionId: q1,
      scope: 'prefix',
      by: USER,
      origin: 'local',
    });
    await until(() => pending() !== undefined && pending() !== q1);
    const q2 = pending()!;
    await commands.removePermissionRule({
      projectId: project.id,
      ruleId: made.value.id,
      by: USER,
      origin: 'local',
    });
    await commands.allowSimilar({ questionId: q2, scope: 'category', by: USER, origin: 'local' });
    await until(() => statuses.get(steward)?.state === 'finished');
    await commands.closeProject(project.id, USER);

    const types = recorded.map((e) => e.event.type);
    expect(types.filter((t) => t === 'permission.rule_added')).toHaveLength(2);
    expect(types.filter((t) => t === 'permission.rule_removed')).toHaveLength(2);
    expect(
      recorded.some(
        (e) =>
          e.event.type === 'permission.decided' &&
          e.event.decision === 'allow' &&
          e.event.ruleId === made.value.id,
      ),
    ).toBe(true);

    let world = applySnapshot(start);
    let next = 0;
    let sawRules = false;
    for (const checkpoint of checkpoints) {
      while (next < recorded.length && recorded[next]!.seq <= checkpoint.seq) {
        world = applyEvent(world, recorded[next++]!);
      }
      sawRules ||= (world.projects[project.id]?.permissionRules?.length ?? 0) > 0;
      expect(tables(world), `at seq ${checkpoint.seq}`).toEqual(tables(applySnapshot(checkpoint)));
    }
    expect(sawRules).toBe(true);
    const closed = world.projects[project.id as Id];
    expect(closed?.state).toBe('completed');
    expect(closed?.permissionRules).toBeUndefined();
  });
});
