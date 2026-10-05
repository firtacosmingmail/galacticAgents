import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainHarness } from '../../brains/testing/index.js';
import { openDatabase, type Database } from '../../db/database.js';
import { bootDrill, drillDirs, GIT_ENV } from './drill-world.js';

/**
 * P8-04, from drill 2 ("reboot"): the power goes while `spawn_steward` is creating a task's git
 * worktree. A `kill -9` of the server alone cannot cut it short (git is its own process and
 * finishes), but a reboot can: git leaves the worktree registered, locked "initializing", with a
 * partial checkout. The next `spawn_steward` for the task must not hand the Steward that
 * half-made checkout (a Steward committing it would delete the files the checkout never wrote).
 */

const roots: string[] = [];
const dbs: Database[] = [];
const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
  for (const db of dbs.splice(0)) db.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  });

describe('a worktree cut short by a reboot (P8-04 drill 2)', () => {
  it('is made again, not handed to the Steward half checked out', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-wt-')));
    roots.push(root);
    const d = drillDirs(root);
    const workspace = join(d.home, 'Repo');
    mkdirSync(workspace, { recursive: true });
    for (const f of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(workspace, f), `${f}\n`);
    git(workspace, ['init', '-q', '-b', 'main']);
    git(workspace, ['add', '-A']);
    git(workspace, [
      '-c',
      'user.email=d@example.com',
      '-c',
      'user.name=Drill',
      'commit',
      '-qm',
      'init',
    ]);

    const db = openDatabase(':memory:');
    dbs.push(db);
    const h = bootDrill(d, db);
    lives.push(h);
    const project = (await h.commands.createProject({ name: 'Repo', workspace })).value;
    await h.composed.workspaces!.prepareProject(project.id);
    const task = (await h.commands.createTask({ description: 'edit b', projectId: project.id }))
      .value;
    const first = await h.composed.workspaces!.createWorktree(task.id);

    // What git leaves when it dies mid-`worktree add`: still locked "initializing", files missing.
    const gitdir = resolve(
      first.root,
      readFileSync(join(first.root, '.git'), 'utf8')
        .replace(/^gitdir:\s*/, '')
        .trim(),
    );
    writeFileSync(join(gitdir, 'locked'), 'initializing');
    unlinkSync(join(first.root, 'b.txt'));
    unlinkSync(join(first.root, 'c.txt'));

    // The restarted server's next spawn_steward for the task.
    const again = await h.composed.workspaces!.createWorktree(task.id);
    expect(again.path).toBe(first.path);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) expect(existsSync(join(again.path, f))).toBe(true);
    expect(git(again.path, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(gitdir, 'locked'))).toBe(false);
  });
});
