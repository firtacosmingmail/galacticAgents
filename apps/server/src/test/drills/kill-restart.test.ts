import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Id } from '@galactic/protocol';
import { startHarmonizer } from '../../brains/harmonizer/index.js';
import { PromotionFlow } from '../../brains/promotion.js';
import { waykeeperDefinition } from '../../brains/waykeeper/index.js';
import type { BrainHarness } from '../../brains/testing/index.js';
import { openDatabase, type Database } from '../../db/database.js';
import { SqliteProcessStore } from '../../runtime/process-store.js';
import { bootTime, ProcessSupervisor, type ReconcileResult } from '../../runtime/supervisor.js';
import { alive, eventually, kill, logDrift } from './drill-checks.js';
import type { Ready } from './drill-server.js';
import { bootDrill, drillDirs, GIT_ENV, openQuestionsOf, USER } from './drill-world.js';

/**
 * P8-04 crash drills 1 and 2: a real server process, killed for real.
 *
 * The drill server (`drill-server.ts`, a child process on the fake adapter and the scripted fake
 * LLM, in a temporary directory) runs a hierarchy mid-project — the Harmonizer with a question to
 * the user, a Waykeeper running two Stewards (one working, one waiting for its clarification), a
 * card waiting for the user, a second Waykeeper in the middle of its planning turn — and the two
 * Stewards have real process groups (stand-in CLIs). The drill kills it with SIGKILL (drill 1) or
 * kills it and every process group it left (drill 2, "the machine rebooted"), then boots the second
 * life over the same SQLite file in this process the way `index.ts` does (reconcile the PID table,
 * compose, define the brains, recover, start the Harmonizer, announce, start the promotion flow)
 * and checks: no data loss, no duplicate spawn, every agent resumed (supervisors first), questions
 * where the rules put them, the Harmonizer's report, and the killed run's processes handled per
 * decision 76. The log of every drill run is in `docs/tasks/notes/P8-04-drills.md`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'drill-server.ts');
/** `apps/server`: `--import tsx` resolves from here. */
const SERVER_DIR = resolve(HERE, '../../..');
const READY_MS = 60_000;
const LONG = { timeoutMs: 15_000 };

const roots: string[] = [];
const dbs: Database[] = [];
const lives: { h: BrainHarness; supervisor: ProcessSupervisor; promotions?: PromotionFlow }[] = [];
/** Every pid and process group this file started, killed in `afterEach` (and only those). */
const started = new Set<number>();

afterEach(async () => {
  for (const life of lives.splice(0).reverse()) {
    life.promotions?.stop();
    await life.h.dispose().catch(() => {});
    await life.supervisor.dispose().catch(() => {});
  }
  for (const db of dbs.splice(0)) db.close();
  for (const p of started) kill(p);
  started.clear();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-drill-')));
  roots.push(root);
  return root;
}

/** Starts the drill server and waits for its first life; records every pid it reports. */
async function startDrillServer(root: string): Promise<{ child: ChildProcess; ready: Ready }> {
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER, root], {
    cwd: SERVER_DIR,
    // Its own process group, so drill 2 can take the server's whole group at once.
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV, HOME: join(root, 'home'), GALACTIC_LOG: 'silent' },
  });
  if (child.pid) started.add(-child.pid);
  let output = '';
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`drill server not ready after ${READY_MS} ms:\n${output}`)),
      READY_MS,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('DRILL READY')) {
        clearTimeout(timer);
        resolvePromise();
      } else if (output.includes('DRILL FAILED')) {
        clearTimeout(timer);
        reject(new Error(output));
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`drill server exited (${code}) before it was ready:\n${output}`));
    });
  });
  const ready = JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')) as Ready;
  for (const s of Object.values(ready.standIns)) {
    started.add(-s.leader);
    started.add(s.child);
    if (s.escaped !== undefined) started.add(-s.escaped);
  }
  return { child, ready };
}

/** SIGKILL to the drill server, and the wait for the OS to have it gone. */
async function killServer(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  kill(child.pid!);
  await exited;
}

interface SecondLife {
  h: BrainHarness;
  supervisor: ProcessSupervisor;
  reconciled: ReconcileResult;
  /** Drift between the tables and the log right after the crash, before recovery wrote anything. */
  driftAtBoot: string[];
  seqBefore: number;
  report: { resumed: Id[]; needAttention: Id[] };
  harmonizer: { status: string; agentId: Id };
  said: string[];
}

