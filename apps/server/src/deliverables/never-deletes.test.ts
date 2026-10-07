import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Id } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { gitRunner } from '../workspace/git.js';

/**
 * "The deliverables folder is the user's" (P9-06; SPEC decisions 122, 132; TECHNOLOGY §9.4): no
 * code path deletes a file or folder under a project's `deliverables/` folder. Two checks:
 *
 * 1. **Every removal, archive, cancel and retention path** is driven through the composed server
 *    (removing and restoring deliverables, merging and force-removing worktrees, closing,
 *    cancelling and archiving tasks and projects, the archival sweep, transcript retention) and the
 *    folder — copies, the user's own files and folders — is compared after each step.
 * 2. **Every deletion call site in the server's code** is listed below with why it never reaches
 *    a deliverables folder; a new one fails this test until it is reviewed and added.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const USER: Actor = { type: 'user' };
const LOCAL = { origin: 'local' } as const;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

/** Every entry under `dir` with its type, mode and content (files). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      const st = lstatSync(path);
      const key = relative(dir, path);
      if (st.isDirectory()) {
        out[key] = `dir ${st.mode & 0o777}`;
        walk(path);
      } else out[key] = `file ${st.mode & 0o777} ${readFileSync(path, 'utf8')}`;
    }
  };
  walk(dir);
  return out;
}

let tmp: string;
let c: ComposedRuntime;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-never-')));
  mkdirSync(join(tmp, 'home'));
  mkdirSync(join(tmp, 'data'));
  c = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 0 })],
    flushMs: 10,
    workspaces: {
      projectsRoot: join(tmp, 'projects'),
      dataDir: join(tmp, 'data'),
      home: join(tmp, 'home'),
      git: gitRunner({ env: GIT_ENV }),
    },
    deliverables: { freeBytes: () => 100 * 2 ** 30 },
    archival: { retentionMs: 0 },
    transcriptRetention: { policy: { maxAgeDays: 1, archivedDays: 1 } },
  });
});
afterEach(async () => {
  await c.dispose().catch(() => undefined);
  rmSync(tmp, { recursive: true, force: true });
});

describe('the deliverables folder is never deleted from (decision 122)', () => {
  it('survives every removal, archive, cancel and retention path', async () => {
    const { commands, workspaces, deliverableCopies } = c;
    const spaces = workspaces!;
    const copies = deliverableCopies!;
    const project = async (name: string) => {
      const p = (await commands.createProject({ name, workspace: spaces.suggestPath(name) })).value;
      await spaces.prepareProject(p.id);
      return c.log.tables.projects.get(p.id)!;
    };
    const stray = (name: string) => {
      mkdirSync(join(tmp, 'outside'), { recursive: true });
      writeFileSync(join(tmp, 'outside', name), `stray ${name}`);
      return join(tmp, 'outside', name);
    };
    const keep = async (taskId: Id | undefined, projectId: Id | undefined, name: string) => {
      const target = taskId ? { taskId } : { projectId };
      const copy = await copies.copyIn(stray(name), target);
      return (
        await commands.addDeliverable(
          { ...target, kind: 'file', title: name, source: 'user', location: copy.location },
          USER,
          LOCAL,
        )
      ).value;
    };

    // Project A: a project copy, two tasks' copies, the user's own files, then a merge.
    const a = await project('Alpha');
    const t1 = (await commands.createTask({ projectId: a.id, description: 'Merged task' })).value;
    const t2 = (await commands.createTask({ projectId: a.id, description: 'Cancelled task' }))
      .value;
    const own = await keep(undefined, a.id, 'project.txt');
    const d1 = await keep(t1.id, undefined, 'one.txt');
    await keep(t2.id, undefined, 'two.txt');
    const folder = join(a.workspace, 'deliverables');
    mkdirSync(join(folder, 'mine'));
    writeFileSync(join(folder, 'mine', 'kept by the user.md'), 'mine');
    writeFileSync(join(folder, 'loose.txt'), 'loose');

    const wt1 = await spaces.createWorktree(t1.id);
    writeFileSync(join(wt1.path, 'built.txt'), 'built');
    git(wt1.path, 'add', 'built.txt');
    git(wt1.path, 'commit', '-q', '-m', 'built');
    const wt2 = await spaces.createWorktree(t2.id);
    writeFileSync(join(wt2.path, 'draft.txt'), 'draft');
    await commands.addDeliverable(
      {
        taskId: t2.id,
        kind: 'file',
        title: 'draft',
        source: 'user',
        location: { storage: 'worktree', path: realpathSync(join(wt2.path, 'draft.txt')) },
      },
      USER,
      LOCAL,
    );

    let expected = snapshot(folder);
    const unchanged = (step: string) => {
      expect({ step, folder: snapshot(folder) }).toEqual({ step, folder: expected });
    };

    // Removing and restoring deliverables touches no file.
    await commands.removeDeliverable(own.id, USER, 'not wanted', LOCAL);
    await commands.removeDeliverable(d1.id, USER, undefined, LOCAL);
    unchanged('remove');
    await commands.restoreDeliverable(d1.id, USER, LOCAL);
    unchanged('restore');

    // A merge removes the worktree; a cancelled task's worktree is force-removed (its draft is
    // copied in: that adds, never removes).
    expect((await spaces.mergeTask(t1.id)).ok).toBe(true);
    unchanged('merge');
    await commands.control({ kind: 'task', id: t2.id }, { action: 'cancel' }, USER, LOCAL);
    expect(await spaces.removeWorktree(t2.id, { force: true, deleteBranch: true })).toEqual({
      removed: true,
    });
    const after = snapshot(folder);
    for (const [key, value] of Object.entries(expected)) expect(after[key]).toBe(value);
    expect(after['cancelled-task/draft.txt']).toBe('file 420 draft');
    expected = after;

    // Closing and archiving the tasks and the project, the sweep, transcript retention.
    await commands.closeTask(t1.id, USER);
    await commands.archiveTask(t1.id, USER);
    unchanged('task closed and archived');
    await commands.closeProject(a.id, USER);
    unchanged('project closed');
    c.archival.sweep();
    unchanged('archival sweep');
    if (c.log.tables.projects.get(a.id)!.state !== 'archived')
      await commands.archiveProject(a.id, USER);
    expect(c.log.tables.projects.get(a.id)!.state).toBe('archived');
    unchanged('project archived');
    await c.transcriptRetention.run();
    unchanged('transcript retention');

    // Project B: cancelled with its copies in place.
    const b = await project('Beta');
    await keep(undefined, b.id, 'beta.txt');
    const bFolder = join(b.workspace, 'deliverables');
    const bExpected = snapshot(bFolder);
    await commands.control({ kind: 'project', id: b.id }, { action: 'cancel' }, USER, LOCAL);
    c.archival.sweep();
    await c.transcriptRetention.run();
    expect(snapshot(bFolder)).toEqual(bExpected);
    unchanged('another project cancelled');
  });
});

/**
 * Every call in the server's code that deletes a file or folder, by file, with why it never
 * touches a deliverables folder. A deletion added anywhere fails here until it is reviewed.
 */
