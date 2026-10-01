import { describe, expect, it } from 'vitest';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { archiveProject, closeProject, createProject } from './projects.js';
import { setTaskState } from './states.js';
import {
  archiveTask,
  closeTask,
  createTask,
  moveTask,
  pinTask,
  reopenTask,
  updateTask,
} from './tasks.js';

const USER = { type: 'user' } as const;
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

function withProject() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w/csv' })).value;
  return { ...w, project };
}

describe('createTask', () => {
  it('puts a project task on the project body without occupying a body of its own', () => {
    const { run, tables, project } = withProject();
    const { value, events } = run((ctx) =>
      createTask(ctx, { description: 'Parse CSV', projectId: project.id, priority: 'high' }),
    );
    expect(value).toMatchObject({
      projectId: project.id,
      bodyId: project.bodyId,
      priority: 'high',
      state: 'approved',
      blockedBy: [],
    });
    expect(tables.tasks.get(value.id)).toEqual(value);
    expect(events).toEqual([{ type: 'task.created', task: value }]);
    expect(tables.bodies.get(project.bodyId)?.host).toEqual({ kind: 'project', id: project.id });
  });

  it('gives a standalone task a fresh asteroid: body.created, task.created, body.assigned', () => {
    const { run, tables } = world();
    const { value, types, events } = run((ctx) =>
      createTask(ctx, { description: 'Fix flaky test' }),
    );
    expect(types).toEqual(['body.created', 'task.created', 'body.assigned']);
    const body = tables.bodies.get(value.bodyId);
    expect(body).toMatchObject({ kind: 'asteroid', host: { kind: 'task', id: value.id } });
    expect(events[0]).toEqual({ type: 'body.created', body: { ...body, host: undefined } });
  });

  it('creates plan tasks as proposed and checks blockers', () => {
    const { run, project } = withProject();
    const a = run((ctx) =>
      createTask(ctx, { description: 'a', projectId: project.id, state: 'proposed' }),
    ).value;
    expect(a.state).toBe('proposed');
    const b = run((ctx) =>
      createTask(ctx, { description: 'b', projectId: project.id, blockedBy: [a.id] }),
    ).value;
    expect(b.blockedBy).toEqual([a.id]);
    expect(() =>
      run((ctx) =>
        createTask(ctx, { description: 'c', projectId: project.id, blockedBy: ['t-x'] }),
      ),
    ).toThrow(/no task t-x/);
  });

  it('refuses an archived project, a body for a project task and a taken or non-asteroid body', () => {
    const { run, project } = withProject();
    expect(() =>
      run((ctx) => createTask(ctx, { description: 'x', projectId: project.id, bodyId: 'b-mars' })),
    ).toThrow(/project’s body/);
    expect(() => run((ctx) => createTask(ctx, { description: 'x', bodyId: 'b-jupiter' }))).toThrow(
      /cannot live on a planet/,
    );
    run((ctx) => closeProject(ctx, project.id, USER));
    run((ctx) => archiveProject(ctx, project.id, USER));
    expect(() =>
      run((ctx) => createTask(ctx, { description: 'x', projectId: project.id })),
    ).toThrow(/archived/);
    expect(() => run((ctx) => createTask(ctx, { description: '  ' }))).toThrow(/description/);
  });
});

describe('updateTask', () => {
  it('edits fields with exactly the changes and refuses moves through an update', () => {
    const { run, tables, project } = withProject();
    const t = run((ctx) => createTask(ctx, { description: 'a', projectId: project.id })).value;
    const { events } = run((ctx) =>
      updateTask(ctx, t.id, { priority: 'urgent', worktreePath: '/w/csv/.wt/t', branch: 'g/t' }),
    );
    expect(events).toEqual([
      {
        type: 'task.updated',
        taskId: t.id,
        changes: { priority: 'urgent', worktreePath: '/w/csv/.wt/t', branch: 'g/t' },
      },
    ]);
    expect(tables.tasks.get(t.id)).toMatchObject({ priority: 'urgent', branch: 'g/t' });
    expect(() => run((ctx) => updateTask(ctx, t.id, { bodyId: 'b-jupiter' }))).toThrow(/moving/);
    expect(() => run((ctx) => updateTask(ctx, t.id, { projectId: 'p-x' }))).toThrow(/moving/);
    expect(() => run((ctx) => updateTask(ctx, t.id, { blockedBy: [t.id] }))).toThrow(/itself/);
    expect(run((ctx) => updateTask(ctx, t.id, { description: undefined } as never)).events).toEqual(
      [],
    );
  });

  it('pins', () => {
    const { run, tables, project } = withProject();
    const t = run((ctx) => createTask(ctx, { description: 'a', projectId: project.id })).value;
    run((ctx) => pinTask(ctx, t.id, true));
    expect(tables.tasks.get(t.id)?.pinned).toBe(true);
  });
});

