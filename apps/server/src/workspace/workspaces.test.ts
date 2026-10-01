import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Commands } from '../domain/commands.js';
import { world } from '../test/world.js';
import { gitRunner } from './git.js';
import {
  branchName,
  slugify,
  stewardsSerialised,
  workspaceMeta,
  Workspaces,
} from './workspaces.js';

// Git sees no global or system config: no identity (the server's fallback is used), no hooks
// path, no signing — whatever the developer's machine has configured.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

let tmp: string;
let w: ReturnType<typeof world>;
let commands: Commands;
let spaces: Workspaces;

/** Git as the test (playing a Steward) runs it, with a per-call identity. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test Steward', '-c', 'user.email=steward@test', ...args],
    { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' },
  ).trim();
}

function commitFile(cwd: string, file: string, text: string, message = `edit ${file}`): void {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-ws-')));
  mkdirSync(join(tmp, 'home'));
  mkdirSync(join(tmp, 'data'));
  w = world();
  commands = new Commands({ log: w.log });
  spaces = new Workspaces({
    projectsRoot: join(tmp, 'projects root'),
    dataDir: join(tmp, 'data'),
    home: join(tmp, 'home'),
    git: gitRunner({ env: GIT_ENV }),
    commands,
    tables: w.tables,
  });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function project(name: string, workspace?: string, initGit = false) {
  const created = await commands.createProject({
    name,
    workspace: workspace ?? spaces.suggestPath(name),
  });
  const info = await spaces.prepareProject(created.value.id, { initGit });
  return { project: w.tables.projects.get(created.value.id)!, info };
}

async function task(projectId: string, description: string) {
  return (await commands.createTask({ projectId, description })).value;
}

describe('names', () => {
  it('slugifies names and builds galactic/<task-id>-<slug> branches', () => {
    expect(slugify('  CSV → Parquet CLI! ')).toBe('csv-parquet-cli');
    expect(slugify('Ünïcödé café')).toBe('unicode-cafe');
    expect(slugify('***')).toBe('project');
    expect(branchName({ id: 't-1', description: 'Add the session middleware' })).toBe(
      'galactic/t-1-add-the-session-middleware',
    );
  });
});

describe('workspace paths', () => {
  it('refuses /, the home directory, the projects root and anything around the data dir', () => {
    expect(() => spaces.checkPath('/')).toThrow(/cannot be \//);
    expect(() => spaces.checkPath(join(tmp, 'home'))).toThrow(/home directory/);
    expect(() => spaces.checkPath(join(tmp, 'projects root'))).toThrow(/projects root/);
    expect(() => spaces.checkPath(join(tmp, 'data'))).toThrow(/data directory/);
    expect(() => spaces.checkPath(join(tmp, 'data', 'sub', 'dir'))).toThrow(/data directory/);
    expect(() => spaces.checkPath(tmp)).toThrow(/data directory/);
    expect(() => spaces.checkPath('relative/dir')).toThrow(/absolute/);
    expect(() => spaces.checkPath('  ')).toThrow(/needs a workspace/);
    expect(spaces.checkPath(join(tmp, 'home', 'work', 'a b'))).toBe(
      join(tmp, 'home', 'work', 'a b'),
    );
  });

  it('suggests <projectsRoot>/<slug>, numbered when the folder is taken', () => {
    const first = spaces.suggestPath('CSV to Parquet');
    expect(first).toBe(join(tmp, 'projects root', 'csv-to-parquet'));
    mkdirSync(first, { recursive: true });
    expect(spaces.suggestPath('CSV to Parquet')).toBe(`${first}-2`);
  });

  it('refuses a workspace that is a file', async () => {
    writeFileSync(join(tmp, 'a-file'), 'x');
    await expect(spaces.prepare({ name: 'x', path: join(tmp, 'a-file') })).rejects.toThrow(
      /not a folder/,
    );
  });
});

describe('prepare', () => {
  it('creates a new folder as a git repository with an empty root commit and records it', async () => {
    const { project: p, info } = await project('CSV to Parquet');
    expect(info).toMatchObject({
      created: true,
      git: true,
      initialised: true,
      serialStewards: false,
    });
    expect(p.workspace).toBe(join(tmp, 'projects root', 'csv-to-parquet'));
    expect(p.repoPath).toBe(p.workspace);
    expect(workspaceMeta(p)).toMatchObject({ git: true, baseBranch: info.baseBranch });
    expect(stewardsSerialised(p)).toBe(false);
    expect(git(p.workspace, 'log', '--format=%an|%s')).toBe(
      'GalacticAgents|GalacticAgents: initialise workspace',
    );
    expect(git(p.workspace, 'ls-tree', 'HEAD')).toBe('');
    expect(readFileSync(join(p.workspace, '.git', 'info', 'exclude'), 'utf8')).toContain(
      '.galactic/',
    );
    expect(existsSync(join(p.workspace, '.gitignore'))).toBe(false);
    const updated = w.seen.filter((e) => e.event.type === 'project.updated');
    expect(updated).toHaveLength(1);
  });

  it('leaves an existing non-git folder alone and serialises its Stewards', async () => {
    const dir = join(tmp, 'home', 'notes folder');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    const { project: p, info } = await project('Notes', dir);
    expect(info).toMatchObject({ git: false, serialStewards: true, created: false });
    expect(info.reason).toMatch(/not a git repository/);
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(stewardsSerialised(p)).toBe(true);
    const t = await task(p.id, 'Tidy the notes');
    await expect(spaces.createWorktree(t.id)).rejects.toThrow(/one at a time/);
  });

  it('initialises an existing non-git folder when asked, with a snapshot commit', async () => {
    const dir = join(tmp, 'home', 'notes folder');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    const { project: p, info } = await project('Notes', dir, true);
    expect(info).toMatchObject({ git: true, initialised: true, serialStewards: false });
    expect(git(dir, 'ls-tree', '--name-only', 'HEAD')).toBe('notes.txt');
    expect(stewardsSerialised(p)).toBe(false);
  });

  it('keeps an existing repository as it is and uses its checked-out branch as the base', async () => {
    const dir = join(tmp, 'home', 'repo');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'trunk');
    commitFile(dir, 'README.md', 'hello\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    const { info } = await project('Repo', dir);
    expect(info).toMatchObject({ git: true, baseBranch: 'trunk', serialStewards: false });
    expect(info.initialised).toBeUndefined();
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('serialises a repository without a commit unless asked to make the first one', async () => {
    const dir = join(tmp, 'home', 'unborn');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'staged.txt'), 'x');
    git(dir, 'add', 'staged.txt');
    expect((await spaces.prepare({ name: 'u', path: dir })).serialStewards).toBe(true);
    const info = await spaces.prepare({ name: 'u', path: dir, initGit: true });
    expect(info.serialStewards).toBe(false);
    // The root commit is empty and the user's staged file is still staged, not committed.
    expect(git(dir, 'ls-tree', 'HEAD')).toBe('');
    expect(git(dir, 'diff', '--cached', '--name-only')).toBe('staged.txt');
  });

  it('counts a project that was never prepared as serialised', async () => {
    const p = (await commands.createProject({ name: 'raw', workspace: '/w' })).value;
    expect(stewardsSerialised(p)).toBe(true);
  });
});

describe('worktrees and merges', () => {
  it('two worktrees; one clean merge, one conflicting merge reported and aborted', async () => {
    const dir = join(tmp, 'home', 'my project');
    const { project: p, info } = await project('My project', dir);
    const base = info.baseBranch!;
    commitFile(dir, 'shared.txt', 'line one\n', 'base content');

    const a = await task(p.id, 'Change the line one way');
    const b = await task(p.id, 'Change the line the other way');
    const wa = await spaces.createWorktree(a.id);
    const wb = await spaces.createWorktree(b.id);
    expect(wa.path).toBe(join(dir, '.galactic', 'worktrees', a.id));
    expect(wa.branch).toBe(branchName(a));
    expect(wb.baseBranch).toBe(base);
    expect(w.tables.tasks.get(a.id)).toMatchObject({ worktreePath: wa.path, branch: wa.branch });
    const recorded = w.seen
      .map((e) => e.event)
      .filter((e) => e.type === 'task.updated' && e.taskId === a.id);
    expect(recorded[0]).toMatchObject({ changes: { worktreePath: wa.path, branch: wa.branch } });
    // Idempotent: a second call finds the worktree and records nothing new.
    const before = w.seen.length;
    expect(await spaces.createWorktree(a.id)).toEqual(wa);
    expect(w.seen.length).toBe(before);
    // The worktrees do not show up in the workspace's status.
    expect(git(dir, 'status', '--porcelain')).toBe('');

    commitFile(wa.path, 'shared.txt', 'line one, as A wants it\n');
    commitFile(wb.path, 'shared.txt', 'line one, as B wants it\n');

    const merged = await spaces.mergeTask(a.id);
    expect(merged).toMatchObject({
      ok: true,
      fastForward: true,
      nothingToMerge: false,
      branchDeleted: true,
    });
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('line one, as A wants it\n');
    expect(existsSync(wa.path)).toBe(false);
    expect(git(dir, 'branch', '--list', wa.branch)).toBe('');
    expect(w.tables.tasks.get(a.id)!.meta).toMatchObject({
      worktree: { removed: true },
      merge: { fastForward: true },
    });

    const head = git(dir, 'rev-parse', 'HEAD');
    const conflict = await spaces.mergeTask(b.id);
    expect(conflict).toEqual({
      ok: false,
      reason: 'conflict',
      conflict: {
        taskId: b.id,
        projectId: p.id,
        sourceBranch: wb.branch,
        targetBranch: base,
        files: ['shared.txt'],
        workspace: dir,
        worktreePath: wb.path,
      },
    });
    // Aborted cleanly: same head, no merge in progress, nothing changed, worktree and branch kept.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(existsSync(wb.path)).toBe(true);
    expect(git(dir, 'branch', '--list', wb.branch)).toContain(wb.branch);
  });

  it('merges a branch that diverged from the base with a merge commit', async () => {
    const dir = join(tmp, 'home', 'diverged');
    const { project: p } = await project('Diverged', dir);
    const a = await task(p.id, 'Write a');
    const c = await task(p.id, 'Write c');
    const wa = await spaces.createWorktree(a.id);
    const wc = await spaces.createWorktree(c.id);
    commitFile(wa.path, 'a.txt', 'a\n');
    commitFile(wc.path, 'c.txt', 'c\n');
    expect(await spaces.mergeTask(a.id)).toMatchObject({ ok: true, fastForward: true });
    const merged = await spaces.mergeTask(c.id);
    expect(merged).toMatchObject({ ok: true, fastForward: false });
    expect(git(dir, 'log', '-1', '--format=%s')).toBe(`Merge ${wc.branch} (${c.id})`);
    expect(git(dir, 'ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'c.txt',
    ]);
  });

  it('refuses uncommitted work in the worktree unless asked to commit it', async () => {
    const dir = join(tmp, 'home', 'pending');
    const { project: p } = await project('Pending', dir);
    const a = await task(p.id, 'Leave work uncommitted');
    const wa = await spaces.createWorktree(a.id);
    writeFileSync(join(wa.path, 'new file.txt'), 'draft\n');
    expect(await spaces.mergeTask(a.id)).toMatchObject({
      ok: false,
      reason: 'worktree_dirty',
      files: ['new file.txt'],
    });
    expect(await spaces.mergeTask(a.id, { commitPending: true })).toMatchObject({ ok: true });
    expect(readFileSync(join(dir, 'new file.txt'), 'utf8')).toBe('draft\n');
  });

  it('refuses to merge into a workspace that is off its base branch or has tracked changes', async () => {
    const dir = join(tmp, 'home', 'busy');
    const { project: p, info } = await project('Busy', dir);
    commitFile(dir, 'f.txt', 'one\n');
    const a = await task(p.id, 'Edit g');
    const wa = await spaces.createWorktree(a.id);
    commitFile(wa.path, 'g.txt', 'g\n');
    writeFileSync(join(dir, 'f.txt'), 'two\n');
    expect(await spaces.mergeTask(a.id)).toMatchObject({
      ok: false,
      reason: 'workspace_dirty',
      files: ['f.txt'],
    });
    git(dir, 'checkout', '-q', '--', 'f.txt');
    git(dir, 'checkout', '-q', '-b', 'elsewhere');
    expect(await spaces.mergeTask(a.id)).toMatchObject({ ok: false, reason: 'not_on_base_branch' });
    git(dir, 'checkout', '-q', info.baseBranch!);
    expect(await spaces.mergeTask(a.id)).toMatchObject({ ok: true });
  });

  it('serialises concurrent merges on one repository', async () => {
    const dir = join(tmp, 'home', 'parallel');
    const { project: p } = await project('Parallel', dir);
    const tasks = await Promise.all(['one', 'two', 'three'].map((d) => task(p.id, `Write ${d}`)));
    const trees = [];
    for (const t of tasks) trees.push(await spaces.createWorktree(t.id));
    trees.forEach((wt, i) => commitFile(wt.path, `${i}.txt`, `${i}\n`));
    const results = await Promise.all(tasks.map((t) => spaces.mergeTask(t.id)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(git(dir, 'ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual([
      '0.txt',
      '1.txt',
      '2.txt',
    ]);
  });

  it('removes a worktree without merging, refusing uncommitted work unless forced', async () => {
    const dir = join(tmp, 'home', 'cancel');
    const { project: p } = await project('Cancel', dir);
    const a = await task(p.id, 'Abandoned work');
    const wa = await spaces.createWorktree(a.id);
    writeFileSync(join(wa.path, 'x.txt'), 'x');
    expect(await spaces.removeWorktree(a.id)).toEqual({ removed: false, files: ['x.txt'] });
    expect(await spaces.removeWorktree(a.id, { force: true, deleteBranch: true })).toEqual({
      removed: true,
    });
    expect(existsSync(wa.path)).toBe(false);
    expect(git(dir, 'branch', '--list', wa.branch)).toBe('');
  });

  it('works in a sub-folder of a repository: the Steward gets the same sub-folder', async () => {
    const repo = join(tmp, 'home', 'mono repo');
    mkdirSync(join(repo, 'packages', 'cli'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    commitFile(join(repo, 'packages', 'cli'), 'index.ts', 'export {};\n');
    const sub = join(repo, 'packages', 'cli');
    const { project: p, info } = await project('CLI', sub);
    expect(info).toMatchObject({ repoRoot: repo, baseBranch: 'main' });
    expect(p.repoPath).toBe(repo);
    const a = await task(p.id, 'Edit the cli');
    const wa = await spaces.createWorktree(a.id);
    expect(wa.root).toBe(join(sub, '.galactic', 'worktrees', a.id));
    expect(wa.path).toBe(join(wa.root, 'packages', 'cli'));
    commitFile(wa.path, 'index.ts', 'export const x = 1;\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(await spaces.mergeTask(a.id)).toMatchObject({ ok: true });
    expect(readFileSync(join(sub, 'index.ts'), 'utf8')).toBe('export const x = 1;\n');
  });

  it('never runs the repository’s hooks for server-run git commands', async () => {
    const dir = join(tmp, 'home', 'hooked');
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    commitFile(dir, 'f.txt', 'f\n');
    const marker = join(tmp, 'hook-ran');
    for (const hook of ['post-checkout', 'pre-merge-commit', 'post-merge', 'pre-commit']) {
      const file = join(dir, '.git', 'hooks', hook);
      writeFileSync(file, `#!/bin/sh\necho ${hook} >> "${marker}"\n`);
      chmodSync(file, 0o755);
    }
    const { project: p } = await project('Hooked', dir);
    const a = await task(p.id, 'Hooks stay off');
    const wa = await spaces.createWorktree(a.id);
    writeFileSync(join(wa.path, 'g.txt'), 'g\n');
    commitFile(dir, 'h.txt', 'h\n'); // a Steward-style commit in the workspace runs pre-commit
    rmSync(marker, { force: true });
    expect(await spaces.mergeTask(a.id, { commitPending: true })).toMatchObject({
      ok: true,
      fastForward: false,
    });
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses worktrees for a standalone task', async () => {
    const t = (await commands.createTask({ description: 'An asteroid' })).value;
    await expect(spaces.createWorktree(t.id)).rejects.toThrow(/standalone/);
  });

  it('never hands git a stored branch or path it did not make (wave-2 review)', async () => {
    const { project: p } = await project('Planted values');
    const t = await task(p.id, 'Planted');
    await spaces.createWorktree(t.id);
    for (const branch of ['--upload-pack=touch /tmp/x', 'main', 'galactic/../main']) {
      await commands.updateTask(t.id, { branch });
      await expect(spaces.mergeTask(t.id)).rejects.toThrow(/not a galactic\/ branch/);
    }
    const stored = w.tables.tasks.get(t.id)!.meta?.['worktree'] as Record<string, unknown>;
    await commands.updateTask(t.id, {
      branch: branchName(t),
      meta: { worktree: { ...stored, root: '/etc' } },
    });
    // The stored root is ignored: the worktree is found where the server made it.
    const merged = await spaces.mergeTask(t.id);
    expect(merged).toMatchObject({ ok: true });
  });
});
