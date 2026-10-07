import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from '../domain/agents.js';
import { Commands } from '../domain/commands.js';
import { world } from '../test/world.js';
import { worktreeRoot } from '../workspace/workspaces.js';
import { rootsInputOf, rootsOf, standaloneWorkspace } from './roots.js';

/**
 * The one roots computation (`roots.ts`) shared by the declarations, the copies, the merge hook
 * and the routes: a project task, a standalone task in a related project's folder, a scratch task
 * and a standalone task known only from its Steward.
 */

let tmp: string;
let w: ReturnType<typeof world>;
let commands: Commands;
const places = () => ({ dataDir: join(tmp, 'data'), home: join(tmp, 'home') });

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-roots-')));
  for (const d of ['data', 'home', 'app', 'scratch/tidy', 'loose']) {
    mkdirSync(join(tmp, d), { recursive: true });
  }
  w = world();
  commands = new Commands({ log: w.log });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('rootsOf (TECHNOLOGY §9.2)', () => {
  it('a project task: the workspace, the repository, its worktree and the recorded folder', async () => {
    const ws = join(tmp, 'app');
    const project = (await commands.createProject({ name: 'App', workspace: ws })).value;
    await commands.updateProject(project.id, {
      meta: {
        workspace: { git: true, repoRoot: tmp, serialStewards: false },
        deliverablesFolder: join(ws, 'deliverables'),
      },
    });
    const task = (await commands.createTask({ projectId: project.id, description: 'x' })).value;
    // The task alone names its project; both ids give the same roots.
    expect(rootsInputOf(w.tables, { taskId: task.id })).toEqual({
      workspace: ws,
      repoRoot: tmp,
      taskId: task.id,
      deliverablesFolder: join(ws, 'deliverables'),
    });
    expect(rootsInputOf(w.tables, { projectId: project.id, taskId: task.id })).toEqual(
      rootsInputOf(w.tables, { taskId: task.id }),
    );
    const roots = rootsOf(w.tables, { taskId: task.id }, places())!;
    expect(roots).toMatchObject({
      workspace: ws,
      repoRoot: tmp,
      worktree: worktreeRoot(ws, task.id),
      deliverablesFolder: join(ws, 'deliverables'),
      dataDir: join(tmp, 'data'),
    });
    // The project alone: no worktree.
    expect(rootsOf(w.tables, { projectId: project.id }, places())!.worktree).toBeUndefined();
  });

  it('a scratch task: its own workspace and its own recorded folder', async () => {
    const scratch = join(tmp, 'scratch', 'tidy');
    const task = (await commands.createTask({ description: 'tidy notes' })).value;
    await commands.updateTask(task.id, {
      meta: { workspace: scratch, deliverablesFolder: join(scratch, 'deliverables') },
    });
    expect(standaloneWorkspace(w.tables, task.id)).toBe(scratch);
    expect(rootsOf(w.tables, { taskId: task.id }, places())).toMatchObject({
      workspace: scratch,
      deliverablesFolder: join(scratch, 'deliverables'),
    });
    expect(rootsOf(w.tables, { taskId: task.id }, places())!.worktree).toBeUndefined();
  });

  it("a standalone task known only from its Steward's folder; a relative or missing one has none", async () => {
    const task = (await commands.createTask({ description: 'loose' })).value;
    expect(standaloneWorkspace(w.tables, task.id)).toBeUndefined();
    expect(rootsOf(w.tables, { taskId: task.id }, places())).toBeUndefined();
    w.log.runCommand((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: { maxWallClockMs: 1, maxToolCalls: 1 },
        taskId: task.id,
        meta: { cwd: 'relative/path' },
      }),
    );
    expect(standaloneWorkspace(w.tables, task.id)).toBeUndefined();
    w.log.runCommand((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: { maxWallClockMs: 1, maxToolCalls: 1 },
        taskId: task.id,
        meta: { cwd: join(tmp, 'loose') },
      }),
    );
    expect(standaloneWorkspace(w.tables, task.id)).toBe(join(tmp, 'loose'));
    expect(rootsOf(w.tables, { taskId: task.id }, places())!.workspace).toBe(join(tmp, 'loose'));
  });

  it('an unknown project or task has no roots', () => {
    expect(rootsOf(w.tables, { projectId: 'nope' }, places())).toBeUndefined();
    expect(rootsOf(w.tables, { taskId: 'nope' }, places())).toBeUndefined();
    expect(rootsOf(w.tables, {}, places())).toBeUndefined();
  });
});
