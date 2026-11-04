import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import { brainHarness, type BrainHarness, type ToolOutcome } from '../testing/index.js';
import { waykeeperDefinition } from './index.js';

/**
 * P10-02 — a long-term project never starts the "anything else?" closure flow (SPEC decision
 * 142): `request_project_closure` refuses it, and `close_task` of its last task gives no closure
 * hint. Only the user closes it.
 */

const LONG_TERM = { purpose: 'Grow the app', goals: ['1000 users'] };

let h: BrainHarness;
beforeEach(() => {
  h = brainHarness();
});
afterEach(async () => {
  await h.dispose().catch(() => {});
});

describe('closing work of a long-term project (P10-02)', () => {
  it('refuses request_project_closure and omits the closure hint from close_task', async () => {
    const project = (
      await h.commands.createProject({ name: 'App', workspace: '/tmp/app', longTerm: LONG_TERM })
    ).value;
    const done = (await h.commands.createTask({ projectId: project.id, description: 'one' })).value;
    await h.commands.closeTask(done.id, { type: 'user' });
    const last = (await h.commands.createTask({ projectId: project.id, description: 'two' })).value;
    let closed: Record<string, unknown> | undefined;
    let refusal: ToolOutcome | undefined;
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s.once('wrap up', async (t) => {
            closed = await t.call<Record<string, unknown>>('close_task', { taskId: last.id });
            refusal = await t.try('request_project_closure', { summary: 'All done.' });
          }),
      },
    );
    wk.tell('wrap up');
    await h.done();
    expect(closed).toMatchObject({ openTasks: [] });
    expect(closed).not.toHaveProperty('allTasksClosed');
    expect(closed).not.toHaveProperty('next');
    expect(refusal).toMatchObject({
      ok: false,
      error: 'invalid',
      message: 'long-term projects are closed by the user only',
    });
    expect(h.log.tables.projects.get(project.id)?.state).not.toBe('completed');
    expect(h.log.tables.projects.get(project.id)?.meta?.['closureRequest']).toBeUndefined();
  });

  it('a recurring job’s hidden task is not one of the Waykeeper’s tasks (P10-03)', async () => {
    const project = (
      await h.commands.createProject({ name: 'App', workspace: '/tmp/app', longTerm: LONG_TERM })
    ).value;
    const { job } = (
      await h.commands.createJob({
        projectId: project.id,
        area: { name: 'Feedback' },
        draft: {
          name: 'Read reviews',
          instructions: 'Read the new reviews.',
          schedule: { kind: 'daily', at: '09:00' },
          provider: 'claude',
          unattendedRules: [],
        },
        by: { type: 'user' },
      })
    ).value;
    const last = (await h.commands.createTask({ projectId: project.id, description: 'one' })).value;
    let closed: Record<string, unknown> | undefined;
    let refusal: ToolOutcome | undefined;
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s.once('wrap up', async (t) => {
            refusal = await t.try('close_task', { taskId: job.taskId });
            closed = await t.call<Record<string, unknown>>('close_task', { taskId: last.id });
          }),
      },
    );
    wk.tell('wrap up');
    await h.done();
    expect(refusal).toMatchObject({ ok: false, error: 'invalid' });
    expect(closed).toMatchObject({ openTasks: [] });
    expect(h.log.tables.tasks.get(job.taskId)?.state).toBe('approved');
  });

  it('an ordinary project still gets the closure hint', async () => {
    const project = (await h.commands.createProject({ name: 'Tool', workspace: '/tmp/tool' }))
      .value;
    const last: Id = (await h.commands.createTask({ projectId: project.id, description: 'x' }))
      .value.id;
    let closed: Record<string, unknown> | undefined;
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s.once('wrap up', async (t) => {
            closed = await t.call<Record<string, unknown>>('close_task', { taskId: last });
          }),
      },
    );
    wk.tell('wrap up');
    await h.done();
    expect(closed).toMatchObject({ allTasksClosed: true });
  });
});
