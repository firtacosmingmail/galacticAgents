import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id, Task } from '@galactic/protocol';
import { brainDefinition, harmonizerDefinition, tool } from '../testing/canned.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import type { ToolOutcome } from '../testing/transcript.js';
import type { BrainToolContext } from '../definition.js';
import { USED_FOR } from '../../domain/questions.js';
import { controlWorkTool } from './control-tools.js';
import { harmonizerBrain } from './index.js';

/**
 * P5-07, SPEC decision 83: `control_work`, the panel's work controls in conversation, driven
 * through the Harmonizer's real definition by a scripted model (P2-07). Pause, resume and edit
 * run at once; stop and cancel only on an answered `ask_confirmation` for that exact action and
 * target, which is used up; the trust level, unknown fields and the scene harness's rows are
 * refused; the log shows the Harmonizer as `by` and the supervisors are woken as for a panel
 * action.
 */

const USER = { type: 'user' } as const;
const TOKEN = 'DO-CALL';
const lives: { h: BrainHarness; root: string }[] = [];
afterEach(async () => {
  for (const { h, root } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A Harmonizer whose model makes one call per `call(tool, input)`: the test says the token, the
 * script runs `t.try(tool, input)`, and the outcome comes back. Every other turn does nothing.
 */
async function setup() {
  const h = brainHarness();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-hq-cw-')));
  lives.push({ h, root });
  let next: { tool: string; input: unknown } | undefined;
  let outcome: ToolOutcome | undefined;
  const hq = await h.startHarmonizer({
    definition: harmonizerBrain({ projectsRoot: root }),
    script: (s) =>
      s
        .on(
          TOKEN,
          async (t) => {
            outcome = await t.try(next!.tool, next!.input);
          },
          'the call the test asks for',
        )
        .on(
          () => true,
          () => {},
          'anything else',
        ),
  });
  await h.settle();
  const call = async (name: string, input: unknown): Promise<ToolOutcome> => {
    next = { tool: name, input };
    outcome = undefined;
    hq.tell(TOKEN);
    await h.settle();
    expect(outcome, `the model called ${name}`).toBeDefined();
    return outcome!;
  };
  /** Asks for a confirmation and answers it (`answer`: its first choice by default). */
  const confirm = async (
    kind: 'task' | 'project',
    id: Id,
    action: string,
    answer?: string,
  ): Promise<Id> => {
    const asked = await call('ask_confirmation', { kind, id, action });
    expect(asked.ok, asked.message).toBe(true);
    const questionId = (asked.value as { questionId: Id }).questionId;
    const q = h.log.tables.questions.get(questionId)!;
    await h.commands.answerQuestion({
      questionId,
      answer: answer ?? q.context.options![0]!,
      by: USER,
    });
    await h.settle();
    return questionId;
  };
  /** The work-level `control.*` events the Harmonizer caused (its agents' effects left out). */
  const controlsBy = (): string[] =>
    h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map(
        (e) =>
          e.event as {
            type: string;
            target?: { kind: string };
            by?: { type: string; id?: string };
          },
      )
      .filter(
        (e) =>
          e.type.startsWith('control.') && e.target?.kind !== 'agent' && e.by?.id === hq.agentId,
      )
      .map((e) => e.type);
  /** A standalone task with an idle Steward under the Harmonizer. */
  const asteroidTask = async (description: string) => {
    const task = (await h.commands.createTask({ description })).value;
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        prompt: 'scenario:echo',
        cwd: root,
      })
    ).value;
    await h.until(() => h.statuses.get(steward.id)?.state === 'idle', { what: 'Steward idle' });
    return { task, steward };
  };
  return { h, root, hq, call, confirm, controlsBy, asteroidTask };
}

const control = (kind: 'task' | 'project', id: Id, action: string, extra: object = {}) => ({
  target: { kind, id },
  action,
  ...extra,
});

