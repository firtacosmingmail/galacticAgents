import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@galactic/protocol';
import { recordedFolder, userFoldersOf, type FolderLookup } from './folder.js';

const project = (id: string, workspace: string, meta?: Record<string, unknown>) =>
  ({ id, workspace, ...(meta ? { meta } : {}) }) as unknown as Project;
const task = (id: string, meta?: Record<string, unknown>) =>
  ({ id, ...(meta ? { meta } : {}) }) as unknown as Task;

function lookup(projects: Project[], tasks: Task[] = []): FolderLookup {
  return {
    project: (id) => projects.find((p) => p.id === id),
    task: (id) => tasks.find((t) => t.id === id),
    projects: () => projects,
  };
}

describe('userFoldersOf (P9-06)', () => {
  it("is a project's recorded folder, else <workspace>/deliverables", () => {
    const recorded = project('p-1', '/w/a', { deliverablesFolder: '/w/a/galactic-deliverables' });
    expect(userFoldersOf(lookup([recorded]), { projectId: 'p-1' }, '/w/a')).toEqual([
      '/w/a/galactic-deliverables',
    ]);
    expect(userFoldersOf(lookup([project('p-2', '/w/b')]), { projectId: 'p-2' }, '/w/b')).toEqual(
      ['/w/b/deliverables'],
    );
  });

  it("is a standalone task's own folder and the folder of the project whose workspace it uses", () => {
    const related = project('p-1', '/w/a', { deliverablesFolder: '/w/a/deliverables' });
    const scratch = task('t-1', { deliverablesFolder: '/root/scratch/x/deliverables' });
    expect(
      userFoldersOf(lookup([related], [scratch]), { taskId: 't-1' }, '/root/scratch/x'),
    ).toEqual(['/root/scratch/x/deliverables']);
    expect(userFoldersOf(lookup([related], [task('t-2')]), { taskId: 't-2' }, '/w/a')).toEqual([
      '/w/a/deliverables',
    ]);
    expect(userFoldersOf(lookup([], [task('t-3')]), { taskId: 't-3' }, '/s/y')).toEqual([
      '/s/y/deliverables',
    ]);
  });

  it('ignores a recorded value that is not an absolute path', () => {
    expect(recordedFolder({ deliverablesFolder: 'relative' })).toBeUndefined();
    expect(recordedFolder({ deliverablesFolder: 42 })).toBeUndefined();
    expect(recordedFolder(undefined)).toBeUndefined();
  });
});
