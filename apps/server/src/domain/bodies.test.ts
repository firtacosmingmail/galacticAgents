import { describe, expect, it } from 'vitest';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { assignBody, freeBody, moveHost } from './bodies.js';
import { archiveProject, closeProject, createProject } from './projects.js';
import { closeTask, createTask } from './tasks.js';

const USER = { type: 'user' } as const;
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

describe('moveHost', () => {
  it('moves a project to a free body with its tasks and agents: body.moved and the updates', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w' })).value;
    const t = run((ctx) => createTask(ctx, { description: 'a', projectId: p.id })).value;
    const steward = run((ctx) =>
      createAgent(ctx, { role: 'steward', runtime: 'fake', caps: CAPS, bodyId: p.bodyId, taskId: t.id }),
    ).value;
    const { events } = run((ctx) => moveHost(ctx, { kind: 'project', id: p.id }, 'b-jupiter'));
    expect(events).toEqual([
      { type: 'body.moved', host: { kind: 'project', id: p.id }, fromBodyId: 'b-mars', toBodyId: 'b-jupiter' },
      { type: 'project.updated', projectId: p.id, changes: { bodyId: 'b-jupiter' } },
      { type: 'task.updated', taskId: t.id, changes: { bodyId: 'b-jupiter' } },
      { type: 'agent.updated', agentId: steward.id, changes: { bodyId: 'b-jupiter' } },
    ]);
    expect(tables.bodies.get('b-mars')?.host).toBeUndefined();
    expect(tables.bodies.get('b-jupiter')?.host).toEqual({ kind: 'project', id: p.id });
    expect(tables.projects.get(p.id)?.bodyId).toBe('b-jupiter');
  });

  it('refuses reserved, taken and wrong-kind bodies, and project tasks', () => {
    const { run } = world();
    const p = run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w' })).value;
    const q = run((ctx) => createProject(ctx, { name: 'Other', workspace: '/w2' })).value;
    const t = run((ctx) => createTask(ctx, { description: 'a', projectId: p.id })).value;
    const host = { kind: 'project', id: p.id } as const;
    expect(() => run((ctx) => moveHost(ctx, host, 'b-earth'))).toThrow(/reserved/);
    expect(() => run((ctx) => moveHost(ctx, host, q.bodyId))).toThrow(/already hosts/);
    expect(() => run((ctx) => moveHost(ctx, { kind: 'task', id: t.id }, 'b-phobos'))).toThrow(
      /project's body/,
    );
    const st = run((ctx) => createTask(ctx, { description: 'b' })).value;
    expect(() => run((ctx) => moveHost(ctx, { kind: 'task', id: st.id }, 'b-phobos'))).toThrow(
      /cannot live on a moon/,
    );
  });
});

describe('assignBody and freeBody', () => {
  it('assigns a free body to a host without one and frees it only when the work is finished', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w' })).value;
    expect(() => run((ctx) => freeBody(ctx, 'b-mars'))).toThrow(/which is approved/);
    expect(() => run((ctx) => assignBody(ctx, 'b-jupiter', { kind: 'project', id: p.id }))).toThrow(
      /move it instead/,
    );
    run((ctx) => closeProject(ctx, p.id, USER));
    expect(run((ctx) => freeBody(ctx, 'b-mars')).types).toEqual(['body.freed']);
    expect(run((ctx) => freeBody(ctx, 'b-mars')).types).toEqual([]); // already free
    const { types } = run((ctx) => assignBody(ctx, 'b-jupiter', { kind: 'project', id: p.id }));
    expect(types).toEqual(['body.assigned', 'project.updated']);
    expect(tables.projects.get(p.id)?.bodyId).toBe('b-jupiter');
    expect(() => run((ctx) => assignBody(ctx, 'b-mars', { kind: 'project', id: 'p-x' }))).toThrow(
      /no project p-x/,
    );
  });

  it('never frees a reserved body by archival, and frees a closed asteroid', () => {
    const { run, tables } = world();
    const st = run((ctx) => createTask(ctx, { description: 'b' })).value;
    run((ctx) => closeTask(ctx, st.id, USER));
    run((ctx) => freeBody(ctx, st.bodyId));
    expect(tables.bodies.get(st.bodyId)?.host).toBeUndefined();
    const p = run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w' })).value;
    run((ctx) => closeProject(ctx, p.id, USER));
    run((ctx) => archiveProject(ctx, p.id, USER));
    expect(tables.bodies.get('b-earth')).toMatchObject({ meta: { reserved: true } });
  });
});