describe('control_work: the panel’s work controls in conversation (P5-07, decision 83)', () => {
  it('pauses, resumes and edits at once, as the Harmonizer, and the Waykeeper is told', async () => {
    const { h, root, hq, call, controlsBy } = await setup();
    const project = (await h.commands.createProject({ name: 'CSV tool', workspace: root })).value;
    const wk = await h.startBrain(
      brainDefinition('waykeeper'),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s.on(
            () => true,
            () => {},
            'listens',
          ),
      },
    );
    const task = (
      await h.commands.createTask({ description: 'Parse dates', projectId: project.id })
    ).value;
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: wk.agentId,
        prompt: 'scenario:echo',
      })
    ).value;
    await h.until(() => h.statuses.get(steward.id)?.state === 'idle', { what: 'Steward idle' });
    await h.settle();

    const paused = await call('control_work', control('task', task.id, 'pause'));
    expect(paused.ok, paused.message).toBe(true);
    expect(paused.value).toMatchObject({ kind: 'task', id: task.id, state: 'paused' });
    await h.until(() => h.statuses.get(steward.id)?.state === 'paused', { what: 'paused' });
    await h.settle();
    expect(wk.prompts().join('\n')).toMatch(new RegExp(`paused task ${task.id}`));

    const resumed = await call('control_work', control('task', task.id, 'resume'));
    expect(resumed.ok, resumed.message).toBe(true);
    await h.until(() => h.statuses.get(steward.id)?.state !== 'paused', { what: 'resumed' });
    await h.settle();
    expect(wk.prompts().join('\n')).toMatch(new RegExp(`resumed task ${task.id}`));

    const edited = await call(
      'control_work',
      control('task', task.id, 'edit', {
        changes: { description: 'Parse ISO dates', priority: 'high' },
      }),
    );
    expect(edited.ok, edited.message).toBe(true);
    expect(h.log.tables.tasks.get(task.id)).toMatchObject({
      description: 'Parse ISO dates',
      priority: 'high',
    });
    const renamed = await call(
      'control_work',
      control('project', project.id, 'edit', { changes: { name: 'CSV kit' } }),
    );
    expect(renamed.ok, renamed.message).toBe(true);
    expect(h.log.tables.projects.get(project.id)?.name).toBe('CSV kit');
    await h.settle();
    expect(wk.prompts().join('\n')).toMatch(new RegExp(`edited project ${project.id}`));

    expect(controlsBy()).toEqual([
      'control.pause',
      'control.resume',
      'control.edit',
      'control.edit',
    ]);
    // Nothing asked the user: pause, resume and edit need no confirmation.
    expect(h.log.tables.questions.all()).toEqual([]);
  });

  it('stops and cancels only after the user confirmed that action on that work, once', async () => {
    const { h, call, confirm, controlsBy, asteroidTask } = await setup();
    const { task, steward } = await asteroidTask('Fix the date test');

    for (const action of ['stop', 'cancel']) {
      const refused = await call('control_work', control('task', task.id, action));
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/ask_confirmation first/);
    }
    expect(controlsBy()).toEqual([]);

    const stopQ = await confirm('task', task.id, 'stop');
    expect(h.log.tables.questions.get(stopQ)?.context.options?.[0]).toMatch(/^Stop task "Fix/);
    const stopped = await call(
      'control_work',
      control('task', task.id, 'stop', { questionId: stopQ }),
    );
    expect(stopped.ok, stopped.message).toBe(true);
    await h.until(() => h.statuses.get(steward.id)?.state === 'stopped', { what: 'stopped' });
    expect(h.log.tables.tasks.get(task.id)?.state).toBe('paused');
    // Used up on the question's row, in the control's own transaction; the task's history shows
    // no extra edit for it.
    expect(h.log.tables.questions.get(stopQ)?.meta?.[USED_FOR]).toBe(`stop task ${task.id}`);
    expect(h.log.tables.tasks.get(task.id)?.meta?.['usedConfirmations']).toBeUndefined();

    // The same answer does not unlock a second stop.
    const again = await call(
      'control_work',
      control('task', task.id, 'stop', { questionId: stopQ }),
    );
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already used/);

    const cancelQ = await confirm('task', task.id, 'cancel');
    const cancelled = await call(
      'control_work',
      control('task', task.id, 'cancel', { questionId: cancelQ }),
    );
    expect(cancelled.ok, cancelled.message).toBe(true);
    expect(h.log.tables.tasks.get(task.id)?.state).toBe('failed');
    expect(controlsBy()).toEqual(['control.stop', 'control.cancel']);
    expect(
      h.log
        .eventsSince(0, Number.MAX_SAFE_INTEGER)
        .some(
          (e) =>
            e.event.type === 'task.updated' &&
            e.event.taskId === task.id &&
            e.event.changes.meta !== undefined,
        ),
    ).toBe(false);

    // A control the domain refuses (a failed task cannot be stopped) leaves the answer unused.
    const lateQ = await confirm('task', task.id, 'stop');
    const late = await call(
      'control_work',
      control('task', task.id, 'stop', { questionId: lateQ }),
    );
    expect(late.ok).toBe(false);
    expect(late.message).toMatch(/is failed/);
    expect(h.log.tables.questions.get(lateQ)?.meta?.[USED_FOR]).toBeUndefined();
    expect(controlsBy()).toEqual(['control.stop', 'control.cancel']);
  });

  it('two calls with one answer at the same time: exactly one goes through', async () => {
    const { h, hq, confirm, controlsBy, asteroidTask } = await setup();
    const { task } = await asteroidTask('Fix the date test');
    const stopQ = await confirm('task', task.id, 'stop');
    const ctx = {
      brainId: hq.agentId,
      role: 'harmonizer',
      actor: { type: 'agent', id: hq.agentId },
      commands: h.commands,
      queries: h.composed.queries,
      send: () => ({ messageId: 'm' }),
    } as unknown as BrainToolContext;
    const input = control('task', task.id, 'stop', { questionId: stopQ });
    const results = await Promise.allSettled([
      controlWorkTool.handler(input, ctx),
      controlWorkTool.handler(input, ctx),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((refused.reason as Error).message).toMatch(/already used/);
    expect(controlsBy()).toEqual(['control.stop']);
  });

  it('a confirmation for another action, another work or a "No" unlocks nothing', async () => {
    const { h, call, confirm, controlsBy, asteroidTask } = await setup();
    const { task } = await asteroidTask('Fix the date test');
    const { task: other } = await asteroidTask('Write the changelog');

    const cancelQ = await confirm('task', task.id, 'cancel');
    const otherStopQ = await confirm('task', other.id, 'stop');
    const declined = await confirm('task', task.id, 'stop', 'No');
    const pinQ = await confirm('task', task.id, 'pin');
    for (const questionId of [cancelQ, otherStopQ, declined, pinQ]) {
      const refused = await call('control_work', control('task', task.id, 'stop', { questionId }));
      expect(refused.ok, `${questionId} must not unlock a stop`).toBe(false);
      expect(refused.message).toMatch(/only the user decides to stop/);
    }
    // A question the user answered "Stop …" but that another agent asked: not this Harmonizer's.
    const third = await asteroidTask('Third');
    const foreign = (
      await h.commands.openQuestion({
        kind: 'clarification',
        originAgentId: third.steward.id,
        context: {
          text: 'Stop?',
          options: [`Stop task "Fix the date test" (${task.id}) (its agents stop)`],
        },
        toUser: true,
      })
    ).value;
    await h.commands.answerQuestion({ questionId: foreign.id, answer: 'yes', by: USER });
    await h.settle();
    const out = await call(
      'control_work',
      control('task', task.id, 'stop', { questionId: foreign.id }),
    );
    expect(out.ok).toBe(false);
    expect(controlsBy()).toEqual([]);
    expect(h.log.tables.tasks.get(task.id)?.state).not.toBe('paused');
  });

  it('refuses the trust level, fields the panel cannot edit, and changes outside edit', async () => {
    const { h, call, controlsBy } = await setup();
    const project = (await h.commands.createProject({ name: 'Tool', workspace: '/w/tool' })).value;
    const task = (await h.commands.createTask({ description: 'old', projectId: project.id })).value;
    const cases: [object, RegExp][] = [
      [
        control('project', project.id, 'edit', { changes: { permissionPolicy: null } }),
        /stay the user's \(decision 49\)/,
      ],
      [
        control('project', project.id, 'edit', { changes: { trustLevel: 'trusted' } }),
        /decision 49/,
      ],
      [control('task', task.id, 'edit', { changes: { name: 'x' } }), /description, priority/],
      [control('task', task.id, 'edit', { changes: { priority: 'asap' } }), /priority/],
      [control('project', project.id, 'edit', { changes: { description: 'x' } }), /name, budgetUsd only/],
      [control('project', project.id, 'edit', { changes: { name: '  ' } }), /name/],
      [control('project', project.id, 'edit'), /an edit needs changes/],
      [control('task', task.id, 'pause', { changes: { priority: 'low' } }), /go with "edit" only/],
      [control('task', task.id, 'close'), /action/],
      [{ target: { kind: 'agent', id: task.id }, action: 'pause' }, /target\.kind/],
      [control('task', 'task_missing', 'pause'), /task_missing/],
    ];
    for (const [input, message] of cases) {
      const out = await call('control_work', input);
      expect(out.ok, JSON.stringify(input)).toBe(false);
      expect(out.message).toMatch(message);
    }
    expect(h.log.tables.projects.get(project.id)).toMatchObject({ name: 'Tool' });
    expect(h.log.tables.projects.get(project.id)?.permissionPolicy).toBeUndefined();
    expect(controlsBy()).toEqual([]);
  });

  it('refuses the scene harness’s rows (decision 79)', async () => {
    const { h, call, controlsBy } = await setup();
    const task = (await h.commands.createTask({ description: 'demo', meta: { harness: true } }))
      .value;
    const project = (
      await h.commands.createProject({
        name: 'Demo',
        workspace: '/w/demo',
        meta: { harness: true },
      })
    ).value;
    for (const input of [
      control('task', task.id, 'pause'),
      control('project', project.id, 'pause'),
    ]) {
      const out = await call('control_work', input);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/scene harness/);
    }
    expect(controlsBy()).toEqual([]);
  });
});

