import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_SETTINGS,
  type Actor,
  type AddDeliverableInput,
  type Deliverable,
  type RunOutputChunk,
  type RunSettings,
} from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createProject } from '../domain/projects.js';
import { createTask } from '../domain/tasks.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { attribute } from '../runtime/process-attribution.js';
import { osProcessTable } from '../runtime/process-table.js';
import { MemoryProcessStore, type ProcessStore } from '../runtime/process-store.js';
import { isRunning, ProcessSupervisor } from '../runtime/supervisor.js';
import { worktreeRoot } from '../workspace/workspaces.js';
import { RunError, RunService } from './runs.js';

/**
 * P9-08 — managed runs (TECHNOLOGY §9.8; SPEC decisions 129–131), with real `/bin/sh` children:
 * a fixture server in a temporary project folder that prints its address, listens on an
 * ephemeral port, starts a background child in its group and one escaped into a group of its
 * own (carrying the run's marker). Only processes this file started are ever signalled by it.
 */

const USER: Actor = { type: 'user' };
const LOCAL = { origin: 'local' as const };
const NODE = JSON.stringify(process.execPath);

/** The fixture server (written into each project folder). */
const SERVER = `
import http from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const server = http.createServer((_q, r) => r.end('ok'));
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const bg = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const escaped = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });
  escaped.unref();
  writeFileSync('pids.json', JSON.stringify({ server: process.pid, bg: bg.pid, escaped: escaped.pid, port }));
  console.log('ready on http://localhost:' + port);
  console.log('token sk-ant-' + 'a'.repeat(32));
});
`;

const started = new Set<number>();
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  for (const pid of started) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  started.clear();
});

async function eventually(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const alive = (pid: number) => isRunning(pid);

interface Setup {
  root: string;
  ws: string;
  composed: ComposedRuntime;
  supervisor: ProcessSupervisor;
  settings: RunSettings;
  projectId: string;
  command(line: string, extra?: Partial<AddDeliverableInput>): Promise<Deliverable>;
  pidsOf(): Promise<{ server: number; bg: number; escaped: number; port: number }>;
}

async function setup(
  opts: {
    settings?: { maxConcurrent?: number; output?: Partial<RunSettings['output']> };
    store?: ProcessStore;
    policy?: 'cautious';
  } = {},
): Promise<Setup> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-p908-')));
  const ws = join(root, 'app');
  mkdirSync(ws);
  mkdirSync(join(root, 'data'));
  writeFileSync(join(ws, 'server.mjs'), SERVER);
  const db = openDatabase(':memory:');
  const supervisor = new ProcessSupervisor({
    ...(opts.store ? { store: opts.store } : {}),
    defaults: { graceMs: 500, termMs: 500 },
  });
  const settings: RunSettings = {
    maxConcurrent: opts.settings?.maxConcurrent ?? DEFAULT_RUN_SETTINGS.maxConcurrent,
    output: { ...DEFAULT_RUN_SETTINGS.output, ...opts.settings?.output },
  };
  const composed = composeRuntime(db, {
    deliverables: { dataDir: join(root, 'data'), home: join(root, 'home') },
    runs: {
      supervisor,
      settings: () => settings,
      termMs: 1_500,
      ports: { fastMs: 150, slowMs: 300, fastForMs: 60_000 },
      flushMs: 20,
      holdMs: 20,
    },
  });
  cleanups.push(async () => {
    await composed.dispose();
    await supervisor.dispose({ graceMs: 100, termMs: 100 });
    rmSync(root, { recursive: true, force: true });
  });
  const project = composed.log.runCommand((ctx) =>
    createProject(ctx, {
      name: 'App',
      workspace: ws,
      bodyId: 'b-saturn',
      ...(opts.policy === 'cautious'
        ? {
            permissionPolicy: {
              rules: {
                read_workspace: 'ask',
                edit_workspace: 'deny',
                run_workspace: 'deny',
                destructive: 'deny',
                outside_workspace: 'deny',
                network: 'deny',
                push: 'deny',
              },
              unclassified: 'deny',
            },
          }
        : {}),
    }),
  ).value;
  const pidsFile = join(ws, 'pids.json');
  return {
    root,
    ws,
    composed,
    supervisor,
    settings,
    projectId: project.id,
    async command(line, extra = {}) {
      return (
        await composed.commands.addDeliverable(
          {
            projectId: project.id,
            kind: 'command',
            title: 'Dev server',
            source: 'user',
            command: { line, cwd: ws },
            ...extra,
          },
          USER,
          LOCAL,
        )
      ).value;
    },
    async pidsOf() {
      await eventually(() => existsSync(pidsFile));
      let pids: { server: number; bg: number; escaped: number; port: number } | undefined;
      await eventually(() => {
        try {
          pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as typeof pids;
          return true;
        } catch {
          return false;
        }
      });
      for (const pid of [pids!.server, pids!.bg, pids!.escaped]) started.add(pid);
      return pids!;
    },
  };
}