/** Boots over the killed server's database the way `index.ts` does. */
async function secondLife(root: string, ready: Ready): Promise<SecondLife> {
  const dirs = drillDirs(root);
  const db = openDatabase(dirs.db);
  dbs.push(db);
  // The PID table first, before anything is resumed (index.ts).
  const supervisor = new ProcessSupervisor({ store: new SqliteProcessStore(db) });
  const reconciled = supervisor.reconcile();
  const h = bootDrill(dirs, db, { groups: supervisor });
  const life: (typeof lives)[number] = { h, supervisor };
  lives.push(life);
  const driftAtBoot = logDrift(h.log);

  // The resumed brains' "model": the Harmonizer relays the recovery line; the Docs Waykeeper
  // finishes the plan it was making when the server died.
  const said: string[] = [];
  h.script('harmonizer', { strict: false }).once(/the server restarted — recovered/, (t) => {
    const line = /recovered: (\d+) agents? resumed, (\d+) needs? attention/.exec(t.prompt);
    const text = line ? `recovered: ${line[1]} resumed, ${line[2]} need attention` : t.prompt;
    said.push(text);
    t.say(text);
  });
  h.script({ role: 'waykeeper', projectId: ready.docs }, { strict: false }).once(
    /your session as the waykeeper was resumed/,
    (t) =>
      t.call('plan_tasks', {
        summary: 'The user guide',
        tasks: [{ description: 'write the guide' }, { description: 'review the guide' }],
      }),
  );

  const seqBefore = h.log.currentSeq();
  const { report } = await h.recover();
  const hq = await startHarmonizer(h.composed, {
    runtime: 'fake',
    cwd: dirs.projects,
    deps: { projectsRoot: dirs.projects },
  });
  h.composed.announceRecovery(report);
  life.promotions = new PromotionFlow({
    log: h.log,
    commands: h.commands,
    liveAgents: () => h.runtime.liveAgents(),
    startWaykeeper: async (input) => ({
      agentId: (await h.composed.startBrain(waykeeperDefinition(), input)).agentId,
    }),
  }).start();
  return {
    h,
    supervisor,
    reconciled,
    driftAtBoot,
    seqBefore,
    report,
    harmonizer: { status: hq.status, agentId: hq.agentId },
    said,
  };
}

const spawnedAfter = (h: BrainHarness, seq: number): Id[] =>
  h.log
    .eventsSince(seq, Number.MAX_SAFE_INTEGER)
    .filter(({ event }) => event.type === 'agent.spawned')
    .map(({ event }) => (event as Extract<Event, { type: 'agent.spawned' }>).agentId);

/** The checks every restart drill shares: no data loss, no duplicates, everyone back, the report. */
async function verifyRecovery(life: SecondLife, ready: Ready): Promise<void> {
  const { h, report, seqBefore } = life;
  const all = [ready.hq, ready.w1, ready.w2, ready.s1, ready.s2];

  // No data loss: what the dead server committed is exactly what the log says.
  expect(life.driftAtBoot).toEqual([]);

  // Every agent came back from its session; nothing needs attention.
  expect([...report.resumed].sort()).toEqual([...all].sort());
  expect(report.needAttention).toEqual([]);
  // One spawn each (no duplicate), supervisors first: the Harmonizer, its Waykeepers, the Stewards.
  const spawned = spawnedAfter(h, seqBefore);
  expect([...spawned].sort()).toEqual([...all].sort());
  expect(spawned[0]).toBe(ready.hq);
  expect(new Set(spawned.slice(1, 3))).toEqual(new Set([ready.w1, ready.w2]));
  expect(new Set(spawned.slice(3))).toEqual(new Set([ready.s1, ready.s2]));
  // The boot-time start finds the resumed Harmonizer: no second one (decision 32).
  expect(life.harmonizer).toEqual({ status: 'running', agentId: ready.hq });

  // The asking Steward asks again, held by its resumed Waykeeper (decision 21, 44).
  await h.until(() => h.statuses.get(ready.s2)?.state === 'waiting_for_input', {
    ...LONG,
    what: 'the asking Steward to ask again',
  });
  // The Harmonizer tells the user what was recovered (decision 46).
  await h.until(() => life.said.length > 0, { ...LONG, what: 'the recovery report' });
  expect(life.said).toEqual(['recovered: 5 resumed, 0 need attention']);
  // The Docs Waykeeper finishes its plan: one card, not two.
  await h.until(() => h.log.tables.proposals.all().length === 2, {
    ...LONG,
    what: "the Docs Waykeeper's plan",
  });

  for (const id of all) {
    expect(['working', 'idle', 'waiting_for_input']).toContain(h.statuses.get(id)?.state);
  }
  expect(h.statuses.get(ready.s1)?.state).toBe('working');
  const questions = h.log.tables.questions.all();
  expect(questions.find((q) => q.id === ready.s2Question)?.status).toBe('cancelled');
  const reasked = openQuestionsOf(h, ready.s2);
  expect(reasked).toHaveLength(1);
  expect(questions.find((q) => q.id === reasked[0])?.holder).toEqual({
    type: 'agent',
    id: ready.w1,
  });
  // The Harmonizer's question to the user survived (decision 45); the card still waits.
  expect(questions.find((q) => q.id === ready.hqQuestion)?.status).toBe('open');
  expect(h.log.tables.proposals.get(ready.card)?.state).toBe('pending');
  expect(h.log.tables.proposals.all().filter((p) => p.id !== ready.card)).toMatchObject([
    { state: 'pending' },
  ]);

  // Nothing duplicated: the same agents, one Harmonizer, one Steward per task.
  expect(h.log.tables.agents.all()).toHaveLength(ready.agents);
  expect(h.runtime.liveAgents().filter((a) => a.role === 'harmonizer')).toHaveLength(1);
  expect(spawnedAfter(h, seqBefore)).toHaveLength(all.length);
  // And still consistent after recovery's own writes.
  expect(logDrift(h.log)).toEqual([]);
}

