import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../../runtime/compose.js';
import { runIdOfKey } from '../../runtime/process-attribution.js';
import { SqliteProcessStore } from '../../runtime/process-store.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { alive, eventually, kill } from './drill-checks.js';
import { runDrillDirs, type RunForked, type RunPids, type RunReady } from './drill-run-server.js';

/**
 * P9-08 crash drill (TECHNOLOGY §9.8; SPEC decision 130): the server is killed while a managed
 * run lives — and, with fault injection, right after the run's fork, before its PID-table row and
 * its `run.started` — and the next life (in this process, as `index.ts` does it: `reconcile()`,
 * `reconcileLaunches()`, then the run service's restart pass) must leave nothing of the run: its
 * process group (the fixture server and its background child) and the process that escaped into
 * a group of its own carrying the run's marker. The run shows stopped ("Mission Control
 * restarted") and is never started again.
 *
 * Only processes this file started (by pid) are ever signalled by the test itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'drill-run-server.ts');
const SERVER_DIR = resolve(HERE, '../../..');

const roots: string[] = [];
const dbs: Database[] = [];
const lives: { composed?: ComposedRuntime; supervisor: ProcessSupervisor }[] = [];
const started = new Set<number>();

afterEach(async () => {
  for (const life of lives.splice(0)) {
    await life.composed?.dispose().catch(() => {});
    await life.supervisor.dispose().catch(() => {});
  }
  for (const db of dbs.splice(0)) db.close();
  for (const pid of started) kill(pid);
  started.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | undefined, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Runs the drill server until it is ready (or paused after the run's fork), then kills it. */
async function killMidRun(pause: boolean): Promise<{ root: string; pids: RunPids; ready?: RunReady }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-run-crash-')));
  roots.push(root);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', SERVER, root, ...(pause ? ['--pause-after-fork'] : [])],
    {
      cwd: SERVER_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HOME: join(root, 'home'), GALACTIC_LOG: 'silent' },
    },
  );
  started.add(-child.pid!);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  let ready: RunReady | undefined;
  if (pause) {
    await waitFor(() => readJson<RunForked>(join(root, 'forked.json')), 'the paused fork');
  } else {
    ready = await waitFor(() => readJson<RunReady>(join(root, 'ready.json')), 'the drill server');
  }
  const pids = await waitFor(
    () => readJson<RunPids>(join(runDrillDirs(root).app, 'pids.json')),
    'the fixture server',
  );
  for (const pid of [pids.server, pids.bg, pids.escaped]) started.add(pid);
  kill(child.pid!);
  await exited;
  return { root, pids, ...(ready ? { ready } : {}) };
}

/** The next start, in the order `index.ts` runs it. */
async function nextLife(root: string) {
  const dirs = runDrillDirs(root);
  const db = openDatabase(dirs.db);
  dbs.push(db);
  const supervisor = new ProcessSupervisor({ store: new SqliteProcessStore(db) });
  const life: (typeof lives)[number] = { supervisor };
  lives.push(life);
  const reconciled = supervisor.reconcile();
  const launches = await supervisor.reconcileLaunches({ termMs: 2_000 });
  life.composed = composeRuntime(db, {
    deliverables: { dataDir: dirs.data, home: join(root, 'home') },
    runs: { supervisor, termMs: 2_000 },
  });
  const rows = [...reconciled.dead, ...reconciled.orphans].flatMap((key) => {
    const runId = runIdOfKey(key);
    const row = runId !== undefined ? supervisor.processRecord(key) : undefined;
    return runId !== undefined && row ? [{ runId, intendedAt: row.startedAt }] : [];
  });
  const recovered = await life.composed.runs!.recover({
    launches: [...rows, ...(launches.runs ?? [])],
  });
  return { composed: life.composed, reconciled, launches, recovered };
}

describe('a server killed during a managed run (P9-08 drill)', () => {
  it('the next start stops everything of the run and shows it stopped', async () => {
    const { root, pids, ready } = await killMidRun(false);
    // The kill left the run's processes behind: its group and the escaped one.
    expect([pids.server, pids.bg, pids.escaped].every(alive)).toBe(true);
    const { composed, reconciled, recovered } = await nextLife(root);
    expect(reconciled.orphans).toContain(`run:${ready!.runId}`);
    expect(recovered.ended).toEqual([ready!.runId]);
    expect(recovered.stopped).toContain(pids.escaped);
    expect(await eventually(() => ![pids.server, pids.bg, pids.escaped].some(alive), 8_000)).toBe(
      true,
    );
    expect(composed.log.tables.runs.get(ready!.runId!)).toMatchObject({
      state: 'ended',
      outcome: 'stopped',
      reason: 'server_restarted',
    });
    expect(composed.log.tables.deliverables.get(ready!.deliverableId)?.lastRun?.state).toBe(
      'ended',
    );
    // Never started again.
    expect(composed.log.tables.runs.of(ready!.deliverableId)).toHaveLength(1);
    expect(composed.runs!.liveCount).toBe(0);
  }, 90_000);

  it('a run forked just before the kill (no row, no run.started) is cleaned up too', async () => {
    const { root, pids } = await killMidRun(true);
    expect([pids.server, pids.bg, pids.escaped].every(alive)).toBe(true);
    const { composed, launches, recovered } = await nextLife(root);
    expect(launches.taken.map((t) => t.agentId)).toEqual([
      expect.stringMatching(/^run:/),
    ]);
    expect(launches.runs).toHaveLength(1);
    expect(recovered.stopped).toContain(pids.escaped);
    expect(await eventually(() => ![pids.server, pids.bg, pids.escaped].some(alive), 8_000)).toBe(
      true,
    );
    // The log never knew the run: nothing to end, nothing started again.
    expect(composed.log.tables.runs.all()).toEqual([]);
  }, 90_000);
});
