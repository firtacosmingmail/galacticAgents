import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENDED_STATES, isHarnessMeta, type Event, type Id } from '@galactic/protocol';
import { startHarmonizer } from '../../brains/harmonizer/index.js';
import type { BrainHarness } from '../../brains/testing/index.js';
import { openDatabase, type Database } from '../../db/database.js';
import { SqliteProcessStore } from '../../runtime/process-store.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { alive, eventually, kill, logDrift } from './drill-checks.js';
import type { StandIn } from './drill-server.js';
import { bootDrill, drillDirs, GIT_ENV } from './drill-world.js';

/**
 * P8-04 drill 1, at any moment: the drill server is killed (SIGKILL) at a point in its first life
 * chosen by a delay — while brains call tools, Stewards are spawned, worktrees are created, cards
 * and questions are made — and the next life must hold the invariants whatever was under way: the
 * tables are what the log says, recovery reopens each interrupted agent once, never two
 * Harmonizers, never two live Stewards on a task or two live Waykeepers on a project, and no
 * process of the killed run is left in its group.
 *
 * `pnpm test` runs a fixed spread of delays; `pnpm drills` (GALACTIC_DRILLS=<n>) runs n seeded
 * random ones — see `docs/tasks/notes/P8-04-drills.md`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'drill-server.ts');
const SERVER_DIR = resolve(HERE, '../../..');

const RUNS = Number(process.env['GALACTIC_DRILLS'] ?? 0);
/** Spread over the first life's build (≈0.4 s to load, ≈1 s to build on an M-series Mac). */
const FIXED_DELAYS_MS = [450, 650, 850, 1_100];

/** A small seeded generator, so a failing random run can be replayed (`GALACTIC_DRILLS_SEED`). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env['GALACTIC_DRILLS_SEED'] ?? Date.now() % 100_000);
const random = seeded(SEED);
/** Where the random kills land, `<from>-<to>` ms after the start (default the whole build). */
const [FROM, TO] = (process.env['GALACTIC_DRILLS_WINDOW'] ?? '300-2300').split('-').map(Number) as [
  number,
  number,
];
const delays =
  RUNS > 0
    ? Array.from({ length: RUNS }, () => FROM + Math.floor(random() * (TO - FROM)))
    : FIXED_DELAYS_MS;