describe('crash drills (P8-04)', () => {
  it('drill 1 — kill -9 mid-project: everything resumes once, the killed run’s processes are handled', async () => {
    const root = tempRoot();
    const { child, ready } = await startDrillServer(root);
    const s1 = ready.standIns[ready.s1]!;
    const s2 = ready.standIns[ready.s2]!;
    for (const pid of [s1.leader, s1.child, s1.escaped!, s2.leader, s2.child]) {
      expect(alive(pid)).toBe(true);
    }

    await killServer(child);
    // The CLI that reads its conversation from the server exits on EOF; its group lives on.
    expect(await eventually(() => !alive(s2.leader))).toBe(true);
    expect(alive(s2.child)).toBe(true);
    expect(alive(s1.leader)).toBe(true);

    const life = await secondLife(root, ready);
    // Decision 76 / corner case 4: the killed run's CLIs and their groups are killed at startup
    // (a resumed agent gets a new process); the escaped process in S1's worktree is left to its
    // Steward, which comes back.
    expect([...life.reconciled.orphans].sort()).toEqual([ready.s1, ready.s2].sort());
    expect(life.reconciled.dead).toEqual([]);
    expect(
      await eventually(() => [s1.leader, s1.child, s2.child].every((pid) => !alive(pid))),
    ).toBe(true);
    expect(alive(s1.escaped!)).toBe(true);

    await verifyRecovery(life, ready);

    // The escaped process is still S1's (marked, in its worktree, started in its session) …
    const listed = await life.h.composed.processes!.list(ready.s1);
    expect(listed.processes.map((p) => [p.pid, p.why])).toContainEqual([s1.escaped, 'worktree']);
    // … and the safety net stops it once S1 ends.
    await life.h.commands.stopAgent(ready.s1, USER);
    expect(await eventually(() => !alive(s1.escaped!), 15_000)).toBe(true);
    await life.h.composed.processes!.idle();
    const swept = life.h.log
      .eventsSince(life.seqBefore, Number.MAX_SAFE_INTEGER)
      .map(({ event }) => event)
      .filter((e) => e.type === 'agent.processes_stopped');
    expect(swept).toMatchObject([
      { agentId: ready.s1, pids: [s1.escaped], sweep: 'agent_ended', by: { type: 'system' } },
    ]);
  }, 120_000);

  it('drill 2 — "reboot": the server and every process it left die at once; a recycled pid is never killed', async () => {
    const root = tempRoot();
    const { child, ready } = await startDrillServer(root);
    const s1 = ready.standIns[ready.s1]!;
    const s2 = ready.standIns[ready.s2]!;

    // The power goes: the server's group and every group it started, all at once.
    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    for (const group of [child.pid!, s1.leader, s1.escaped!, s2.leader]) kill(-group);
    await exited;
    const everything = [s1.leader, s1.child, s1.escaped!, s2.leader, s2.child];
    expect(await eventually(() => everything.every((pid) => !alive(pid)))).toBe(true);

    // After a reboot the PID table's rows are from the previous boot and their pids may name
    // anything. Rewrite them so (bootAt an hour before this boot), and point S1's at a live
    // process of ours with the same command name and start time: only the boot tells them apart.
    const innocent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
      detached: true,
      stdio: 'ignore',
    });
    started.add(-innocent.pid!);
    const db = openDatabase(drillDirs(root).db);
    const earlierBoot = new Date(Date.parse(bootTime()) - 60 * 60_000).toISOString();
    const rows = db
      .prepare("SELECT agent_id, meta FROM agent_processes WHERE status = 'running'")
      .all() as { agent_id: string; meta: string }[];
    expect(rows.map((r) => r.agent_id).sort()).toEqual([ready.s1, ready.s2].sort());
    for (const row of rows) {
      const meta = { ...(JSON.parse(row.meta) as object), bootAt: earlierBoot };
      db.prepare('UPDATE agent_processes SET meta = ? WHERE agent_id = ?').run(
        JSON.stringify(meta),
        row.agent_id,
      );
    }
    db.prepare('UPDATE agent_processes SET pid = ?, started_at = ? WHERE agent_id = ?').run(
      innocent.pid,
      new Date().toISOString(),
      ready.s1,
    );
    db.close();

    const life = await secondLife(root, ready);
    // Nothing of the old boot is alive or ours: both rows are dead, nothing is killed.
    expect([...life.reconciled.dead].sort()).toEqual([ready.s1, ready.s2].sort());
    expect(life.reconciled.orphans).toEqual([]);
    expect(alive(innocent.pid!)).toBe(true);

    await verifyRecovery(life, ready);
    // No process from the old boot is attributed to the resumed Steward.
    const listed = await life.h.composed.processes!.list(ready.s1);
    expect(listed.processes.map((p) => p.pid)).not.toContain(innocent.pid);
    expect(alive(innocent.pid!)).toBe(true);
  }, 120_000);
});