const rowOf = (s: Setup, id: string) => s.composed.log.tables.deliverables.get(id)!;
const runOf = (s: Setup, id: string) => s.composed.log.tables.runs.get(id)!;
const outputOf = (s: Setup, runId: string) =>
  s.composed
    .runOutput!.page(runId, 0, 5_000)
    .chunks.map((c) => c.chunk)
    .join('');

/** What the Run dialog sends back: the preview's version and confirmation (for `line`). */
function ok(s: Setup, id: string, line?: string) {
  const preview = s.composed.runs!.preview(id, line);
  return {
    version: preview.version,
    confirmation: preview.confirmation!,
    ...(line !== undefined ? { line } : {}),
  };
}

async function refusal(p: Promise<unknown>): Promise<RunError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof RunError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('a run of the fixture server (P9-08)', () => {
  it('streams its redacted output, shows its port, and Stop ends it with everything it started', async () => {
    const s = await setup();
    const d = await s.command(`${NODE} server.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    expect(run).toMatchObject({
      deliverableId: d.id,
      state: 'running',
      cwd: s.ws,
      startedBy: USER,
    });
    expect(rowOf(s, d.id).lastRun).toMatchObject({ runId: run.id, state: 'running' });
    const streamed: RunOutputChunk[] = [];
    const off = s.composed.runOutput!.subscribe(run.id, 0, (chunks) => streamed.push(...chunks));
    cleanups.push(off);
    const pids = await s.pidsOf();

    // Output: streamed, stored, and the key redacted before either.
    await eventually(() =>
      streamed
        .map((c) => c.chunk)
        .join('')
        .includes('ready on'),
    );
    await eventually(() => outputOf(s, run.id).includes('[redacted:'));
    const text = streamed.map((c) => c.chunk).join('');
    expect(text).not.toContain('sk-ant-');
    expect(outputOf(s, run.id)).not.toContain('sk-ant-');

    // Ports: from the system (lsof over the group and the marker carriers) or the output.
    await eventually(() => runOf(s, run.id).ports.includes(pids.port));
    expect(rowOf(s, d.id).lastRun?.ports).toContain(pids.port);

    // Stop: the group (the server and its background child) and the escaped carrier.
    expect([pids.server, pids.bg, pids.escaped].every(alive)).toBe(true);
    const ended = await s.composed.runs!.stop(run.id, USER);
    expect(ended).toMatchObject({ state: 'ended', outcome: 'stopped', stoppedBy: USER });
    await eventually(() => ![pids.server, pids.bg, pids.escaped].some(alive), 5_000);
    expect(rowOf(s, d.id).lastRun).toMatchObject({ state: 'ended', outcome: 'stopped' });
    expect(s.composed.runs!.liveCount).toBe(0);
  }, 30_000);

  it("never gives a Steward's attribution a run's process, and a run's stop spares a Steward's", async () => {
    const s = await setup();
    // A Steward's process (agent marker, its own group), alive across the run's stop.
    const steward = await s.supervisor.spawn({
      agentId: 'a-steward',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: s.ws,
    });
    started.add(steward.pid);
    const d = await s.command(`${NODE} server.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    const pids = await s.pidsOf();
    const table = osProcessTable();
    const procs = (await table.list())!;
    const mine = await attribute({
      agentId: 'a-steward',
      procs,
      groups: s.supervisor.agentGroups(),
      self: { pid: process.pid, uid: process.getuid?.() ?? -1 },
      sessions: s.supervisor.agentSessions('a-steward'),
      worktree: s.ws,
      cwdOf: (p) => table.cwds(p),
      markerOf: (p) =>
        table.markers!(procs.filter((q) => p.includes(q.pid))) as Promise<Map<number, string>>,
    });
    const attributed = mine.map((p) => p.pid);
    for (const pid of [pids.server, pids.bg, pids.escaped]) expect(attributed).not.toContain(pid);
    await s.composed.runs!.stop(run.id, USER);
    await eventually(() => !alive(pids.escaped));
    expect(alive(steward.pid)).toBe(true);
  }, 30_000);
});

describe('starting a run (decision 129)', () => {
  it('refuses a second run, a stale version, the cap, and an agent', async () => {
    const s = await setup({ settings: { maxConcurrent: 1 } });
    const d = await s.command('sleep 30');
    const other = await s.command('sleep 30', { title: 'Other' });
    const runs = s.composed.runs!;
    const before = ok(s, d.id);
    expect((await refusal(runs.start(d.id, ok(s, d.id), { type: 'agent', id: 'a-1' }))).code).toBe(
      'invalid',
    );
    const run = await runs.start(d.id, ok(s, d.id), USER);
    started.add(run.meta!['pid'] as number);
    expect((await refusal(runs.start(d.id, ok(s, d.id), USER))).code).toBe('running');
    expect((await refusal(runs.start(other.id, ok(s, other.id), USER))).code).toBe('run_cap');
    expect(runs.preview(other.id).refusal?.code).toBe('run_cap');
    await runs.stop(run.id, USER);

    // The command changed since the dialog opened: refused with the new row.
    await s.composed.commands.updateDeliverable(
      d.id,
      { command: { line: 'sleep 31', cwd: s.ws } },
      USER,
      LOCAL,
    );
    const stale = await refusal(runs.start(d.id, before, USER));
    expect(stale.code).toBe('stale');
    expect(stale.status).toBe(409);
    expect(stale.deliverable?.command?.line).toBe('sleep 31');
  }, 30_000);

  it('runs the line the user edited for that run, keeping the stored one', async () => {
    const s = await setup();
    const d = await s.command('echo stored');
    const run = await s.composed.runs!.start(d.id, ok(s, d.id, 'echo edited-for-this-run'), USER);
    expect(run).toMatchObject({ line: 'echo edited-for-this-run', meta: { edited: true } });
    await eventually(() => runOf(s, run.id).state === 'ended');
    expect(runOf(s, run.id)).toMatchObject({ outcome: 'exited', exitCode: 0 });
    expect(outputOf(s, run.id)).toContain('edited-for-this-run');
    expect(rowOf(s, d.id).command?.line).toBe('echo stored');
  }, 20_000);

  it('gives the allow-listed environment and the run marker — no token, keys or agent marker', async () => {
    process.env['GALACTIC_TOKEN'] = 'server-token-should-not-leak';
    process.env['ANTHROPIC_API_KEY'] = 'should-not-leak-either';
    cleanups.push(() => {
      delete process.env['GALACTIC_TOKEN'];
      delete process.env['ANTHROPIC_API_KEY'];
    });
    const s = await setup();
    const d = await s.command('env');
    const preview = s.composed.runs!.preview(d.id);
    expect(preview.envKeys).toContain('PATH');
    expect(preview.envKeys).toContain('GALACTIC_RUN_ID');
    expect(preview.envKeys).not.toContain('GALACTIC_TOKEN');
    expect(preview.envKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(preview.envKeys).not.toContain('GALACTIC_AGENT_ID');
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    await eventually(() => runOf(s, run.id).state === 'ended');
    const env = outputOf(s, run.id);
    expect(env).toContain(`GALACTIC_RUN_ID=${run.id}`);
    expect(env).toMatch(/GALACTIC_LAUNCH_ID=/);
    expect(env).not.toContain('should-not-leak');
    expect(env).not.toContain('GALACTIC_AGENT_ID');
    expect(env).not.toContain('GALACTIC_TOKEN');
  }, 20_000);

  it("waits for the merge when the command's folder is a task's worktree", async () => {
    const s = await setup();
    const task = s.composed.log.runCommand((ctx) =>
      createTask(ctx, { projectId: s.projectId, description: 'login page' }),
    ).value;
    const wt = worktreeRoot(s.ws, task.id);
    mkdirSync(wt, { recursive: true });
    const d = (
      await s.composed.commands.addDeliverable(
        {
          projectId: s.projectId,
          taskId: task.id,
          kind: 'command',
          title: 'Dev',
          source: 'user',
          command: { line: 'echo hi', cwd: realpathSync(wt) },
        },
        USER,
        LOCAL,
      )
    ).value;
    expect(s.composed.runs!.preview(d.id).refusal).toMatchObject({ code: 'after_merge' });
    const r = await refusal(s.composed.runs!.start(d.id, ok(s, d.id), USER));
    expect(r.code).toBe('after_merge');
  });

  it("starts in a cautious project on the user's confirmation alone, with the engine's warnings", async () => {
    const s = await setup({ policy: 'cautious' });
    mkdirSync(join(s.ws, 'build'));
    const d = await s.command('rm -rf build && curl -s https://example.invalid || true');
    const preview = s.composed.runs!.preview(d.id);
    expect(preview.warnings).toEqual(
      expect.arrayContaining(['deletes or overwrites files', 'uses the network']),
    );
    expect(preview.refusal).toBeUndefined();
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    await eventually(() => runOf(s, run.id).state === 'ended');
    expect(existsSync(join(s.ws, 'build'))).toBe(false);
  }, 20_000);

  it('shows a detected command’s body, flagged when it changed since the last run', async () => {
    const s = await setup();
    const d = await s.command('echo dev', {
      source: 'user',
      meta: { detected: { line: 'echo dev', body: 'vite' } },
    });
    const first = s.composed.runs!.preview(d.id);
    expect(first).toMatchObject({ body: 'vite' });
    expect(first.bodyChanged).toBeUndefined(); // never run
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    expect(run.meta).toMatchObject({ body: 'vite' });
    await eventually(() => runOf(s, run.id).state === 'ended');
    expect(s.composed.runs!.preview(d.id).bodyChanged).toBe(false);
    await s.composed.commands.updateDeliverable(
      d.id,
      { meta: { detected: { line: 'echo dev', body: 'vite --port 4000' } } },
      { type: 'system' },
    );
    const changed = s.composed.runs!.preview(d.id);
    expect(changed).toMatchObject({
      body: 'vite --port 4000',
      bodyChanged: true,
      lastRunBody: 'vite',
    });
  }, 20_000);

  it('a run that fails by a signal says so; a non-zero exit keeps its code', async () => {
    const s = await setup();
    const crash = await s.command('kill -9 $$');
    const exit = await s.command('exit 3', { title: 'exit' });
    const a = await s.composed.runs!.start(crash.id, ok(s, crash.id), USER);
    const b = await s.composed.runs!.start(exit.id, ok(s, exit.id), USER);
    await eventually(() => runOf(s, a.id).state === 'ended' && runOf(s, b.id).state === 'ended');
    expect(runOf(s, a.id)).toMatchObject({ outcome: 'failed', signal: 'SIGKILL' });
    expect(runOf(s, b.id)).toMatchObject({ outcome: 'exited', exitCode: 3 });
  }, 20_000);
});

describe('the marker sweep spares what the user shares (wave-3 review S4)', () => {
  /** Detached children under other names (bash `exec -a`), all carrying the run's marker. */
  const DAEMONS = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const node = process.execPath;
const as = (name) => {
  const c = spawn('/bin/bash', ['-c', 'exec -a "$0" "$1" -e "setInterval(() => {}, 1000)"', name, node], {
    stdio: 'ignore',
    detached: true,
  });
  c.unref();
  return c.pid;
};
const pids = {
  watchman: as('watchman'),
  mux: as('ssh: /tmp/galactic-test-control [mux]'),
  gradle: as('java -Xmx512m org.gradle.launcher.daemon.bootstrap.GradleDaemon 8.10'),
  app: as('/Applications/Fake.app/Contents/MacOS/Fake'),
  plain: as('galactic-plain-child'),
};
writeFileSync('daemons.json', JSON.stringify(pids));
console.log('spawned');
setInterval(() => {}, 1000);
`;

  it('a shared daemon and an app with the marker survive the stop; an ordinary marked child goes', async () => {
    const s = await setup();
    writeFileSync(join(s.ws, 'daemons.mjs'), DAEMONS);
    // A process the run never started (no marker), started after it: never touched.
    const d = await s.command(`${NODE} daemons.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    const file = join(s.ws, 'daemons.json');
    await eventually(() => existsSync(file));
    let pids!: Record<'watchman' | 'mux' | 'gradle' | 'app' | 'plain', number>;
    await eventually(() => {
      try {
        pids = JSON.parse(readFileSync(file, 'utf8')) as typeof pids;
        return true;
      } catch {
        return false;
      }
    });
    for (const pid of Object.values(pids)) started.add(pid);
    const { spawn } = await import('node:child_process');
    const unmarked = spawn(
      '/bin/bash',
      [
        '-c',
        'exec -a "$0" "$1" -e "setInterval(() => {}, 1000)"',
        'galactic-unmarked',
        process.execPath,
      ],
      { stdio: 'ignore', detached: true },
    );
    unmarked.unref();
    started.add(unmarked.pid!);
    // The names are in the process table before the stop looks.
    const table = osProcessTable();
    await eventually(async () => {
      const procs = (await table.list()) ?? [];
      return procs.some((p) => p.pid === pids.watchman && p.command.startsWith('watchman'));
    });

    await s.composed.runs!.stop(run.id, USER);
    await eventually(() => !alive(pids.plain), 5_000);
    expect(alive(pids.watchman)).toBe(true);
    expect(alive(pids.mux)).toBe(true);
    expect(alive(pids.gradle)).toBe(true);
    expect(alive(pids.app)).toBe(true);
    expect(alive(unmarked.pid!)).toBe(true);
  }, 30_000);
});