const ALLOWED_DELETIONS: Record<string, { count: number; why: string }> = {
  'adapters/pty/pty-adapter.ts': {
    count: 2,
    why: "a PTY session's own files under <cwd>/.galactic/pty (rmdir only when empty)",
  },
  'config/settings.ts': { count: 1, why: "the settings file's own temporary file" },
  'db/backup.ts': { count: 4, why: 'backups and partial backups in <dataDir>/backups' },
  'db/data-lock.ts': { count: 3, why: "the data folder's lock files" },
  'db/map-import.ts': { count: 6, why: "the database's files and the import's temporary copy" },
  'db/restore.ts': { count: 2, why: "the database's files in the data folder" },
  'deliverables/copies.ts': {
    count: 2,
    why: "a copy's own `.partial` name (after a failure, or once it is linked into place)",
  },
  'test/harness.ts': { count: 1, why: "the scene harness's temporary data folder" },
  'workspace/workspaces.ts': {
    count: 3,
    why: "`git worktree remove` of a task's worktree (<workspace>/.galactic/worktrees/<id>), never the main folder",
  },
};

const DELETION =
  /\b(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|rmdirAsync)\s*\(|'worktree',\s*'remove'|'clean',|\bsrm\b/g;

describe('deletion call sites (decision 122)', () => {
  it('are only the reviewed ones, none of which reaches a deliverables folder', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const found: Record<string, number> = {};
    const walk = (at: string) => {
      for (const name of readdirSync(at)) {
        const path = join(at, name);
        if (lstatSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
          const text = readFileSync(path, 'utf8')
            // Comments and the permission engine's patterns (`cmd('rm')`) are not calls.
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
          const n = (text.match(DELETION) ?? []).length;
          if (n > 0) found[relative(src, path)] = n;
        }
      }
    };
    walk(src);
    const allowed = Object.fromEntries(
      Object.entries(ALLOWED_DELETIONS).map(([file, { count }]) => [file, count]),
    );
    expect(found).toEqual(allowed);
  });
});
