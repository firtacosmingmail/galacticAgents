import { describe, expect, it } from 'vitest';
import { STEWARD_NAMES } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createProject } from './projects.js';
import { createTask } from './tasks.js';

function withProject() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w/csv' })).value;
  return { ...w, project };
}

describe('Steward names (P15-11, decision 157)', () => {
  it('a new task stores a star name and the title it was given', () => {
    const { run, project } = withProject();
    const task = run((ctx) =>
      createTask(ctx, {
        description: 'Build the prospect list. Save it as CSV.',
        title: '  Prospect list ',
        projectId: project.id,
      }),
    ).value;
    expect(STEWARD_NAMES).toContain(task.meta?.['stewardName']);
    expect(task.meta?.['title']).toBe('Prospect list');
  });

  it('keeps the meta it was given', () => {
    const { run, project } = withProject();
    const task = run((ctx) =>
      createTask(ctx, { description: 'x', projectId: project.id, meta: { proposalId: 'pr-1' } }),
    ).value;
    expect(task.meta?.['proposalId']).toBe('pr-1');
    expect(task.meta?.['title']).toBeUndefined();
  });

  it('no two tasks of a project share a name', () => {
    const { run, project } = withProject();
    const names = Array.from(
      { length: 30 },
      (_, i) =>
        run((ctx) => createTask(ctx, { description: `task ${i}`, projectId: project.id })).value
          .meta?.['stewardName'],
    );
    expect(new Set(names).size).toBe(30);
  });
});