describe('restart and the roots (wave-3 review S1, S6, N6)', () => {
  it('a restart at the cap replaces the run (it does not count itself)', async () => {
    const s = await setup({ settings: { maxConcurrent: 1 } });
    const d = await s.command('sleep 30');
    const first = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    started.add(first.meta!['pid'] as number);
    const second = await s.composed.runs!.restart(first.id, ok(s, d.id), USER);
    started.add(second.meta!['pid'] as number);
    expect(runOf(s, first.id)).toMatchObject({ outcome: 'stopped' });
    expect(second.state).toBe('running');
    await s.composed.runs!.stop(second.id, USER);
  }, 20_000);

  it('a restart that could not start again stops nothing', async () => {
    const s = await setup();
    const d = await s.command('sleep 30');
    const first = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    started.add(first.meta!['pid'] as number);
    const confirmation = ok(s, d.id);
    rmSync(s.ws, { recursive: true, force: true });
    const r = await refusal(s.composed.runs!.restart(first.id, confirmation, USER));
    expect(r.code).toBe('folder');
    expect(runOf(s, first.id).state).toBe('running');
    expect(s.composed.runs!.liveCount).toBe(1);
    await s.composed.runs!.stop(first.id, USER);
  }, 20_000);

  it('refuses a folder in the repository outside the project folder', async () => {
    const s = await setup();
    const tools = join(s.root, 'tools');
    mkdirSync(tools);
    await s.composed.commands.updateProject(s.projectId, {
      meta: { workspace: { git: true, repoRoot: s.root, serialStewards: false } },
    });
    const d = await s.command('echo hi', { command: { line: 'echo hi', cwd: tools } });
    expect(s.composed.runs!.preview(d.id).refusal).toMatchObject({ code: 'folder' });
    expect((await refusal(s.composed.runs!.start(d.id, ok(s, d.id), USER))).code).toBe('folder');
  });

  it('a deliverables folder replaced by a symlink is no root to run in', async () => {
    const s = await setup();
    const folder = join(s.ws, 'deliverables');
    mkdirSync(join(folder, 'site'), { recursive: true });
    await s.composed.commands.updateProject(s.projectId, {
      meta: { deliverablesFolder: folder },
    });
    const d = await s.command('echo hi', {
      command: { line: 'echo hi', cwd: join(folder, 'site') },
    });
    expect(s.composed.runs!.preview(d.id).refusal).toBeUndefined();
    // Swapped for a link to a folder outside the project, with the same inner path.
    const elsewhere = join(s.root, 'elsewhere');
    mkdirSync(join(elsewhere, 'site'), { recursive: true });
    rmSync(folder, { recursive: true });
    symlinkSync(elsewhere, folder);
    expect(s.composed.runs!.preview(d.id).refusal).toMatchObject({ code: 'folder' });
    expect((await refusal(s.composed.runs!.start(d.id, ok(s, d.id), USER))).code).toBe('folder');
  });
});

