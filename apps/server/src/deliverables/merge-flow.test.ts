import { execFileSync } from 'node:child_process';
import {
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
import type { EventEnvelope } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { gitRunner } from '../workspace/git.js';
import { FOLDER_KEY } from './detection.js';

/**
 * Wave 2 wired together (P9-04, P9-05, P9-06): one merge of a task, in a composed runtime, keeps
 * the Steward's declared deliverables (P9-06's hook, inside the repository's lock) and then
 * re-detects the project's scripts (P9-05, after the merge is recorded). Order: the hook's
 * `deliverable.updated` → the task's merge record → the scan's `deliverable.added`.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'app', scripts });

let tmp: string;
let composed: ComposedRuntime;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-merge-flow-')));
  for (const d of ['home', 'data', 'projects/app', 'strays']) {
    mkdirSync(join(tmp, d), { recursive: true });
  }
  composed = composeRuntime(openDatabase(':memory:'), {
    workspaces: {
      projectsRoot: join(tmp, 'projects'),
      dataDir: join(tmp, 'data'),
      home: join(tmp, 'home'),
      git: gitRunner({ env: GIT_ENV }),
    },
    detection: { minIntervalMs: 0 },
    deliverables: { tmpDirs: [join(tmp, 'strays')], freeBytes: () => 2 ** 40 },
  });
});
afterEach(async () => {
  await composed.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

describe('a merged task: declared deliverables and detected scripts (wave 2)', () => {
  it('one merge keeps what the Steward declared and lists the scripts it brought', async () => {
    const { commands, workspaces, detection, deliverables, log } = composed;
    const ws = join(tmp, 'projects', 'app');
    writeFileSync(join(ws, 'package.json'), pkg({ build: 'tsc' }));
    writeFileSync(join(ws, '.gitignore'), 'dist/\n');
    const project = (await commands.createProject({ name: 'App', workspace: ws })).value;
    await workspaces!.prepareProject(project.id, { initGit: true });
    // The prepare's first commit holds both files: the checkout is clean for the merge.
    expect(git(ws, 'status', '--porcelain')).toBe('');
    await detection!.detectProject(project.id);

    const task = (await commands.createTask({ projectId: project.id, description: 'Add dev' }))
      .value;
    const tree = await workspaces!.createWorktree(task.id);
    const steward = log.runCommand((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
        projectId: project.id,
        taskId: task.id,
        meta: { cwd: tree.path },
      }),
    ).value;

    // The Steward's work: a script and a report committed, a build output ignored, a stray.
    writeFileSync(join(tree.path, 'package.json'), pkg({ build: 'tsc', dev: 'vite' }));
    writeFileSync(join(tree.path, 'report.md'), '# Report\n');
    git(tree.path, 'add', '-A');
    git(tree.path, 'commit', '-q', '-m', 'add dev and the report');
    mkdirSync(join(tree.path, 'dist'));
    writeFileSync(join(tree.path, 'dist', 'app.bin'), 'built');
    writeFileSync(join(tmp, 'strays', 'chart.png'), 'png');
    const declare = (title: string, kind: 'file' | 'image', path: string) =>
      deliverables!.declare(steward.id, {}, { kind, title, path }, { cwd: tree.path });
    const report = (await declare('Report', 'file', 'report.md')).deliverable;
    const build = (await declare('Build', 'file', 'dist/app.bin')).deliverable;
    const chart = (await declare('Chart', 'image', join(tmp, 'strays', 'chart.png'))).deliverable;
    const folder = join(ws, 'deliverables', 'add-dev');
    expect(chart.location).toEqual({
      storage: 'copy',
      path: join(folder, 'chart.png'),
      originalPath: join(tmp, 'strays', 'chart.png'),
    });
    expect(report.location?.storage).toBe('worktree');

    const events: EventEnvelope[] = [];
    log.subscribe((e) => events.push(e));
    const merged = await workspaces!.mergeTask(task.id);
    expect(merged.ok).toBe(true);
    await detection!.detectProject(project.id); // queues behind the scan the merge started

    const row = (id: string) => log.tables.deliverables.get(id)!;
    expect(row(report.id).location).toEqual({
      storage: 'in_place',
      path: join(ws, 'report.md'),
    });
    expect(row(build.id).location).toEqual({
      storage: 'copy',
      path: join(folder, 'app.bin'),
      originalPath: join(tree.path, 'dist', 'app.bin'),
    });
    expect(row(build.id).meta).toMatchObject({ copy: { bytes: 5 } });
    expect(readFileSync(join(folder, 'app.bin'), 'utf8')).toBe('built');
    expect(row(chart.id).location).toEqual(chart.location);
    expect(existsSync(join(folder, 'chart.png'))).toBe(true);
    expect(existsSync(tree.path)).toBe(false);

    const scripts = log.tables.deliverables
      .of({ projectId: project.id })
      .filter((d) => d.source === 'detected' && d.removedAt === undefined)
      .map((d) => d.detectedKey);
    expect(scripts).toEqual([FOLDER_KEY, 'package.json#build', 'package.json#dev']);

    // The order: the hook (inside the lock) → the merge recorded → the rescan.
    const at = (pred: (e: EventEnvelope) => boolean) => events.findIndex(pred);
    const hook = at(
      (e) => e.event.type === 'deliverable.updated' && e.event.deliverableId === build.id,
    );
    const recorded = at(
      (e) =>
        e.event.type === 'task.updated' &&
        e.event.taskId === task.id &&
        e.event.changes.meta?.['merge'] !== undefined,
    );
    const scan = at(
      (e) =>
        e.event.type === 'deliverable.added' &&
        e.event.deliverable.detectedKey === 'package.json#dev',
    );
    expect(hook).toBeGreaterThanOrEqual(0);
    expect(recorded).toBeGreaterThan(hook);
    expect(scan).toBeGreaterThan(recorded);
  });
});
