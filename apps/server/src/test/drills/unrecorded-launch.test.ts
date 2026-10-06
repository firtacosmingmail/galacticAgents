import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainHarness } from '../../brains/testing/index.js';
import { openDatabase, type Database } from '../../db/database.js';
import { SqliteProcessStore } from '../../runtime/process-store.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { alive, eventually, kill } from './drill-checks.js';
import type { Forked, StandIn } from './drill-server.js';
import { bootDrill, drillDirs, GIT_ENV } from './drill-world.js';

/**
 * P8-11 (R3 of the P8-04 drills): the server is killed between the fork of an agent's CLI and its
 * PID-table row. Fault injection: the drill server's `--pause-after-fork` hook blocks the server
 * right after the supervisor forked a Steward's stand-in CLI, before the row; the drill waits for
 * the stand-in to be up and SIGKILLs the server. The next life (in this process, as `index.ts`:
 * `reconcile()`, then `reconcileLaunches()`) must leave no process of the killed run's CLI group —
 * `reconcile()` alone has no row to go by — and leave what escaped the group to the Steward
 * (decision 76), findable by its sweep because the launch became an interrupted session.
 *
 * Only processes this file started (by pid or group) are ever signalled by the test itself.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'drill-server.ts');
const SERVER_DIR = resolve(HERE, '../../..');

const roots: string[] = [];
const dbs: Database[] = [];
const lives: { h?: BrainHarness; supervisor: ProcessSupervisor }[] = [];
const started = new Set<number>();

afterEach(async () => {
  for (const life of lives.splice(0)) {
    await life.h?.dispose().catch(() => {});
    await life.supervisor.dispose().catch(() => {});
  }
  for (const db of dbs.splice(0)) db.close();
  // Every stand-in the drill server started (S1's too when S2's fork is the paused one).
  for (const r of roots) {
    for (const f of readdirSync(r).filter((name) => name.endsWith('.pids.json'))) {
      const s = readJson<StandIn>(join(r, f));
      if (s) track(s);
    }
  }
  for (const p of started) kill(p);
  started.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function track(s: StandIn): void {
  started.add(-s.leader);
  started.add(s.child);
  if (s.escaped !== undefined) started.add(-s.escaped);
}

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
    return undefined; // being written
  }
}

/** Runs the drill server until it pauses after forking `which`'s stand-in, then kills it. */
async function killBetweenForkAndRow(
  which: 's1' | 's2',
): Promise<{ root: string; forked: Forked; standIn: StandIn }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-launch-')));
  roots.push(root);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', SERVER, root, '--pause-after-fork', which],
    {
      cwd: SERVER_DIR,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...GIT_ENV, HOME: join(root, 'home'), GALACTIC_LOG: 'silent' },
    },
  );
  started.add(-child.pid!);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const forked = await waitFor(
    () => readJson<Forked>(join(root, 'forked.json')),
    'the paused fork',
  );
  const standIn = await waitFor(
    () => readJson<StandIn>(join(root, `${forked.agentId}.pids.json`)),
    'the stand-in to start',
    10_000,
  );
  track(standIn);
  expect(standIn.leader).toBe(forked.pid);
  kill(child.pid!);
  await exited;
  return { root, forked, standIn };
}

describe('a CLI forked just before a kill (P8-11, fault injection)', () => {
  it('the leader alive: its group is stopped at the next start, what escaped is left to the Steward', async () => {
    const { root, forked, standIn } = await killBetweenForkAndRow('s1');
    const dirs = drillDirs(root);
    const db = openDatabase(dirs.db);
    dbs.push(db);
    const store = new SqliteProcessStore(db);
    // The fault: the intent is there, the row is not.
    expect(store.get(forked.agentId)).toBeUndefined();
    expect(store.launches().map((i) => [i.id, i.agentId])).toEqual([
      [forked.launchId, forked.agentId],
    ]);
    expect(alive(standIn.leader) && alive(standIn.child)).toBe(true);

    const supervisor = new ProcessSupervisor({ store });
    const life: (typeof lives)[number] = { supervisor };
    lives.push(life);
    // `reconcile()` alone cannot take it: there is no row.
    expect(supervisor.reconcile()).toEqual({ dead: [], orphans: [] });
    const launches = await supervisor.reconcileLaunches({ termMs: 2_000 });
    expect(launches.taken).toEqual([
      expect.objectContaining({
        agentId: forked.agentId,
        launchId: forked.launchId,
        pgids: [standIn.leader],
      }),
    ]);
    expect(launches.taken[0]!.pids).toEqual(
      expect.arrayContaining([standIn.leader, standIn.child]),
    );
    expect(launches.taken[0]!.pids).not.toContain(standIn.escaped);
    // No process of the killed run's CLI group survives.
    expect(await eventually(() => !alive(standIn.leader) && !alive(standIn.child))).toBe(true);
    // What escaped the group is the Steward's, left for its sweep (decision 76).
    expect(alive(standIn.escaped!)).toBe(true);
    expect(store.launches()).toEqual([]);
    expect(store.get(forked.agentId)).toMatchObject({
      status: 'interrupted',
      pid: standIn.leader,
      meta: expect.objectContaining({ launchId: forked.launchId, fromLaunchIntent: true }),
    });

    // The launch is a session of the Steward now: its process list finds the escaped process.
    life.h = bootDrill(dirs, db, { groups: supervisor });
    await life.h.recover();
    const listed = await life.h.composed.processes!.list(forked.agentId);
    expect(listed.processes.map((p) => [p.pid, p.why])).toContainEqual([
      standIn.escaped,
      'worktree',
    ]);
  }, 90_000);

  it('the leader gone on EOF: its leftover group is stopped at the next start', async () => {
    const { root, forked, standIn } = await killBetweenForkAndRow('s2');
    // S2's stand-in exits when the server's pipe closes; its group child lives on.
    expect(await eventually(() => !alive(standIn.leader))).toBe(true);
    expect(alive(standIn.child)).toBe(true);
    const db = openDatabase(drillDirs(root).db);
    dbs.push(db);
    const store = new SqliteProcessStore(db);
    const supervisor = new ProcessSupervisor({ store });
    lives.push({ supervisor });
    // S1's launch completed (its row exists): reconcile takes S1's group; S2 has no row.
    const reconciled = supervisor.reconcile();
    expect(reconciled.orphans).not.toContain(forked.agentId);
    expect(reconciled.dead).not.toContain(forked.agentId);
    const launches = await supervisor.reconcileLaunches({ termMs: 2_000 });
    expect(launches.taken).toEqual([
      expect.objectContaining({ agentId: forked.agentId, pgids: [standIn.leader] }),
    ]);
    expect(launches.taken[0]!.pids).toEqual([standIn.child]);
    expect(await eventually(() => !alive(standIn.child))).toBe(true);
    expect(store.launches()).toEqual([]);
  }, 90_000);
});