const roots: string[] = [];
const dbs: Database[] = [];
const lives: { h: BrainHarness; supervisor: ProcessSupervisor }[] = [];
const started = new Set<number>();
afterEach(async () => {
  for (const life of lives.splice(0)) {
    await life.h.dispose().catch(() => {});
    await life.supervisor.dispose().catch(() => {});
  }
  for (const db of dbs.splice(0)) db.close();
  // A stand-in forked right before the kill writes its pid file a moment later: read them again.
  for (const r of roots) for (const s of standIns(r)) track(s);
  for (const p of started) kill(p);
  started.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function track(s: StandIn): void {
  started.add(-s.leader);
  started.add(s.child);
  if (s.escaped !== undefined) started.add(-s.escaped);
}

/** The stand-ins' pid files (written by the stand-ins themselves): what the kill may have left. */
function standIns(root: string): StandIn[] {
  return readdirSync(root)
    .filter((f) => f.endsWith('.pids.json'))
    .flatMap((f) => {
      try {
        return [JSON.parse(readFileSync(join(root, f), 'utf8')) as StandIn];
      } catch {
        return [];
      }
    });
}

describe(`kill -9 at any moment (P8-04 drill 1; seed ${SEED})`, () => {
  it.each(delays.map((ms, i) => [i + 1, ms]))(
    'run %i: killed %i ms after start, the next life holds the invariants',
    async (_run, delayMs) => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-anytime-')));
      roots.push(root);
      const child = spawn(process.execPath, ['--import', 'tsx', SERVER, root], {
        cwd: SERVER_DIR,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...GIT_ENV, HOME: join(root, 'home') },
      });
      started.add(-child.pid!);
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      await new Promise((r) => setTimeout(r, delayMs));
      kill(child.pid!);
      await exited;
      // Every stand-in's pids, for the clean-up and for the group check below. One forked just
      // before the kill writes its file a moment later.
      await new Promise((r) => setTimeout(r, 300));
      const left = standIns(root);
      for (const s of left) track(s);

      const dirs = drillDirs(root);
      if (!existsSync(dirs.db)) return; // killed before the database was created: nothing to lose
      const db = openDatabase(dirs.db);
      dbs.push(db);
      const store = new SqliteProcessStore(db);
      const rows = store.all();
      const supervisor = new ProcessSupervisor({ store });
      supervisor.reconcile();
      const h = bootDrill(dirs, db, { groups: supervisor });
      lives.push({ h, supervisor });
      expect(logDrift(h.log)).toEqual([]);

      const liveAtBoot = h.statuses
        .all()
        .filter((r) => !ENDED_STATES.has(r.state))
        .map((r) => r.agentId);
      // Agents caught between `agent.created` and `agent.spawned` have no status record yet; the
      // F3 fix (decision 101) interrupts and reopens them too.
      const neverStarted = h.log.tables.agents
        .all()
        .filter((a) => !isHarnessMeta(a.meta) && h.statuses.get(a.id) === undefined)
        .map((a) => a.id);
      const agentsAtBoot = h.log.tables.agents.all().length;
      const seq = h.log.currentSeq();
      const { report } = await h.recover();
      await startHarmonizer(h.composed, {
        runtime: 'fake',
        cwd: dirs.projects,
        deps: { projectsRoot: dirs.projects },
      });
      h.composed.announceRecovery(report);

      // Each agent the kill interrupted is reopened once, or reported as needing attention — except
      // one whose stop was under way: it ends `stopped` and is not reported.
      const expected = [...new Set([...liveAtBoot, ...neverStarted])].filter(
        (id) => h.statuses.get(id)?.state !== 'stopped',
      );
      expect([...report.resumed, ...report.needAttention].sort()).toEqual(expected.sort());
      const spawned = h.log
        .eventsSince(seq, Number.MAX_SAFE_INTEGER)
        .filter(({ event }) => event.type === 'agent.spawned')
        .map(({ event }) => (event as Extract<Event, { type: 'agent.spawned' }>).agentId);
      expect(new Set(spawned).size).toBe(spawned.length);
      // Recovery never creates an agent; the boot start adds a Harmonizer only when none came back.
      const created = h.log.tables.agents.all().length - agentsAtBoot;
      expect(created).toBeLessThanOrEqual(1);
      if (created === 1) {
        expect(h.log.tables.agents.all().at(-1)?.role).toBe('harmonizer');
      }

      // No agent is left in limbo: each has a state (running, interrupted or ended).
      for (const a of h.log.tables.agents.all()) {
        expect(h.statuses.get(a.id), `agent ${a.id} (${a.role}) has no state`).toBeDefined();
      }

      // One of each, whatever the kill interrupted.
      const live = h.runtime.liveAgents();
      expect(live.filter((a) => a.role === 'harmonizer').length).toBeLessThanOrEqual(1);
      const once = (key: (a: (typeof live)[number]) => Id | undefined) => {
        const keys = live.map(key).filter((k): k is Id => k !== undefined);
        expect(new Set(keys).size).toBe(keys.length);
      };
      once((a) => (a.role === 'steward' ? a.taskId : undefined));
      once((a) => (a.role === 'waykeeper' ? a.projectId : undefined));

      // The killed run's process groups are gone (reconciled), whatever was recorded.
      for (const s of left) {
        expect(
          await eventually(() => !alive(s.child) && !alive(s.leader)),
          `stand-in ${JSON.stringify(s)} left running; PID table at boot: ${JSON.stringify(rows)}`,
        ).toBe(true);
      }
      expect(logDrift(h.log)).toEqual([]);
      if (RUNS > 0) {
        // The drill log's line for this run: where the kill landed and what came back.
        const t = h.log.tables;
        console.info(
          `run ${_run}: killed at ${delayMs} ms — seq ${seq}, agents ${agentsAtBoot} ` +
            `(${liveAtBoot.length} live, ${neverStarted.length} never started), tasks ${t.tasks.all().length}, cards ` +
            `${t.proposals.all().length}, open questions ` +
            `${t.questions.all().filter((q) => q.status === 'open').length}, stand-ins ` +
            `${left.length} → resumed ${report.resumed.length}, need attention ` +
            `${report.needAttention.length}, Harmonizer ${created === 1 ? 'started' : 'resumed'}`,
        );
      }
    },
    60_000,
  );
});
