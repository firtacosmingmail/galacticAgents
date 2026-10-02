import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Task } from '@galactic/protocol';
import {
  BrainScript,
  HarnessFailure,
  brainDefinition,
  brainHarness,
  firstTurn,
  tool,
  turnIndex,
  type BrainHarness,
} from './index.js';

/**
 * The harness itself (P2-07): scripts match turn prompts, later calls use earlier results, every
 * call is recorded, and `verify()` explains what went wrong — an expected turn that never came,
 * a turn nobody expected, a refused call, a call to a tool the brain does not have.
 */

const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

const createTask = tool('create_task', async (input, ctx) => {
  const { description } = input as { description: string };
  return (
    await ctx.commands.createTask({
      description,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    })
  ).value;
});
const closeTask = tool('close_task', async (input, ctx) => {
  const { taskId } = input as { taskId: Id };
  return (await ctx.commands.closeTask(taskId, ctx.actor)).value.state;
});

async function boot(opts: { strictHq?: boolean } = {}) {
  const h = brainHarness();
  lives.push(h);
  const hq = await h.startHarmonizer(
    opts.strictHq ? { script: new BrainScript(), definition: brainDefinition('harmonizer') } : {},
  );
  const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
  return { h, hq, projectId: project.id };
}

const failureOf = (h: BrainHarness): HarnessFailure => {
  try {
    h.verify();
  } catch (error) {
    return error as HarnessFailure;
  }
  throw new Error('verify() did not fail');
};

