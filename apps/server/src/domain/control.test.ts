import { describe, expect, it } from 'vitest';
import { world } from '../test/world.js';
import { recordControl } from './control.js';
import { createProject } from './projects.js';
import { createTask } from './tasks.js';

const USER = { type: 'user' } as const;

function setup() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w' })).value;
  const task = w.run((ctx) => createTask(ctx, { description: 'a', projectId: project.id })).value;
  return { ...w, project, task };
}

describe('recordControl', () => {
  it('records stop/pause/resume/cancel on a task or project with its state effect (cascade.ts)', () => {
    const { run, task, project } = setup();
    const target = { kind: 'task', id: task.id } as const;
    for (const action of ['pause', 'resume', 'stop', 'cancel'] as const) {
      const out = run((ctx) => recordControl(ctx, target, { action }, USER));
      expect(out.events[0]).toEqual({ type: `control.${action}`, target, by: USER });
      expect(out.types.slice(1)).toEqual(['task.state_changed']);
    }
    expect(
      run((ctx) =>
        recordControl(ctx, { kind: 'project', id: project.id }, { action: 'pause' }, USER),
      ).types,
    ).toEqual(['control.pause', 'project.state_changed']);
  });

  it('applies edit, close, archive, pin and reopen in the same transaction as the event', () => {
    const { run, tables, task, project } = setup();
    const target = { kind: 'task', id: task.id } as const;
    expect(
      run((ctx) =>
        recordControl(ctx, target, { action: 'edit', changes: { priority: 'urgent' } }, USER),
      ).events,
    ).toEqual([
      { type: 'control.edit', target, by: USER, changes: { priority: 'urgent' } },
      { type: 'task.updated', taskId: task.id, changes: { priority: 'urgent' } },
    ]);
    expect(
      run((ctx) => recordControl(ctx, target, { action: 'pin', pinned: true }, USER)).types,
    ).toEqual(['control.pin', 'task.updated']);
    expect(run((ctx) => recordControl(ctx, target, { action: 'close' }, USER)).types).toEqual([
      'control.close',
      'task.state_changed',
    ]);
    expect(run((ctx) => recordControl(ctx, target, { action: 'reopen' }, USER)).types).toEqual([
      'control.reopen',
      'task.state_changed',
    ]);
    const p = { kind: 'project', id: project.id } as const;
    run((ctx) => recordControl(ctx, p, { action: 'edit', changes: { name: 'CSV v2' } }, USER));
    run((ctx) => recordControl(ctx, p, { action: 'close' }, USER));
    run((ctx) => recordControl(ctx, target, { action: 'close' }, USER));
    expect(run((ctx) => recordControl(ctx, p, { action: 'archive' }, USER)).types).toEqual([
      'control.archive',
      'project.state_changed',
      'body.freed',
    ]);
    expect(tables.projects.get(project.id)).toMatchObject({ name: 'CSV v2', state: 'archived' });
  });

  it('writes nothing when the effect is refused', () => {
    const { run, log, task } = setup();
    const seq = log.currentSeq();
    const target = { kind: 'task', id: task.id } as const;
    expect(() =>
      run((ctx) =>
        recordControl(ctx, target, { action: 'edit', changes: { bodyId: 'b-x' } }, USER),
      ),
    ).toThrow(/cannot be edited/);
    expect(() => run((ctx) => recordControl(ctx, target, { action: 'reopen' }, USER))).toThrow(
      /not finished/,
    );
    expect(() =>
      run((ctx) => recordControl(ctx, { kind: 'task', id: 't-x' }, { action: 'stop' }, USER)),
    ).toThrow(/no task/);
    expect(() =>
      run((ctx) => recordControl(ctx, { kind: 'agent', id: 'a' }, { action: 'stop' }, USER)),
    ).toThrow(/runtime/);
    expect(log.currentSeq()).toBe(seq);
  });
});