describe('task states', () => {
  it('closes, archives (freeing an asteroid only) and reopens', () => {
    const { run, tables, project } = withProject();
    const pt = run((ctx) => createTask(ctx, { description: 'a', projectId: project.id })).value;
    const st = run((ctx) => createTask(ctx, { description: 'b' })).value;

    expect(run((ctx) => closeTask(ctx, pt.id, USER)).events).toEqual([
      { type: 'task.state_changed', taskId: pt.id, from: 'approved', to: 'completed', by: USER },
    ]);
    expect(() => run((ctx) => closeTask(ctx, pt.id, USER))).toThrow(/already completed/);
    expect(run((ctx) => archiveTask(ctx, pt.id, USER)).types).toEqual(['task.state_changed']);
    expect(tables.bodies.get(project.bodyId)?.host).toEqual({ kind: 'project', id: project.id });

    run((ctx) => closeTask(ctx, st.id, USER));
    expect(run((ctx) => archiveTask(ctx, st.id, USER)).types).toEqual([
      'task.state_changed',
      'body.freed',
    ]);
    expect(run((ctx) => reopenTask(ctx, st.id, USER)).types).toEqual([
      'body.assigned',
      'task.state_changed',
    ]);
    expect(tables.tasks.get(st.id)?.state).toBe('approved');
    expect(run((ctx) => reopenTask(ctx, pt.id, USER)).value.state).toBe('approved');
  });

  it('reopens a standalone task on a fresh asteroid when the old one was taken', () => {
    const { run, tables } = world();
    const st = run((ctx) => createTask(ctx, { description: 'b' })).value;
    run((ctx) => closeTask(ctx, st.id, USER));
    run((ctx) => archiveTask(ctx, st.id, USER));
    run((ctx) => createTask(ctx, { description: 'squatter', bodyId: st.bodyId }));
    const { value, types } = run((ctx) => reopenTask(ctx, st.id, USER));
    expect(value.bodyId).not.toBe(st.bodyId);
    expect(types).toEqual(['body.created', 'body.assigned', 'task.updated', 'task.state_changed']);
    expect(tables.bodies.get(value.bodyId)?.host).toEqual({ kind: 'task', id: st.id });
  });

  it('rejects invalid transitions', () => {
    const { run, project } = withProject();
    const t = run((ctx) => createTask(ctx, { description: 'a', projectId: project.id })).value;
    run((ctx) => setTaskState(ctx, t.id, 'in_progress'));
    expect(() => run((ctx) => setTaskState(ctx, t.id, 'proposed'))).toThrow(/cannot go/);
    expect(() => run((ctx) => reopenTask(ctx, t.id, USER))).toThrow(/not finished/);
    run((ctx) => setTaskState(ctx, t.id, 'moved'));
    expect(() => run((ctx) => setTaskState(ctx, t.id, 'in_progress'))).toThrow(/cannot go/);
  });
});

describe('moveTask', () => {
  it('moves a standalone task onto the project body, frees its asteroid, flies its agent', () => {
    const { run, tables, project } = withProject();
    const st = run((ctx) => createTask(ctx, { description: 'b' })).value;
    const steward = run((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        bodyId: st.bodyId,
        taskId: st.id,
      }),
    ).value;
    const { value, events } = run((ctx) => moveTask(ctx, st.id, project.id, USER));
    expect(value).toMatchObject({ projectId: project.id, bodyId: project.bodyId });
    expect(events).toEqual([
      {
        type: 'task.updated',
        taskId: st.id,
        changes: { projectId: project.id, bodyId: project.bodyId },
      },
      { type: 'body.freed', bodyId: st.bodyId },
      { type: 'agent.updated', agentId: steward.id, changes: { bodyId: project.bodyId } },
    ]);
    expect(tables.bodies.get(st.bodyId)?.host).toBeUndefined();
    expect(tables.agents.get(steward.id)?.bodyId).toBe(project.bodyId);
    expect(() => run((ctx) => moveTask(ctx, st.id, project.id, USER))).toThrow(/already belongs/);
  });
});