describe('runs stopped with their work and the server (decision 130)', () => {
  it('closing the project stops its run', async () => {
    const s = await setup();
    const d = await s.command(`${NODE} server.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    const pids = await s.pidsOf();
    await s.composed.commands.closeProject(s.projectId, USER);
    await eventually(() => runOf(s, run.id).state === 'ended');
    expect(runOf(s, run.id)).toMatchObject({ outcome: 'stopped', reason: 'project_closed' });
    await eventually(() => ![pids.server, pids.bg, pids.escaped].some(alive), 5_000);
  }, 30_000);

  it('removing the deliverable stops its run', async () => {
    const s = await setup();
    const d = await s.command('sleep 30');
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    await s.composed.commands.removeDeliverable(d.id, USER, undefined, LOCAL);
    await eventually(() => runOf(s, run.id).state === 'ended');
    expect(runOf(s, run.id)).toMatchObject({ outcome: 'stopped', reason: 'deliverable_removed' });
  }, 20_000);

  it('shutdown stops every run and starts no new one', async () => {
    const s = await setup();
    const d = await s.command(`${NODE} server.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    const pids = await s.pidsOf();
    const log = s.composed.log;
    await s.composed.shutdown();
    expect(log.tables.runs.get(run.id)).toMatchObject({
      outcome: 'stopped',
      reason: 'server_stopping',
    });
    await eventually(() => ![pids.server, pids.bg, pids.escaped].some(alive), 5_000);
  }, 30_000);

  it('after a restart a run shows stopped and what is left of it is stopped, never restarted', async () => {
    // Life one: a run starts; the server "dies" without stopping it (its PID row stays running).
    const store = new MemoryProcessStore();
    const s = await setup({ store });
    const d = await s.command(`${NODE} server.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    const pids = await s.pidsOf();
    s.composed.runs!.dispose(); // no stop: the run outlives "the server"
    expect(store.get(`run:${run.id}`)?.status).toBe('running');

    // Life two (same machine and boot): the supervisor's pass, then the run service's.
    const next = new ProcessSupervisor({ store });
    cleanups.push(() => next.dispose({ graceMs: 100, termMs: 100 }));
    expect(next.reconcile().orphans).toContain(`run:${run.id}`);
    const runs = new RunService({
      log: s.composed.log,
      supervisor: next,
      output: s.composed.runOutput!,
      settings: () => s.settings,
      places: { dataDir: join(s.root, 'data'), home: join(s.root, 'home') },
      termMs: 1_500,
    });
    const recovered = await runs.recover();
    expect(recovered.ended).toEqual([run.id]);
    expect(recovered.stopped).toContain(pids.escaped);
    expect(runOf(s, run.id)).toMatchObject({
      outcome: 'stopped',
      reason: 'server_restarted',
      stoppedBy: { type: 'system' },
    });
    expect(rowOf(s, d.id).lastRun?.state).toBe('ended');
    await eventually(() => ![pids.server, pids.bg, pids.escaped].some(alive), 5_000);
    expect(runs.liveCount).toBe(0);
    // Nothing is started again.
    expect(s.composed.log.tables.runs.of(d.id)).toHaveLength(1);
  }, 30_000);
});

describe("a run's output limits (decision 130)", () => {
  it('keeps the newest part past the byte limit and says how much went', async () => {
    const s = await setup({ settings: { output: { maxBytesPerRun: 64 * 1024 } } });
    const script = `for (let i = 0; i < 4000; i++) console.log('line ' + i + ' ' + 'x'.repeat(80));`;
    writeFileSync(join(s.ws, 'loud.mjs'), script);
    const d = await s.command(`${NODE} loud.mjs`);
    const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
    await eventually(() => runOf(s, run.id).state === 'ended');
    const page = s.composed.runOutput!.page(run.id, 0, 5_000);
    const text = page.chunks.map((c) => c.chunk).join('');
    expect(page.truncatedBefore).toBeGreaterThan(0);
    expect(text).toContain('line 3999');
    expect(text).not.toContain('line 0 ');
    // The newest chunk may run past the limit alone; the rest fits under it.
    const bytes = page.chunks.slice(0, -1).reduce((n, c) => n + Buffer.byteLength(c.chunk), 0);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);
  }, 20_000);

  it("retention keeps the output of each command's newest runs only", async () => {
    const s = await setup({ settings: { output: { keepRuns: 2 } } });
    const d = await s.command('echo run');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = await s.composed.runs!.start(d.id, ok(s, d.id), USER);
      ids.push(run.id);
      await eventually(() => runOf(s, run.id).state === 'ended');
      await new Promise((r) => setTimeout(r, 5)); // distinct start times
    }
    for (const id of ids) expect(outputOf(s, id)).toContain('run');
    const report = await s.composed.transcriptRetention.run();
    expect(report.runOutputRuns).toBe(1);
    expect(outputOf(s, ids[0]!)).toBe('');
    expect(outputOf(s, ids[1]!)).toContain('run');
    expect(outputOf(s, ids[2]!)).toContain('run');
  }, 20_000);
});
