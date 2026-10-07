import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Agent, Id, Project, Task } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { gitRunner } from '../workspace/git.js';
import type { CopySkip } from './copies.js';
import { DeliverableService } from './service.js';

/**
 * B1 of the wave-2 review (TECHNOLOGY §9.4): a copy never goes through a symlink, in any
 * component, and applies decision 122's rules to every entry it copies — not only to the path
 * that was declared. The race it closes: a Steward declares `x/Documents/` (a real folder), then
 * replaces `x` with a symlink to the home folder and commits; at the merge the old copy followed
 * the parent and copied the real `~/Documents` into the project.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 100 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

/** Every file under `dir`, relative, sorted. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(at, e.name));
      else out.push(relative(dir, join(at, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

let tmp: string;
let home: string;
let composed: ComposedRuntime;
let project: Project;
let task: Task;
let tree: string;
let steward: Agent;

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-copy-swap-')));
  for (const d of ['home/Documents', 'data', 'projects/app', 'strays']) {
    mkdirSync(join(tmp, d), { recursive: true });
  }
  home = join(tmp, 'home');
  writeFileSync(join(home, 'Documents', 'private.txt'), 'SECRET-OUTSIDE');
  writeFileSync(join(home, 'Documents', 'notes.txt'), 'SECRET-NOTES');
  composed = composeRuntime(openDatabase(':memory:'), {
    workspaces: {
      projectsRoot: join(tmp, 'projects'),
      dataDir: join(tmp, 'data'),
      home,
      git: gitRunner({ env: GIT_ENV }),
    },
    detection: false,
    deliverables: { tmpDirs: [join(tmp, 'strays')], freeBytes: () => 2 ** 40 },
  });
  const ws = join(tmp, 'projects', 'app');
  writeFileSync(join(ws, 'a.txt'), 'x');
  writeFileSync(join(ws, '.gitignore'), 'dist/\n');
  project = (await composed.commands.createProject({ name: 'App', workspace: ws })).value;
  await composed.workspaces!.prepareProject(project.id, { initGit: true });
  task = (await composed.commands.createTask({ projectId: project.id, description: 'Swap' })).value;
  tree = (await composed.workspaces!.createWorktree(task.id)).path;
  steward = composed.log.runCommand((ctx) =>
    createAgent(ctx, {
      role: 'steward',
      runtime: 'fake',
      caps: CAPS,
      projectId: project.id,
      taskId: task.id,
      meta: { cwd: tree },
    }),
  ).value;
});
afterEach(async () => {
  await composed.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

const row = (id: Id) => composed.log.tables.deliverables.get(id)!;
const folder = () => join(project.workspace, 'deliverables');

describe('a copy never follows a symlink (B1)', () => {
  it('refuses a declared folder whose parent became a symlink to home before the merge', async () => {
    mkdirSync(join(tree, 'x', 'Documents'), { recursive: true });
    writeFileSync(join(tree, 'x', 'Documents', 'ok.txt'), 'fine');
    const d = (
      await composed.deliverables!.declare(
        steward.id,
        {},
        { kind: 'folder', title: 'Docs', path: 'x/Documents' },
        { cwd: tree },
      )
    ).deliverable;
    expect(d.location).toMatchObject({ storage: 'worktree' });

    rmSync(join(tree, 'x'), { recursive: true });
    symlinkSync(home, join(tree, 'x'));
    git(tree, 'add', '-A');
    git(tree, 'commit', '-qm', 'link');
    expect((await composed.workspaces!.mergeTask(task.id)).ok).toBe(true);

    const after = row(d.id).location!;
    expect(after.storage).toBe('worktree');
    expect(after.missing?.reason).toMatch(/outside|changed/);
    // Nothing of the home folder was copied anywhere into the project.
    expect(filesUnder(folder())).toEqual([]);
    expect(filesUnder(project.workspace).filter((f) => f.includes('private.txt'))).toEqual([]);
  });

  it('refuses a declared file whose parent became a symlink before the merge', async () => {
    mkdirSync(join(tree, 'y'), { recursive: true });
    writeFileSync(join(tree, 'y', 'notes.txt'), 'mine');
    const d = (
      await composed.deliverables!.declare(
        steward.id,
        {},
        { kind: 'file', title: 'Notes', path: 'y/notes.txt' },
        { cwd: tree },
      )
    ).deliverable;
    rmSync(join(tree, 'y'), { recursive: true });
    symlinkSync(join(home, 'Documents'), join(tree, 'y'));
    git(tree, 'add', '-A');
    git(tree, 'commit', '-qm', 'link');
    expect((await composed.workspaces!.mergeTask(task.id)).ok).toBe(true);

    expect(row(d.id).location?.missing?.reason).toMatch(/outside|changed/);
    expect(filesUnder(folder())).toEqual([]);
  });

  it("leaves secrets, hard links and links out of an agent's folder, and lists them", async () => {
    const dist = join(tree, 'dist');
    mkdirSync(join(dist, 'sub', '.ssh'), { recursive: true });
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    writeFileSync(join(dist, '.env'), 'TOKEN=1');
    writeFileSync(join(dist, 'server.pem'), 'key');
    writeFileSync(join(dist, 'sub', 'id_rsa'), 'key');
    writeFileSync(join(dist, 'sub', '.ssh', 'config'), 'Host *');
    writeFileSync(join(dist, 'sub', 'page.html'), '<p>');
    linkSync(join(home, 'Documents', 'private.txt'), join(dist, 'linked.txt'));
    symlinkSync(join(home, 'Documents'), join(dist, 'docs'));
    const d = (
      await composed.deliverables!.declare(
        steward.id,
        {},
        { kind: 'folder', title: 'Build', path: 'dist' },
        { cwd: tree },
      )
    ).deliverable;
    writeFileSync(join(tree, 'b.txt'), 'b');
    git(tree, 'add', 'b.txt');
    git(tree, 'commit', '-qm', 'b');
    expect((await composed.workspaces!.mergeTask(task.id)).ok).toBe(true);

    const after = row(d.id);
    expect(after.location?.storage).toBe('copy');
    expect(filesUnder(after.location!.path)).toEqual(['app.js', 'sub/page.html']);
    const copy = after.meta?.['copy'] as { skipped: CopySkip[]; skippedCount: number };
    expect(copy.skippedCount).toBe(6);
    expect([...copy.skipped].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: '.env', reason: 'secret' },
      { path: 'docs', reason: 'symlink' },
      { path: 'linked.txt', reason: 'hard_link' },
      { path: 'server.pem', reason: 'secret' },
      { path: 'sub/.ssh', reason: 'secret' },
      { path: 'sub/id_rsa', reason: 'secret' },
    ]);
  });

  it('re-checks a stray right before the copy: a folder swapped for a link is refused', async () => {
    const stray = join(tmp, 'strays', 'out');
    mkdirSync(stray);
    writeFileSync(join(stray, 'chart.svg'), '<svg/>');
    const real = composed.deliverableCopies!;
    // The race: the stray is checked at the declaration, then replaced before the copy.
    const racing = new DeliverableService({
      commands: composed.commands,
      tables: composed.log.tables,
      dataDir: join(tmp, 'data'),
      home,
      tmpDirs: [join(tmp, 'strays')],
      copies: {
        copyIn: (source, target, rules) => {
          rmSync(stray, { recursive: true });
          symlinkSync(join(home, 'Documents'), stray);
          return real.copyIn(source, target, rules);
        },
      },
    });
    await expect(
      racing.declare(steward.id, {}, { kind: 'folder', title: 'Out', path: stray }),
    ).rejects.toThrow(/symlink/);
    expect(filesUnder(folder())).toEqual([]);
    expect(composed.log.tables.deliverables.of({ taskId: task.id })).toEqual([]);
  });

  it("leaves a stray folder's entries the agent did not make (born before its session) out", async () => {
    const stray = join(tmp, 'strays', 'made');
    mkdirSync(stray);
    writeFileSync(join(stray, 'new.txt'), 'made now');
    writeFileSync(join(stray, 'old.txt'), 'older than the Steward');
    // On macOS a modification time before the birth time moves the birth time back.
    const old = new Date(Date.parse(steward.createdAt) - 3_600_000);
    utimesSync(join(stray, 'old.txt'), old, old);
    const { deliverable } = await composed.deliverables!.declare(
      steward.id,
      {},
      { kind: 'folder', title: 'Made', path: stray },
    );
    expect(deliverable.location?.storage).toBe('copy');
    expect(filesUnder(deliverable.location!.path)).toEqual(['new.txt']);
    expect(deliverable.meta?.['copy']).toMatchObject({
      skipped: [{ path: 'old.txt', reason: 'stray_refused' }],
      skippedCount: 1,
    });
    expect(readFileSync(join(deliverable.location!.path, 'new.txt'), 'utf8')).toBe('made now');
  });
});
