import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { LAUNCH_ID_ENV } from './launch-intents.js';
import { AGENT_ID_ENV, type ProcEntry } from './process-attribution.js';
import {
  MemoryProcessStore,
  SqliteProcessStore,
  type LaunchIntent,
  type ProcessRecord,
} from './process-store.js';
import type { ProcessTable } from './process-table.js';
import {
  bootTime,
  ProcessSupervisor,
  type ProcessOutcome,
  type ProcessProbe,
  type ProcessSpec,
} from './supervisor.js';

/**
 * P8-11: the supervisor records a launch intent before every fork and, at the next start, stops
 * the processes of a launch whose PID-table row never came. Real processes for the recording
 * (only children of this test); a scripted process table and probe for `reconcileLaunches()`, so
 * no signal ever reaches a real process there. The kill-between-fork-and-row drill is
 * `test/drills/unrecorded-launch.test.ts`.
 */

const NODE = process.execPath;
const node = (script: string, extra: Partial<ProcessSpec> = {}): ProcessSpec => ({
  agentId: 'a-1',
  command: NODE,
  args: ['-e', script],
  cwd: process.cwd(),
  ...extra,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await sleep(20);
  }
}

const supervisors: ProcessSupervisor[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.dispose({ graceMs: 100, termMs: 100 });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function make(opts: ConstructorParameters<typeof ProcessSupervisor>[0] = {}) {
  const outcomes: ProcessOutcome[] = [];
  const s = new ProcessSupervisor({
    defaults: { graceMs: 200, termMs: 200 },
    onOutcome: (o) => outcomes.push(o),
    ...opts,
  });
  supervisors.push(s);
  return { s, outcomes };
}
function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-launch-unit-')));
  dirs.push(d);
  return d;
}

const storageFull = () =>
  Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });

describe('ProcessSupervisor — launch intents (P8-11)', () => {
  it('writes the intent before the fork and removes it once the row holds the child', async () => {
    const db = openDatabase(':memory:');
    const store = new SqliteProcessStore(db);
    const seen: { intents: LaunchIntent[]; row: ProcessRecord | undefined; launchId: string }[] =
      [];
    const { s } = make({
      store,
      testHooks: {
        afterFork: (info) =>
          seen.push({
            intents: store.launches(),
            row: store.get(info.agentId),
            launchId: info.launchId,
          }),
      },
    });
    let out = '';
    const proc = await s.spawn(
      node(
        `console.log(JSON.stringify([process.env.${LAUNCH_ID_ENV}, process.env.${AGENT_ID_ENV}]))`,
        { onStdout: (c) => (out += c), meta: { runtime: 'fake' } },
      ),
    );
    // At the fork: the intent is there, the row is not yet.
    expect(seen).toHaveLength(1);
    const [{ intents, row, launchId }] = seen as [(typeof seen)[number]];
    expect(row).toBeUndefined();
    expect(intents).toEqual([
      {
        id: launchId,
        agentId: 'a-1',
        command: NODE,
        args: expect.any(Array),
        cwd: process.cwd(),
        runId: expect.any(String),
        bootAt: expect.any(String),
        intendedAt: expect.any(String),
        meta: { runtime: 'fake' },
      },
    ]);
    // After it: the row names the launch, the intent is gone.
    expect(store.launches()).toEqual([]);
    expect(store.get('a-1')?.meta?.['launchId']).toBe(launchId);
    await proc.exited;
    await eventually(() => out.includes(']'));
    // The child (and its descendants) carry the launch id next to the agent marker.
    expect(JSON.parse(out)).toEqual([launchId, 'a-1']);
    db.close();
  });

  it('forks nothing when the intent cannot be written (a full disk): a start failure', async () => {
    const dir = tempDir();
    const marker = join(dir, 'ran');
    const store = new MemoryProcessStore();
    store.addLaunch = () => {
      throw storageFull();
    };
    const { s, outcomes } = make({ store });
    const spec = node(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`);
    await expect(s.spawn(spec)).rejects.toThrow(
      /launch could not be recorded \(database or disk is full\)/,
    );
    expect(() => s.adopt({ ...spec, agentId: 'a-2' })).toThrow(/launch could not be recorded/);
    expect(outcomes.map((o) => [o.kind, o.agentId])).toEqual([
      ['start_failed', 'a-1'],
      ['start_failed', 'a-2'],
    ]);
    expect(s.list()).toEqual([]);
    expect(store.all()).toEqual([]);
    await sleep(300);
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps the intent when the row cannot be written after the fork', async () => {
    const store = new MemoryProcessStore();
    const upsert = store.upsert.bind(store);
    let full = true;
    store.upsert = (r) => {
      if (full) throw storageFull();
      upsert(r);
    };
    const { s } = make({ store, onError: () => {} });
    const proc = await s.spawn(node('setInterval(() => {}, 1000)'));
    expect(store.get('a-1')).toBeUndefined();
    expect(store.launches().map((i) => i.agentId)).toEqual(['a-1']);
    // Space back: the next row write completes the launch.
    full = false;
    await s.stop('a-1', { graceMs: 50, termMs: 200 });
    await proc.exited;
    expect(store.get('a-1')?.status).toBe('exited');
    expect(store.launches()).toEqual([]);
  });

  it('a command that cannot start leaves no intent', async () => {
    const store = new MemoryProcessStore();
    const { s, outcomes } = make({ store });
    await expect(s.spawn(node('', { command: '/nonexistent/galactic-cli' }))).rejects.toThrow(
      /ENOENT/,
    );
    expect(outcomes.map((o) => o.kind)).toEqual(['start_failed']);
    expect(store.launches()).toEqual([]);
  });

  it('a restart records a launch of its own', async () => {
    const store = new MemoryProcessStore();
    const ids: string[] = [];
    const { s } = make({ store, testHooks: { afterFork: (i) => ids.push(i.launchId) } });
    const proc = await s.spawn(
      node('process.exit(3)', { restart: { mode: 'on-crash', maxRestarts: 1, backoffMs: 10 } }),
    );
    await proc.exited;
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(store.get('a-1')?.meta?.['launchId']).toBe(ids[1]);
    expect(store.launches()).toEqual([]);
  });
});

describe('ProcessSupervisor.reconcileLaunches (P8-11, scripted table)', () => {
  const T = Date.now() - 120_000;
  const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
  const WT = '/p/.galactic/worktrees/t1';
  const intent = (over: Partial<LaunchIntent> = {}): LaunchIntent => ({
    id: 'launch-1',
    agentId: 'a-s1',
    command: 'claude',
    args: [],
    cwd: WT,
    runId: 'run-killed',
    bootAt: bootTime(),
    intendedAt: new Date(T).toISOString(),
    ...over,
  });
  const uid = process.getuid?.() ?? 501;
  const cli: ProcEntry = {
    pid: 4242,
    ppid: 1,
    pgid: 4242,
    uid,
    startedAt: sec(T),
    command: 'claude',
  };
  const child: ProcEntry = { ...cli, pid: 4243, ppid: 4242, startedAt: sec(T + 500) };
  const launchd: ProcEntry = { pid: 1, ppid: 0, pgid: 1, uid: 0, startedAt: 0, command: 'launchd' };
  const marked = new Map([
    [AGENT_ID_ENV, 'a-s1'],
    [LAUNCH_ID_ENV, 'launch-1'],
  ]);

  /** A table and probe over a fake world; signals are recorded, never sent. */
  function world(opts: {
    procs?: ProcEntry[] | undefined;
    env?: Map<number, Map<string, string>>;
    noEnvironment?: boolean;
    startTime?: (pid: number) => number | undefined;
    dies?: 'SIGTERM' | 'SIGKILL' | 'never';
  }) {
    const signals: [number, string][] = [];
    let alive = true;
    const procs = 'procs' in opts ? opts.procs : [launchd, cli, child];
    const table: ProcessTable = {
      list: async () => procs,
      cwds: async (pids) => new Map(pids.map((p) => [p, WT])),
      ports: async () => new Map(),
      kill: () => {
        throw new Error('no single-process signal expected');
      },
      ...(opts.noEnvironment
        ? {}
        : {
            environment: async (ps) =>
              new Map(
                ps.flatMap((p) => {
                  const env = (opts.env ?? new Map([[cli.pid, marked]])).get(p.pid);
                  return env ? [[p.pid, env] as const] : [];
                }),
              ),
          }),
    };
    const probe: Partial<ProcessProbe> = {
      alive: (pid) => alive && (pid === cli.pid || pid === child.pid),
      groupAlive: () => alive,
      startTime: opts.startTime ?? ((pid) => (pid === cli.pid ? cli.startedAt : undefined)),
      name: () => 'claude',
      signalGroup: (pgid, sig) => {
        signals.push([pgid, sig]);
        if (sig === (opts.dies ?? 'SIGTERM')) alive = false;
      },
    };
    return { table, probe, signals };
  }

  it('stops the launched CLI’s group gracefully and records the launch as an interrupted session', async () => {
    const store = new MemoryProcessStore();
    store.addLaunch(intent());
    const w = world({});
    const { s } = make({ store, table: w.table, probe: w.probe });
    const result = await s.reconcileLaunches({ termMs: 100 });
    expect(result).toEqual({
      completed: [],
      taken: [
        { agentId: 'a-s1', launchId: 'launch-1', pgids: [4242], pids: [4242, 4243], forced: false },
      ],
      none: [],
      unchecked: [],
    });
    expect(w.signals).toEqual([
      [4242, 'SIGTERM'],
      [4242, 'SIGCONT'],
    ]);
    expect(store.launches()).toEqual([]);
    expect(store.get('a-s1')).toMatchObject({
      pid: 4242,
      status: 'interrupted',
      startedAt: new Date(T).toISOString(),
      meta: { command: 'claude', launchId: 'launch-1', fromLaunchIntent: true },
    });
    // The interrupted launch is a session of the agent (process attribution's window).
    expect(s.agentSessions('a-s1')).toEqual([{ start: T, end: expect.any(Number) }]);
  });

  it('forces a group that outlives SIGTERM', async () => {
    const store = new MemoryProcessStore();
    store.addLaunch(intent());
    const w = world({ dies: 'SIGKILL' });
    const { s } = make({ store, table: w.table, probe: w.probe });
    const result = await s.reconcileLaunches({ termMs: 50 });
    expect(result.taken[0]?.forced).toBe(true);
    expect(w.signals.map(([, sig]) => sig)).toEqual(['SIGTERM', 'SIGCONT', 'SIGKILL']);
  });

  it('a launch whose row came is completed: nothing is read or signalled', async () => {
    const store = new MemoryProcessStore();
    store.addLaunch(intent());
    store.upsert({
      agentId: 'a-s1',
      pid: 4242,
      startedAt: new Date(T).toISOString(),
      status: 'interrupted',
      meta: { launchId: 'launch-1', bootAt: bootTime(), command: 'claude' },
    });
    const w = world({});
    w.table.list = async () => {
      throw new Error('not read');
    };
    const { s } = make({ store, table: w.table, probe: w.probe });
    expect(await s.reconcileLaunches()).toMatchObject({ completed: ['a-s1'], taken: [] });
    expect(w.signals).toEqual([]);
    expect(store.launches()).toEqual([]);
  });

  it('forgets another boot’s intents and never touches this run’s own', async () => {
    const store = new MemoryProcessStore();
    store.addLaunch(intent({ id: 'old', bootAt: '2020-01-01T00:00:00.000Z' }));
    store.addLaunch(intent({ id: 'mine', agentId: 'a-now', runId: 'run-now' }));
    const w = world({});
    const { s } = make({ store, table: w.table, probe: w.probe, runId: 'run-now' });
    expect(await s.reconcileLaunches()).toMatchObject({ none: ['a-s1'], taken: [] });
    expect(w.signals).toEqual([]);
    expect(store.launches().map((i) => i.id)).toEqual(['mine']);
  });

  it('signals nothing when the environment cannot be read, or the CLI is someone else by now', async () => {
    for (const w of [
      world({ noEnvironment: true }),
      world({ env: new Map() }),
      // pid reuse between the snapshot and the signal: another start time.
      world({ startTime: () => T + 90_000 }),
      // The start time cannot be read again: fail closed.
      world({ startTime: () => undefined }),
    ]) {
      const store = new MemoryProcessStore();
      store.addLaunch(intent());
      const { s } = make({ store, table: w.table, probe: w.probe });
      const result = await s.reconcileLaunches({ termMs: 50 });
      expect(result).toMatchObject({ taken: [], none: ['a-s1'] });
      expect(w.signals).toEqual([]);
      expect(store.launches()).toEqual([]);
    }
  });

  it('a platform without a process table forgets the intents unchecked', async () => {
    const store = new MemoryProcessStore();
    store.addLaunch(intent());
    const w = world({ procs: undefined });
    const { s } = make({ store, table: w.table, probe: w.probe });
    expect(await s.reconcileLaunches()).toMatchObject({ unchecked: ['a-s1'], taken: [] });
    expect(store.launches()).toEqual([]);
  });

  it('never overwrites a newer row of the agent', async () => {
    const store = new MemoryProcessStore();
    store.addLaunch(intent());
    const newer: ProcessRecord = {
      agentId: 'a-s1',
      pid: 777,
      startedAt: new Date(T + 10_000).toISOString(),
      endedAt: new Date(T + 20_000).toISOString(),
      status: 'exited',
      meta: { launchId: 'launch-2', bootAt: bootTime(), command: 'claude' },
    };
    store.upsert(newer);
    const w = world({});
    const { s } = make({ store, table: w.table, probe: w.probe });
    await s.reconcileLaunches({ termMs: 50 });
    expect(store.get('a-s1')).toEqual(newer);
  });
});
