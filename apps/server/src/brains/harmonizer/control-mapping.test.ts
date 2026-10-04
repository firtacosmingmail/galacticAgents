import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { harmonizerBrain } from './index.js';

/**
 * P5-05, SPEC §4.3: "The same control actions are available conversationally through the
 * Harmonizer, which uses the same underlying tools." The mappings the other brain tests did not
 * exercise through the Harmonizer itself, with its real definition and a scripted model (P2-07):
 * status of the system / a project / a task / an agent (`report_status`); pause, resume and stop
 * of an agent below it (`pause_agent`, `resume_agent`, `stop_agent`); and, on the user's
 * confirmation (decision 42), pin, unpin and reopen finished work (`finished_work`) and closing a
 * project asked for in conversation (`ask_confirmation` → `close_project`). Archive-now and the
 * "Anything else?" close are `closure.test.ts`'. Every one lands on the same `control` command
 * the panel's `POST /api/control` calls, so the log shows the Harmonizer as `by`.
 */

const USER = { type: 'user' } as const;
const lives: { h: BrainHarness; root: string }[] = [];
afterEach(async () => {
  for (const { h, root } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const h = brainHarness();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-hq-ctl-')));
  lives.push({ h, root });
  return { h, root, definition: harmonizerBrain({ projectsRoot: root }) };
}

/** The `control.*` events the Harmonizer caused, as `type target action`. */
function controlsBy(h: BrainHarness, harmonizerId: Id): string[] {
  return h.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .map((e) => e.event as { type: string; by?: { type: string; id?: string } })
    .filter((e) => e.type.startsWith('control.') && e.by?.id === harmonizerId)
    .map((e) => e.type);
}

describe('the Harmonizer’s conversational control actions (P5-05, SPEC §4.3)', () => {
  it('reads the status of the whole system, a project, a task and an agent', async () => {
    const { h, root, definition } = setup();
    const project = (await h.commands.createProject({ name: 'CSV tool', workspace: '/w/csv' }))
      .value;
    const task = (await h.commands.createTask({ description: 'Fix the date test' })).value;
    const reports: Record<string, unknown> = {};
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('how is everything?', async (t) => {
            reports['system'] = await t.call('report_status');
            reports['project'] = await t.call('report_status', { projectId: project.id });
            reports['task'] = await t.call('report_status', { taskId: task.id });
            reports['agent'] = await t.call('report_status', { agentId: steward.id });
          })
          .on(
            () => true,
            () => {},
            'anything else',
          ),
    });
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
    await h.settle();
    hq.tell('how is everything?');
    await h.settle();
    expect(reports['system']).toMatchObject({
      projects: [{ id: project.id, name: 'CSV tool' }],
      standaloneTasks: [{ id: task.id, description: 'Fix the date test' }],
    });
    expect(reports['project']).toMatchObject({ project: { id: project.id, name: 'CSV tool' } });
    expect(reports['task']).toMatchObject({
      task: { id: task.id },
      agents: [{ id: steward.id, role: 'steward' }],
    });
    expect(reports['agent']).toMatchObject({ agent: { id: steward.id, role: 'steward' } });
    // Read-only: nothing was controlled.
    expect(controlsBy(h, hq.agentId)).toEqual([]);
  });

  it('pauses, resumes and stops an agent below it', async () => {
    const { h, root, definition } = setup();
    let stewardId: Id = '';
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('pause the date fix', (t) => t.call('pause_agent', { agentId: stewardId }))
          .once('resume it', (t) => t.call('resume_agent', { agentId: stewardId }))
          .once('stop it', (t) => t.call('stop_agent', { agentId: stewardId }))
          .on(
            () => true,
            () => {},
            'reports and anything else',
          ),
    });
    const task = (await h.commands.createTask({ description: 'Fix the date test' })).value;
    stewardId = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: hq.agentId,
        prompt: 'scenario:echo',
        cwd: root,
      })
    ).value.id;
    await h.until(() => h.statuses.get(stewardId)?.state === 'idle', { what: 'the Steward idle' });

    hq.tell('pause the date fix');
    await h.until(() => h.statuses.get(stewardId)?.state === 'paused', { what: 'paused' });
    hq.tell('resume it');
    await h.until(() => h.statuses.get(stewardId)?.state !== 'paused', { what: 'resumed' });
    hq.tell('stop it');
    await h.until(() => h.statuses.get(stewardId)?.state === 'stopped', { what: 'stopped' });
    await h.settle();
    expect(controlsBy(h, hq.agentId)).toEqual(['control.pause', 'control.resume', 'control.stop']);
  });

  it('pins, unpins and reopens finished work, and closes a project, each on the user’s confirmation', async () => {
    const { h, definition } = setup();
    const done = (await h.commands.createTask({ description: 'old script' })).value;
    await h.commands.closeTask(done.id, USER);
    const project = (await h.commands.createProject({ name: 'Tool', workspace: '/w/tool' })).value;
    const asked: Record<string, Id> = {};
    const ask =
      (action: string, kind: 'task' | 'project', id: Id) =>
      async (t: { call: <T>(name: string, input?: unknown) => Promise<T> }) => {
        asked[action] = (
          await t.call<{ questionId: Id }>('ask_confirmation', { kind, id, action })
        ).questionId;
      };
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('pin the old script', ask('pin', 'task', done.id))
          .once(/answered (\S+): "Pin/, (t) =>
            t.call('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'pin',
              questionId: asked['pin'],
            }),
          )
          .once('unpin it', ask('unpin', 'task', done.id))
          .once(/answered (\S+): "Unpin/, (t) =>
            t.call('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'unpin',
              questionId: asked['unpin'],
            }),
          )
          .once('reopen it', ask('reopen', 'task', done.id))
          .once(/answered (\S+): "Reopen/, (t) =>
            t.call('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'reopen',
              questionId: asked['reopen'],
            }),
          )
          .once('close the Tool project', ask('close', 'project', project.id))
          .once(/answered (\S+): "Close Tool/, (t) =>
            t.call('close_project', { projectId: project.id, questionId: asked['close'] }),
          )
          .on(
            () => true,
            () => {},
            'anything else',
          ),
    });
    /** Tells the Harmonizer, then answers its confirmation with its first choice. */
    const confirm = async (say: string, action: string) => {
      hq.tell(say);
      await h.settle();
      const q = h.log.tables.questions.get(asked[action]!)!;
      expect(q).toMatchObject({ status: 'open', holder: USER });
      await h.commands.answerQuestion({
        questionId: q.id,
        answer: q.context.options![0]!,
        by: USER,
      });
      await h.settle();
    };

    await confirm('pin the old script', 'pin');
    expect(h.log.tables.tasks.get(done.id)?.pinned).toBe(true);
    await confirm('unpin it', 'unpin');
    expect(h.log.tables.tasks.get(done.id)?.pinned).toBe(false);
    await confirm('reopen it', 'reopen');
    expect(h.log.tables.tasks.get(done.id)?.state).not.toBe('completed');
    await confirm('close the Tool project', 'close');
    expect(h.log.tables.projects.get(project.id)?.state).toBe('completed');
    hq.assertCalls([
      'ask_confirmation',
      'finished_work',
      'ask_confirmation',
      'finished_work',
      'ask_confirmation',
      'finished_work',
      'ask_confirmation',
      'close_project',
    ]);
  });
});