describe('brain harness', () => {
  it('feeds an earlier tool result into the next call, within a turn and across turns', async () => {
    const { h, hq, projectId } = await boot();
    const wk = await h.startBrain(
      brainDefinition('waykeeper', [createTask, closeTask]),
      { runtime: 'fake', projectId, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('add the export', async (t) => {
              const task = await t.call<Task>('create_task', { description: 'write the export' });
              t.say(`created ${task.id}`);
            })
            .once('close it', async (t) => {
              const created = t.transcript.last('create_task')!.value as Task;
              await t.call('close_task', { taskId: created.id });
            }),
      },
    );
    wk.tell('add the export');
    await wk.waitForTurns(2);
    wk.tell('close it');
    await wk.waitForTurns(3);
    await h.done();

    const [created] = wk.calls('create_task');
    const task = created!.value as Task;
    expect(created).toMatchObject({ ok: true, input: { description: 'write the export' } });
    expect(task.projectId).toBe(projectId);
    expect(wk.calls('close_task')).toEqual([
      expect.objectContaining({ ok: true, input: { taskId: task.id }, value: 'completed' }),
    ]);
    expect(h.log.tables.tasks.get(task.id)?.state).toBe('completed');
    wk.assertCalls(['create_task', 'close_task']);
    expect(wk.turns.map((t) => t.rule)).toEqual([
      undefined,
      'prompt mentions "add the export"',
      'prompt mentions "close it"',
    ]);
    expect(wk.turns[1]!.entries).toContainEqual({ kind: 'say', text: `created ${task.id}` });
  });

  it('picks the most specific script: a project-bound one over a role-wide one', async () => {
    const { h, hq, projectId } = await boot();
    const other = (await h.commands.createProject({ name: 'Docs', workspace: '/w/docs' })).value;
    const seen: string[] = [];
    h.script('waykeeper').on((t) => {
      seen.push(`role-wide ${t.projectId}`);
    });
    h.script({ role: 'waykeeper', projectId }).on((t) => {
      seen.push(`project ${t.projectId}`);
    });
    const def = brainDefinition('waykeeper', [createTask]);
    await h.startBrain(def, { runtime: 'fake', projectId, supervisorId: hq.agentId });
    await h.startBrain(def, { runtime: 'fake', projectId: other.id, supervisorId: hq.agentId });
    await h.done();
    expect(seen.sort()).toEqual([`project ${projectId}`, `role-wide ${other.id}`].sort());
  });

  it('reports an expected turn that never came, with the transcript', async () => {
    const { h, hq, projectId } = await boot();
    await h.startBrain(
      brainDefinition('waykeeper', [createTask]),
      { runtime: 'fake', projectId, supervisorId: hq.agentId },
      { script: (s) => s.once(/plan the (\w+)/, () => {}) },
    );
    await h.settle();
    const failure = failureOf(h);
    expect(failure).toBeInstanceOf(HarnessFailure);
    expect(failure.problems).toEqual([
      `waykeeper of project ${projectId}: expected a turn answered by the rule "prompt matches /plan the (\\w+)/", but none came`,
    ]);
    expect(failure.message).toContain('turn 1 (session 1, first prompt) [unscripted]');
    expect(failure.message).toContain('You are the waykeeper. A new session starts here.');
  });

  it('reports a turn no rule answered in a strict script, and lets a lenient one pass', async () => {
    const { h, hq, projectId } = await boot();
    const wk = await h.startBrain(
      brainDefinition('waykeeper', [createTask]),
      { runtime: 'fake', projectId, supervisorId: hq.agentId },
      { script: (s) => s.once(firstTurn, () => {}) },
    );
    wk.tell('are you awake?');
    await h.settle();
    expect(failureOf(h).problems).toEqual([
      `waykeeper ${wk.agentId} (project ${projectId}): unexpected turn 2, no rule matched; it said: ` +
        `"Since your last turn: / 1. the user said: \\"are you awake?\\" / "`,
    ]);

    // The Harmonizer (no script) took no turn here at all; a lenient script never complains.
    const lenient = brainHarness({ script: { strict: false } });
    lives.push(lenient);
    const hq2 = await lenient.startHarmonizer({ script: (s) => s.once(turnIndex(1), () => {}) });
    hq2.tell('hello');
    await lenient.done();
    expect(hq2.turns).toHaveLength(2);
    expect(hq.turns).toHaveLength(1);
  });

  it('records a refused call and an unknown tool as script errors', async () => {
    const { h, hq, projectId } = await boot();
    const wk = await h.startBrain(
      brainDefinition('waykeeper', [closeTask]),
      { runtime: 'fake', projectId, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('close t-missing', (t) => t.call('close_task', { taskId: 't-missing' }))
            .once('spawn one', (t) => t.call('spawn_steward', {})),
      },
    );
    wk.tell('close t-missing');
    await wk.waitForTurns(2);
    wk.tell('spawn one');
    await wk.waitForTurns(3);
    const { problems, message } = failureOf(h);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/turn 2: close_task was refused \(not_found\): .*t-missing/);
    expect(problems[1]).toContain(
      "turn 3: the script called spawn_steward, which is not one of the brain's tools (close_task, carry_summary)",
    );
    expect(message).toContain('→ close_task {"taskId":"t-missing"}');
    expect(message).toContain('✗ not_found');
    // The refusal reached the "model" as a tool result: the turn ended normally.
    expect(h.statuses.get(wk.agentId)?.state).toBe('idle');
  });

  it('fails assertCalls and timed-out waits with readable messages', async () => {
    const { h, hq, projectId } = await boot();
    const wk = await h.startBrain(brainDefinition('waykeeper', [createTask]), {
      runtime: 'fake',
      projectId,
      supervisorId: hq.agentId,
    });
    expect(() => wk.assertCalls(['create_task'])).toThrow(
      /expected the calls \["create_task"\], got \[\]/,
    );
    await expect(wk.waitForTurns(2, { timeoutMs: 30 })).rejects.toThrow(
      /timed out after 30 ms waiting for waykeeper .* to have 2 turns/,
    );
  });

  it('reports runtime errors unless told otherwise', async () => {
    const { h } = await boot();
    h.errors.push('status store: boom');
    expect(failureOf(h).problems).toEqual(['runtime error: status store: boom']);
    const quiet = brainHarness({ failOnErrors: false });
    lives.push(quiet);
    quiet.errors.push('status store: boom');
    expect(() => quiet.verify()).not.toThrow();
  });
});
