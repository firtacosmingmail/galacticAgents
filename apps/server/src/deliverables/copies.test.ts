import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Deliverable, DeliverableLocation, Id } from '@galactic/protocol';
import { createAgent } from '../domain/agents.js';
import { Commands } from '../domain/commands.js';
import { DomainError } from '../domain/errors.js';
import { world } from '../test/world.js';
import { gitRunner } from '../workspace/git.js';
import { Workspaces } from '../workspace/workspaces.js';
import { DeliverableCopies, copiedMode, excludePattern, freeName } from './copies.js';

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const USER: Actor = { type: 'user' };
const LOCAL = { origin: 'local' } as const;
const GiB = 2 ** 30;
/** The user's addition from outside the project (the rules `copyIn` re-checks with). */
const OUT = { outside: true } as const;

let tmp: string;
let w: ReturnType<typeof world>;
let commands: Commands;
let spaces: Workspaces;
let copies: DeliverableCopies;
let free: number;
let told: { agentId: Id; text: string }[];
let errors: unknown[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test Steward', '-c', 'user.email=steward@test', ...args],
    { cwd, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' },
  ).trim();
}

function commitFile(cwd: string, file: string, text: string): void {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', `edit ${file}`);
}

/** A stray the agent made outside the project (a temporary folder). */
function stray(name: string, text = 'made by the agent'): string {
  const dir = join(tmp, 'outside');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-copies-')));
  mkdirSync(join(tmp, 'home'));
  mkdirSync(join(tmp, 'data'));
  w = world();
  commands = new Commands({ log: w.log });
  free = 100 * GiB;
  told = [];
  errors = [];
  const gitRun = gitRunner({ env: GIT_ENV });
  spaces = new Workspaces({
    projectsRoot: join(tmp, 'projects'),
    dataDir: join(tmp, 'data'),
    home: join(tmp, 'home'),
    git: gitRun,
    commands,
    tables: w.tables,
    onError: (e) => errors.push(e),
  });
  copies = new DeliverableCopies({
    tables: w.tables,
    commands,
    dataDir: join(tmp, 'data'),
    home: join(tmp, 'home'),
    git: gitRun,
    freeBytes: () => free,
    notify: (agentId, text) => told.push({ agentId, text }),
    onError: (e) => errors.push(e),
  });
  spaces.setBeforeWorktreeRemoved((taskId, root, info) =>
    copies.beforeWorktreeRemoved(taskId, root, info),
  );
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

async function project(name: string, opts: { workspace?: string; initGit?: boolean } = {}) {
  const created = await commands.createProject({
    name,
    workspace: opts.workspace ?? spaces.suggestPath(name),
  });
  await spaces.prepareProject(created.value.id, { initGit: opts.initGit ?? false });
  return w.tables.projects.get(created.value.id)!;
}

async function task(projectId: string, description: string) {
  return (await commands.createTask({ projectId, description })).value;
}

async function declare(
  taskId: Id,
  path: string,
  kind: Deliverable['kind'] = 'file',
  storage: DeliverableLocation['storage'] = 'worktree',
) {
  return (
    await commands.addDeliverable(
      {
        taskId,
        kind,
        title: `the ${kind}`,
        source: 'user',
        location: { storage, path: realpathSync(path) },
      },
      USER,
      LOCAL,
    )
  ).value;
}

const row = (id: Id) => w.tables.deliverables.get(id)!;
const status = (cwd: string) => git(cwd, 'status', '--porcelain');

describe('the deliverables folder (P9-06, decision 122)', () => {
  it('is made on first need inside the project, 0700, excluded locally, and recorded', async () => {
    const p = await project('Report');
    expect(existsSync(join(p.workspace, 'deliverables'))).toBe(false);
    const tracked = git(p.workspace, 'ls-files');
    const out = await copies.copyIn(stray('report.pdf'), { projectId: p.id }, OUT);

    const folder = join(p.workspace, 'deliverables');
    expect(out).toMatchObject({
      folder,
      location: {
        storage: 'copy',
        path: join(folder, 'report.pdf'),
        originalPath: join(tmp, 'outside', 'report.pdf'),
      },
      bytes: 'made by the agent'.length,
    });
    expect(readFileSync(join(folder, 'report.pdf'), 'utf8')).toBe('made by the agent');
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    // Recorded on the project: a rename never moves it.
    expect(w.tables.projects.get(p.id)!.meta?.['deliverablesFolder']).toBe(folder);
    await commands.updateProject(p.id, { name: 'Renamed report' });
    expect((await copies.placeOf({ projectId: p.id })).folder).toBe(folder);
    // Out of git on this Mac only: info/exclude, nothing tracked changed, the checkout clean.
    const exclude = readFileSync(join(p.workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toContain('/deliverables/');
    expect(existsSync(join(p.workspace, '.gitignore'))).toBe(false);
    expect(git(p.workspace, 'ls-files')).toBe(tracked);
    expect(status(p.workspace)).toBe('');
    // A second copy does not add the line again.
    await copies.copyIn(stray('other.txt'), { projectId: p.id }, OUT);
    expect(
      readFileSync(join(p.workspace, '.git', 'info', 'exclude'), 'utf8')
        .split('\n')
        .filter((l) => l === '/deliverables/'),
    ).toHaveLength(1);
  });

  it("puts a task's copies in its own subfolder, the id suffix on a clash", async () => {
    const p = await project('Two tasks');
    const a = await task(p.id, 'Render the chart');
    const b = await task(p.id, 'Render the chart');
    const first = await copies.copyIn(stray('chart.png'), { taskId: a.id }, OUT);
    await commands.addDeliverable(
      { taskId: a.id, kind: 'image', title: 'chart', source: 'user', location: first.location },
      USER,
      LOCAL,
    );
    expect(first.location.path).toBe(
      join(p.workspace, 'deliverables', 'render-the-chart', 'chart.png'),
    );
    const second = await copies.copyIn(stray('chart.png'), { taskId: b.id }, OUT);
    expect(second.location.path).toBe(
      join(p.workspace, 'deliverables', `render-the-chart-${b.id.slice(0, 6)}`, 'chart.png'),
    );
    // The first task's next copy goes back to its own subfolder, under a free name.
    const again = await copies.copyIn(stray('chart.png'), { taskId: a.id }, OUT);
    expect(again.location.path).toBe(
      join(p.workspace, 'deliverables', 'render-the-chart', 'chart (2).png'),
    );
  });

  it('is galactic-deliverables/ when the repository tracks a deliverables/ folder', async () => {
    const p = await project('Tracked');
    commitFile(p.workspace, 'deliverables/spec.md', '# the project’s own');
    const out = await copies.copyIn(stray('a.txt'), { projectId: p.id }, OUT);
    expect(out.folder).toBe(join(p.workspace, 'galactic-deliverables'));
    const exclude = readFileSync(join(p.workspace, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toContain('/galactic-deliverables/');
    expect(exclude.split('\n')).not.toContain('/deliverables/');
    expect(status(p.workspace)).toBe('');
    expect(readFileSync(join(p.workspace, 'deliverables', 'spec.md'), 'utf8')).toBe(
      '# the project’s own',
    );
  });

  it('excludes the folder relative to the repository root for a sub-folder workspace', async () => {
    const repo = join(tmp, 'mono');
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    git(repo, 'init', '-q');
    commitFile(repo, 'apps/web/index.ts', 'x');
    const p = await project('Web', { workspace: join(repo, 'apps', 'web') });
    await copies.copyIn(stray('a.txt'), { projectId: p.id }, OUT);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude.split('\n')).toContain('/apps/web/deliverables/');
    expect(status(repo)).toBe('');
  });

  it('works in a folder that is not a repository, with no exclude', async () => {
    const folder = join(tmp, 'plain');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), 'mine');
    const p = await project('Plain', { workspace: folder });
    const out = await copies.copyIn(stray('a.txt'), { projectId: p.id }, OUT);
    expect(out.location.path).toBe(join(folder, 'deliverables', 'a.txt'));
    expect(existsSync(join(folder, '.git'))).toBe(false);
  });

  it("uses a scratch task's own workspace, or the related project's folder", async () => {
    const scratch = join(tmp, 'projects', 'scratch', 'one-off');
    mkdirSync(scratch, { recursive: true });
    const solo = (
      await commands.createTask({ description: 'One-off', meta: { workspace: scratch } })
    ).value;
    const out = await copies.copyIn(stray('a.txt'), { taskId: solo.id }, OUT);
    expect(out.location.path).toBe(join(scratch, 'deliverables', 'a.txt'));
    expect(w.tables.tasks.get(solo.id)!.meta?.['deliverablesFolder']).toBe(
      join(scratch, 'deliverables'),
    );

    const p = await project('Related');
    const fix = (
      await commands.createTask({
        description: 'Quick fix',
        meta: { workspace: p.workspace, relatedProjectId: p.id },
      })
    ).value;
    const related = await copies.copyIn(stray('b.txt'), { taskId: fix.id }, OUT);
    expect(related.location.path).toBe(join(p.workspace, 'deliverables', 'quick-fix', 'b.txt'));
    expect(w.tables.projects.get(p.id)!.meta?.['deliverablesFolder']).toBe(
      join(p.workspace, 'deliverables'),
    );
  });

  it('refuses a deliverables folder that is a symlink or a file', async () => {
    const p = await project('Linked');
    mkdirSync(join(tmp, 'elsewhere'));
    symlinkSync(join(tmp, 'elsewhere'), join(p.workspace, 'deliverables'));
    await expect(copies.copyIn(stray('a.txt'), { projectId: p.id }, OUT)).rejects.toThrow(
      /symlink/,
    );
    expect(readdirSync(join(tmp, 'elsewhere'))).toEqual([]);

    const q = await project('Filed');
    writeFileSync(join(q.workspace, 'deliverables'), 'a file');
    await expect(copies.copyIn(stray('a.txt'), { projectId: q.id }, OUT)).rejects.toThrow(
      /not a folder/,
    );
    expect(w.tables.projects.get(q.id)!.meta?.['deliverablesFolder']).toBeUndefined();
  });
});

describe('copies (P9-06)', () => {
  it('copies a folder without links or special files, modes kept minus write and set-uid', async () => {
    const p = await project('Modes');
    const src = join(tmp, 'outside', 'build');
    mkdirSync(join(src, 'bin'), { recursive: true });
    writeFileSync(join(src, 'bin', 'tool'), '#!/bin/sh\necho hi\n');
    chmodSync(join(src, 'bin', 'tool'), 0o4777);
    writeFileSync(join(src, 'readme.txt'), 'read me');
    chmodSync(join(src, 'readme.txt'), 0o666);
    writeFileSync(join(tmp, 'secret'), 'not to copy');
    symlinkSync(join(tmp, 'secret'), join(src, 'link'));
    symlinkSync(join(tmp, 'home'), join(src, 'dirlink'));
    execFileSync('mkfifo', [join(src, 'fifo')]);

    const out = await copies.copyIn(src, { projectId: p.id }, OUT);
    const dst = join(p.workspace, 'deliverables', 'build');
    expect(out.location.path).toBe(dst);
    expect(readdirSync(dst).sort()).toEqual(['bin', 'readme.txt']);
    expect(lstatSync(join(dst, 'bin', 'tool')).mode & 0o7777).toBe(0o755);
    expect(lstatSync(join(dst, 'readme.txt')).mode & 0o7777).toBe(0o644);
    expect(out.bytes).toBe('#!/bin/sh\necho hi\n'.length + 'read me'.length);
    // No partial copy is left beside it.
    expect(readdirSync(join(p.workspace, 'deliverables'))).toEqual(['build']);
  });

  it('writes info/exclude patterns with glob characters escaped, appended, never rewritten', async () => {
    expect(excludePattern('deliverables')).toBe('/deliverables/');
    expect(excludePattern('a[1]/b*?c\\d/deliverables')).toBe(
      '/a\\[1\\]/b\\*\\?c\\\\d/deliverables/',
    );
    expect(excludePattern('trailing ')).toBe('/trailing\\ /');
    expect(() => excludePattern('two\nlines')).toThrow(/line break/);

    const p = await project('Excluded');
    const file = join(p.workspace, '.git', 'info', 'exclude');
    writeFileSync(file, '# mine\n*.log');
    await Promise.all([
      copies.copyIn(stray('a.txt'), { projectId: p.id }, OUT),
      copies.copyIn(stray('b.txt'), { projectId: p.id }, OUT),
    ]);
    const lines = readFileSync(file, 'utf8').split('\n');
    expect(lines.slice(0, 2)).toEqual(['# mine', '*.log']);
    expect(lines.filter((l) => l === '/deliverables/')).toHaveLength(1);
  });

  it('names a taken name (2), (3), and never replaces what is there', async () => {
    const dir = join(tmp, 'names');
    mkdirSync(dir);
    expect(await freeName(dir, 'a.txt')).toBe('a.txt');
    writeFileSync(join(dir, 'a.txt'), '');
    writeFileSync(join(dir, 'a (2).txt'), '');
    expect(await freeName(dir, 'a.txt')).toBe('a (3).txt');
    mkdirSync(join(dir, 'out'));
    expect(await freeName(dir, 'out')).toBe('out (2)');
    expect(await freeName(dir, '.env')).toBe('.env');
    writeFileSync(join(dir, '.env'), '');
    expect(await freeName(dir, '.env')).toBe('.env (2)');
    expect(copiedMode(0o104777, false)).toBe(0o755);
    expect(copiedMode(0o40000, true)).toBe(0o700);
    expect(copiedMode(0o100200, false)).toBe(0o600);
  });

  it('refuses a copy that would leave less than the reserve free, saying both sizes', async () => {
    const p = await project('Full disk');
    free = GiB + 10;
    const src = stray('big.bin', 'x'.repeat(100));
    const refused = await copies.copyIn(src, { projectId: p.id }, OUT).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DomainError);
    expect((refused as DomainError).message).toMatch(
      /^not enough space: needs 1 GiB, 1 GiB free \(100 bytes to copy, 1 GiB kept free\)$/,
    );
    expect(readdirSync(join(p.workspace, 'deliverables'))).toEqual([]);
  });

  it("reports each recorded folder's size (GET /api/deliverables/usage)", async () => {
    const p = await project('Usage');
    expect(await copies.usage()).toEqual({ folders: [] });
    await copies.copyIn(stray('a.txt', '12345'), { projectId: p.id }, OUT);
    expect(await copies.usage()).toEqual({
      folders: [{ projectId: p.id, path: join(p.workspace, 'deliverables'), bytes: 5 }],
    });
  });

  it('refuses a symlink as the source and a folder of too many entries', async () => {
    const p = await project('Refusals');
    const link = join(tmp, 'outside', 'link');
    stray('target.txt');
    symlinkSync(join(tmp, 'outside', 'target.txt'), link);
    await expect(copies.copyIn(link, { projectId: p.id }, OUT)).rejects.toThrow(/symlink/);

    const few = new DeliverableCopies({
      tables: w.tables,
      commands,
      dataDir: join(tmp, 'data'),
      git: gitRunner({ env: GIT_ENV }),
      freeBytes: () => free,
      maxEntries: 3,
    });
    const many = join(tmp, 'outside', 'many');
    mkdirSync(many);
    for (const n of [1, 2, 3, 4]) writeFileSync(join(many, `${n}`), '');
    await expect(few.copyIn(many, { projectId: p.id }, OUT)).rejects.toThrow(/too many files/);
  });
});

describe('the merge hook (P9-06, decision 123)', () => {
  async function steward(projectId: Id, taskId: Id) {
    const caps = { maxWallClockMs: 1000, maxToolCalls: 10 };
    const waykeeper = w.run((ctx) =>
      createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps, projectId }),
    ).value;
    w.run((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps,
        projectId,
        taskId,
        supervisorId: waykeeper.id,
      }),
    );
    return waykeeper;
  }

  async function setup(description = 'Build the report') {
    const p = await project('Reports');
    commitFile(p.workspace, '.gitignore', 'dist/\n');
    const t = await task(p.id, description);
    const wt = await spaces.createWorktree(t.id);
    const waykeeper = await steward(p.id, t.id);
    return { p, t, wt, waykeeper };
  }

  it('re-points a committed file into the project and copies an ignored build output', async () => {
    const { p, t, wt } = await setup();
    commitFile(wt.path, 'docs/report.md', '# report');
    mkdirSync(join(wt.path, 'dist'));
    writeFileSync(join(wt.path, 'dist', 'app.bin'), 'built');
    const committed = await declare(t.id, join(wt.path, 'docs', 'report.md'));
    const built = await declare(t.id, join(wt.path, 'dist', 'app.bin'));
    const tracked = git(p.workspace, 'ls-files');

    const merged = await spaces.mergeTask(t.id);
    expect(merged.ok).toBe(true);
    expect(existsSync(wt.root)).toBe(false);

    expect(row(committed.id).location).toEqual({
      storage: 'in_place',
      path: join(p.workspace, 'docs', 'report.md'),
    });
    const copied = join(p.workspace, 'deliverables', 'build-the-report', 'app.bin');
    expect(row(built.id).location).toEqual({
      storage: 'copy',
      path: copied,
      originalPath: join(wt.root, 'dist', 'app.bin'),
    });
    expect(row(built.id).meta).toMatchObject({ copy: { bytes: 5 } });
    expect(readFileSync(copied, 'utf8')).toBe('built');
    // Out of git: the checkout is clean and the next merge is not refused as dirty.
    expect(status(p.workspace)).toBe('');
    const tracked2 = git(p.workspace, 'ls-files').split('\n');
    expect(tracked2.filter((f) => !tracked.split('\n').includes(f))).toEqual(['docs/report.md']);
    const next = await task(p.id, 'Second');
    const wt2 = await spaces.createWorktree(next.id);
    commitFile(wt2.path, 'b.txt', 'b');
    expect((await spaces.mergeTask(next.id)).ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it('spends at most its copy budget inside the lock; the rest is missing with the reason (review N6)', async () => {
    const budgeted = new DeliverableCopies({
      tables: w.tables,
      commands,
      dataDir: join(tmp, 'data'),
      home: join(tmp, 'home'),
      git: gitRunner({ env: GIT_ENV }),
      freeBytes: () => free,
      notify: (agentId, text) => told.push({ agentId, text }),
      onError: (e) => errors.push(e),
      mergeBudget: { entries: 3, ms: 60_000 },
    });
    spaces.setBeforeWorktreeRemoved((taskId, root, info) =>
      budgeted.beforeWorktreeRemoved(taskId, root, info),
    );
    const { t, wt, waykeeper } = await setup();
    mkdirSync(join(wt.path, 'dist', 'assets'), { recursive: true });
    writeFileSync(join(wt.path, 'dist', 'app.bin'), 'built');
    for (let i = 0; i < 5; i++) writeFileSync(join(wt.path, 'dist', 'assets', `${i}.js`), 'x');
    const file = await declare(t.id, join(wt.path, 'dist', 'app.bin'));
    const folder = await declare(t.id, join(wt.path, 'dist', 'assets'), 'folder');
    expect((await spaces.mergeTask(t.id)).ok).toBe(true);
    expect(row(file.id).location?.storage).toBe('copy');
    expect(row(folder.id).location?.missing?.reason).toMatch(/budget/);
    expect(told.at(-1)).toMatchObject({ agentId: waykeeper.id });
    expect(told.at(-1)!.text).toMatch(/budget/);
  });

  it('re-points a file committed after a refused merge, and a command run in the worktree', async () => {
    const { p, t, wt } = await setup();
    commitFile(wt.path, 'notes.md', 'v1');
    const notes = await declare(t.id, join(wt.path, 'notes.md'));
    const cmd = (
      await commands.addDeliverable(
        {
          taskId: t.id,
          kind: 'command',
          title: 'dev',
          source: 'user',
          command: { line: 'npm run dev', cwd: realpathSync(wt.path) },
        },
        USER,
        LOCAL,
      )
    ).value;
    writeFileSync(join(wt.path, 'notes.md'), 'v2, not committed');
    expect((await spaces.mergeTask(t.id, { commitPending: false })).ok).toBe(false);
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'v2');
    expect((await spaces.mergeTask(t.id)).ok).toBe(true);
    expect(row(notes.id).location).toEqual({
      storage: 'in_place',
      path: join(p.workspace, 'notes.md'),
    });
    expect(row(cmd.id).command).toEqual({ line: 'npm run dev', cwd: p.workspace });
  });

  it('marks a deliverable missing and tells the Waykeeper when the copy is refused', async () => {
    const { p, t, wt, waykeeper } = await setup();
    mkdirSync(join(wt.path, 'dist'));
    writeFileSync(join(wt.path, 'dist', 'huge.bin'), 'x'.repeat(64));
    const huge = await declare(t.id, join(wt.path, 'dist', 'huge.bin'));
    commitFile(wt.path, 'a.txt', 'a');
    free = GiB;

    const merged = await spaces.mergeTask(t.id);
    expect(merged.ok).toBe(true); // a deliverable never holds up a merge
    expect(existsSync(wt.root)).toBe(false);
    const location = row(huge.id).location!;
    expect(location).toMatchObject({
      storage: 'worktree',
      path: join(wt.root, 'dist', 'huge.bin'),
      missing: {
        reason: expect.stringMatching(
          /^it was in the task's worktree: not enough space: needs 1 GiB, 1 GiB free/,
        ),
      },
    });
    expect(told).toHaveLength(1);
    expect(told[0]!.agentId).toBe(waykeeper.id);
    expect(told[0]!.text).toContain('"the file" (dist/huge.bin): not enough space');
    expect(existsSync(join(p.workspace, 'deliverables', 'build-the-report', 'huge.bin'))).toBe(
      false,
    );
  });

  it("copies first when a cancelled task's worktree is removed by force", async () => {
    const { p, t, wt } = await setup();
    writeFileSync(join(wt.path, 'draft.md'), 'uncommitted draft');
    const draft = await declare(t.id, join(wt.path, 'draft.md'));
    expect(await spaces.removeWorktree(t.id)).toMatchObject({ removed: false });
    expect(row(draft.id).location?.storage).toBe('worktree');
    expect(await spaces.removeWorktree(t.id, { force: true })).toEqual({ removed: true });
    const copied = join(p.workspace, 'deliverables', 'build-the-report', 'draft.md');
    expect(row(draft.id).location).toMatchObject({ storage: 'copy', path: copied });
    expect(readFileSync(copied, 'utf8')).toBe('uncommitted draft');
    expect(status(p.workspace)).toBe('');
  });

  it('changes nothing when the merge conflicts', async () => {
    const { p, t, wt } = await setup();
    commitFile(wt.path, 'same.txt', 'theirs');
    commitFile(p.workspace, 'same.txt', 'ours');
    const d = await declare(t.id, join(wt.path, 'same.txt'));
    const before = row(d.id);
    const merged = await spaces.mergeTask(t.id);
    expect(merged).toMatchObject({ ok: false, reason: 'conflict' });
    expect(row(d.id)).toEqual(before);
    expect(existsSync(join(p.workspace, 'deliverables'))).toBe(false);
  });

  it('never fails a merge when the hook throws', async () => {
    const { t, wt } = await setup();
    commitFile(wt.path, 'a.txt', 'a');
    spaces.setBeforeWorktreeRemoved(() => Promise.reject(new Error('boom')));
    const merged = await spaces.mergeTask(t.id);
    expect(merged.ok).toBe(true);
    expect(existsSync(wt.root)).toBe(false);
    expect(errors.map((e) => (e as Error).message)).toEqual(['boom']);
  });

  it('marks a deliverable missing when copying it fails, and goes on with the others', async () => {
    const { t, wt } = await setup();
    mkdirSync(join(wt.path, 'dist'));
    writeFileSync(join(wt.path, 'dist', 'a.bin'), 'a');
    writeFileSync(join(wt.path, 'dist', 'b.bin'), 'b');
    const a = await declare(t.id, join(wt.path, 'dist', 'a.bin'));
    const b = await declare(t.id, join(wt.path, 'dist', 'b.bin'));
    commitFile(wt.path, 'x.txt', 'x');
    // The first copy fails mid-way (the source vanishes under it); the second goes through.
    let calls = 0;
    const original = copies.copyInto.bind(copies);
    copies.copyInto = async (source, dir, ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('EIO: the disk said no');
      return original(source, dir, ctx);
    };
    expect((await spaces.mergeTask(t.id)).ok).toBe(true);
    expect(row(a.id).location?.missing?.reason).toMatch(/EIO: the disk said no/);
    expect(row(b.id).location?.storage).toBe('copy');
  });
});