describe('the turn’s origin reaches control (P2-21)', () => {
  it('the runner gives a tool the origin of the turn’s user messages', async () => {
    const h = brainHarness();
    lives.push({ h, root: realpathSync(mkdtempSync(join(tmpdir(), 'galactic-hq-or-'))) });
    const seen: unknown[] = [];
    const brain = await h.startBrain(
      harmonizerDefinition([tool('where_from', (_input, ctx) => ctx.origin ?? 'unknown')]),
      { runtime: 'fake', cwd: '/' },
      {
        script: (s) =>
          s
            .on('ORIGIN-CHECK', async (t) => {
              seen.push(await t.call('where_from'));
            })
            .on(
              () => true,
              () => {},
              'anything else',
            ),
      },
    );
    await h.settle();
    h.runtime.send(brain.agentId, 'ORIGIN-CHECK here', { sender: USER, origin: 'local' });
    await h.settle();
    h.runtime.send(brain.agentId, 'ORIGIN-CHECK afar', { sender: USER, origin: 'remote' });
    await h.settle();
    brain.tell('ORIGIN-CHECK nowhere');
    await h.settle();
    expect(seen).toEqual(['local', 'remote', 'unknown']);
  });

  it('control_work passes it to the control command, with the Harmonizer as actor', async () => {
    const task = { id: 'task_1', description: 'x', state: 'in_progress' } as unknown as Task;
    const controlSpy = vi.fn(async () => ({ value: undefined, events: [] }));
    const ctx = {
      brainId: 'agent_hq',
      role: 'harmonizer',
      actor: { type: 'agent', id: 'agent_hq' },
      origin: 'remote',
      commands: { control: controlSpy },
      queries: { task: () => task, project: () => undefined },
      send: () => ({ messageId: 'm' }),
    } as unknown as BrainToolContext;
    await controlWorkTool.handler(
      { target: { kind: 'task', id: 'task_1' }, action: 'edit', changes: { priority: 'low' } },
      ctx,
    );
    expect(controlSpy).toHaveBeenCalledWith(
      { kind: 'task', id: 'task_1' },
      { action: 'edit', changes: { priority: 'low' } },
      { type: 'agent', id: 'agent_hq' },
      { origin: 'remote' },
    );
  });
});
