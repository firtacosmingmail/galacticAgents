import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, Agent, EventEnvelope, Id } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { AGENT_ID_ENV, type ProcEntry } from './process-attribution.js';
import { osProcessTable, type ProcessTable } from './process-table.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';
import { ProcessSupervisor } from './supervisor.js';

/**
 * P4-14 with real processes: a stand-in for a Steward's CLI (a node process started through the
 * supervisor in the task's worktree — its session) that starts a server in its group and a child
 * that escapes the group (`detached`: its own session), plus orphans started like `nohup … &` from
 * a shell that exited — inside and outside the worktree, with the Steward's agent marker, another
 * agent's or none (the user's own daemon) — and a child of the test (the "server") itself.
 * Every process carries a per-run command-line tag; `afterEach` kills every pid it saw and
 * `afterAll` kills anything still carrying the tag.
 */

const POSIX = process.platform !== 'win32';
const NODE = process.execPath;
const MARK = `p414-${process.pid}`;
const USER: Actor = { type: 'user' };
const IDLE = 'setInterval(() => {}, 1e6)';

/** The CLI stand-in: a server in its group, a detached child, then it stays. */
const LEADER = `
const { spawn } = require('child_process');
const tag = process.argv[1];
const srv = spawn(process.execPath, ['-e', "require('http').createServer(() => {}).listen(0, '127.0.0.1', function () { process.stdout.write('PORT ' + this.address().port + '\\\\n'); }); ${IDLE}", tag + '-ingroup'], { stdio: ['ignore', 'pipe', 'ignore'] });
srv.stdout.on('data', (d) => process.stdout.write(d));
const esc = spawn(process.execPath, ['-e', '${IDLE}', tag + '-escaped'], { detached: true, stdio: 'ignore' });
esc.unref();
process.stdout.write('PIDS ' + srv.pid + ' ' + esc.pid + '\\n');
${IDLE};
`;

let tmp: string;
let worktree: string;
let elsewhere: string;
let supervisor: ProcessSupervisor;
let composed: ComposedRuntime;
const seen = new Set<number>();
const children: ChildProcess[] = [];

function killAll(): void {
  for (const pid of seen) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  seen.clear();
  for (const c of children.splice(0)) c.kill('SIGKILL');
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-procs-')));
  worktree = join(tmp, 'proj', '.galactic', 'worktrees', 't-1');
  elsewhere = join(tmp, 'elsewhere');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(elsewhere);
  supervisor = new ProcessSupervisor({ defaults: { graceMs: 500, termMs: 500 } });
  composed = composeRuntime(openDatabase(':memory:'), {
    processes: { groups: supervisor, termMs: 1_000, settleMs: 3_000 },
  });
});

afterEach(async () => {
  try {
    await composed.dispose();
  } finally {
    await supervisor.dispose({ graceMs: 100, termMs: 100 }).catch(() => undefined);
    killAll();
    rmSync(tmp, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (!POSIX) return;
  try {
    execFileSync('pkill', ['-9', '-f', MARK]);
  } catch {
    // nothing left (pkill exits 1)
  }
});

async function steward(extra: { taskId?: Id } = {}): Promise<Agent> {
  const result = await composed.runtime.spawn({
    role: 'steward',
    runtime: 'fake',
    prompt: 'scenario:echo',
    cwd: worktree,
    ...extra,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.agent;
}

/** Starts the CLI stand-in for `agentId`; resolves with its pids and the in-group server's port. */
async function leader(agentId: Id) {
  let out = '';
  const proc = await supervisor.spawn({
    agentId,
    command: NODE,
    args: ['-e', LEADER, `${MARK}-leader`],
    cwd: worktree,
    onStdout: (chunk) => (out += chunk),
  });
  seen.add(proc.pid);
  const deadline = Date.now() + 5_000;
  for (;;) {
    const pids = /PIDS (\d+) (\d+)/.exec(out);
    const port = /PORT (\d+)/.exec(out);
    if (pids && port) {
      const [ingroup, escaped] = [Number(pids[1]), Number(pids[2])];
      seen.add(ingroup);
      seen.add(escaped);
      return { pid: proc.pid, ingroup, escaped, port: Number(port[1]) };
    }
    if (Date.now() > deadline) throw new Error(`the leader did not start: ${out}`);
    await sleep(20);
  }
}

/**
 * `nohup … &` from a shell that exits: the process is orphaned (reparented to init/launchd). With
 * `agentId`, it carries that agent's marker (`GALACTIC_AGENT_ID`), as everything an agent starts
 * through the supervisor does; without, it is like the user's own daemon.
 */
async function orphan(
  cwd: string,
  tag: string,
  agentId?: Id,
  script: string = IDLE,
): Promise<number> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[AGENT_ID_ENV];
  if (agentId) env[AGENT_ID_ENV] = agentId;
  const sh = spawn(
    '/bin/sh',
    ['-c', `"${NODE}" -e "${script}" ${MARK}-${tag} >/dev/null 2>&1 & echo $!`],
    {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  children.push(sh);
  let out = '';
  sh.stdout.on('data', (d: Buffer) => (out += d.toString()));
  await new Promise((r) => sh.once('close', r));
  const pid = Number(out.trim());
  seen.add(pid);
  await until(async () => (await row(pid))?.ppid !== sh.pid, 'orphan reparented');
  return pid;
}

/** A plain child of the test process (the "server") — never anyone's, even marked. */
function serverChild(cwd: string, agentId?: Id): number {
  const env = { ...process.env, ...(agentId ? { [AGENT_ID_ENV]: agentId } : {}) };
  const child = spawn(NODE, ['-e', IDLE, `${MARK}-server-child`], { cwd, env, stdio: 'ignore' });
  children.push(child);
  seen.add(child.pid!);
  return child.pid!;
}

const table: ProcessTable = osProcessTable();
async function row(pid: number): Promise<ProcEntry | undefined> {
  return (await table.list())?.find((p) => p.pid === pid && !p.zombie);
}
const running = async (pid: number) => (await row(pid)) !== undefined;

async function until(check: () => Promise<boolean>, what: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const stoppedEvents = (): EventEnvelope[] =>
  composed.log.eventsSince(0, 10_000).filter((e) => e.event.type === 'agent.processes_stopped');

describe.skipIf(!POSIX)('a Steward’s processes (P4-14, real processes)', () => {
  it('lists its group, what escaped it and its marked worktree orphans — not its CLI, nor anything else', async () => {
    const st = await steward();
    const cli = await leader(st.id);
    const inside = await orphan(worktree, 'orphan-in', st.id);
    const outside = await orphan(elsewhere, 'orphan-out', st.id);
    // The user's own daemon in the worktree during the session (tmux, `code .`, `nohup … &`).
    const users = await orphan(worktree, 'orphan-user');
    const others = await orphan(worktree, 'orphan-other', 'a-someone-else');
    const child = serverChild(worktree, st.id);

    const listed = await composed.processes!.list(st.id);
    expect(listed.supported).toBe(true);
    const byPid = new Map(listed.processes.map((p) => [p.pid, p]));
    expect([...byPid.keys()].sort()).toEqual([cli.ingroup, cli.escaped, inside].sort());
    // The Steward runs: what its CLI started directly is held.
    expect(byPid.get(cli.ingroup)).toMatchObject({ why: 'group', ports: [cli.port], held: true });
    expect(byPid.get(cli.escaped)).toMatchObject({ why: 'descendant', cwd: worktree, held: true });
    expect(byPid.get(inside)).toMatchObject({ why: 'worktree', cwd: worktree, ports: [] });
    expect(byPid.get(inside)).not.toHaveProperty('held');
    // Command lines are clipped (and redacted) before they leave the server.
    expect(byPid.get(cli.ingroup)!.command).toMatch(/^\S*node -e require\('http'\).*…$/);
    expect(byPid.get(cli.ingroup)!.command.length).toBeLessThanOrEqual(200);
    expect(byPid.get(inside)!.command).toContain(`${MARK}-orphan-in`);
    for (const never of [cli.pid, outside, users, others, child, process.pid])
      expect(byPid.has(never)).toBe(false);

    // One snapshot for several Stewards answers the same.
    const [many] = await composed.processes!.listMany([st.id]);
    expect(many!.processes.map((p) => p.pid).sort()).toEqual([...byPid.keys()].sort());
  });

  it('stops only attributable pids (refusing others without signalling anything); held ones only by name', async () => {
    const st = await steward();
    const cli = await leader(st.id);
    const inside = await orphan(worktree, 'orphan-in', st.id);
    const outside = await orphan(elsewhere, 'orphan-out', st.id);
    const users = await orphan(worktree, 'orphan-user');
    const child = serverChild(worktree);

    for (const foreign of [outside, users, child, cli.pid]) {
      await expect(
        composed.processes!.stop(st.id, { pids: [cli.ingroup, foreign], by: USER }),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    // A running Steward's processes are never stopped wholesale.
    await expect(composed.processes!.stop(st.id, { by: USER })).rejects.toMatchObject({
      code: 'invalid',
    });
    for (const pid of [cli.ingroup, cli.escaped, inside, outside, users, child, cli.pid])
      expect(await running(pid)).toBe(true);

    const one = await composed.processes!.stop(st.id, { pids: [inside], by: USER });
    expect(one).toMatchObject({ stopped: [inside], alive: [] });
    expect(await running(inside)).toBe(false);
    // Held: stopped only when named.
    const held = await composed.processes!.stop(st.id, { pids: [cli.ingroup], by: USER });
    expect(held).toMatchObject({ stopped: [cli.ingroup], alive: [] });
    expect(await running(cli.ingroup)).toBe(false);
    expect(await running(cli.escaped)).toBe(true);

    // The Steward's CLI, the outside orphan, the user's daemon and the server's child are untouched.
    for (const pid of [cli.pid, outside, users, child]) expect(await running(pid)).toBe(true);

    const events = stoppedEvents().map((e) => e.event);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ agentId: st.id, pids: [inside], by: USER });
    expect(events[0]).not.toHaveProperty('sweep');
  });

  it('sends SIGKILL to what ignores SIGTERM', async () => {
    const st = await steward();
    await leader(st.id);
    const pid = await orphan(
      worktree,
      'stubborn',
      st.id,
      `process.on('SIGTERM', () => {}); ${IDLE}`,
    );
    await sleep(300); // its SIGTERM handler is installed

    const result = await composed.processes!.stop(st.id, { pids: [pid], by: USER });
    expect(result).toMatchObject({ stopped: [pid], forced: [pid], alive: [] });
    expect(stoppedEvents()[0]!.event).toMatchObject({ forced: [pid] });
  });

  it('sweeps what is left when the Steward ends, after the supervisor reaped its group', async () => {
    const st = await steward();
    const cli = await leader(st.id);
    const inside = await orphan(worktree, 'orphan-in', st.id);
    const outside = await orphan(elsewhere, 'orphan-out', st.id);
    const users = await orphan(worktree, 'orphan-user');

    // The adapter stops the CLI: its group (the in-group server) goes with it, the escaped child
    // (now an orphan carrying the marker it inherited) and the orphan stay behind.
    await supervisor.stop(st.id, { graceMs: 200, termMs: 500 });
    expect(await running(cli.ingroup)).toBe(false);
    expect(await running(cli.escaped)).toBe(true);

    await composed.runtime.stop(st.id, USER);
    await until(async () => stoppedEvents().length > 0, 'the sweep');
    await composed.processes!.idle();
    for (const pid of [cli.escaped, inside]) expect(await running(pid)).toBe(false);
    for (const pid of [outside, users]) expect(await running(pid)).toBe(true);
    expect(stoppedEvents()[0]!.event).toMatchObject({
      agentId: st.id,
      sweep: 'agent_ended',
      by: { type: 'system' },
    });
    expect((stoppedEvents()[0]!.event as { pids: number[] }).pids.sort()).toEqual(
      [cli.escaped, inside].sort(),
    );
  });

  it('never takes a worktree process that was running before the Steward’s session, even marked', async () => {
    const st = await steward();
    const before = await orphan(worktree, 'orphan-before', st.id);
    await sleep(2_200); // past lstart's one-second resolution and the slack
    await leader(st.id);
    const listed = await composed.processes!.list(st.id);
    expect(listed.processes.map((p) => p.pid)).not.toContain(before);
    await supervisor.stop(st.id, { graceMs: 200, termMs: 500 });
    await composed.runtime.stop(st.id, USER);
    await composed.processes!.idle();
    expect(await running(before)).toBe(true);
    expect(stoppedEvents().flatMap((e) => (e.event as { pids: number[] }).pids)).not.toContain(
      before,
    );
  });
});

describe('the sweeps and the stop path (P4-14, a scripted process table)', () => {
  const SESSION_START = Date.now() - 60_000;
  const during = SESSION_START + 5_000;

  /** Orphans in the worktree (pid → start time) carrying `marker()`; a SIGTERM ends one. */
  function scriptedTable(marker: () => Id) {
    const alive = new Map<number, number>();
    const killed: number[] = [];
    const signals: [number, string][] = [];
    let lists = 0;
    const hooks: {
      onList?: (n: number) => void;
      startOf?: (pid: number, n: number) => number;
    } = {};
    const table: ProcessTable = {
      list: () => {
        lists++;
        hooks.onList?.(lists);
        return Promise.resolve([
          { pid: 1, ppid: 0, pgid: 1, uid: 501, startedAt: 0, command: '/sbin/launchd' },
          ...[...alive].map(([pid, startedAt]) => ({
            pid,
            ppid: 1,
            pgid: pid,
            uid: 501,
            startedAt: hooks.startOf?.(pid, lists) ?? startedAt,
            command: `job ${pid}`,
          })),
        ]);
      },
      cwds: (ps) => Promise.resolve(new Map(ps.map((pid) => [pid, worktree]))),
      markers: (ps) => Promise.resolve(new Map(ps.map(({ pid }) => [pid, marker()]))),
      ports: () => Promise.resolve(new Map()),
      kill: (pid, sig) => {
        signals.push([pid, sig]);
        if (!alive.has(pid)) return false;
        if (sig === 'SIGTERM') {
          alive.delete(pid);
          killed.push(pid);
        }
        return true;
      },
    };
    return { table, alive, killed, signals, hooks };
  }

  async function scripted() {
    let markerId: Id = '';
    const fake = scriptedTable(() => markerId);
    await composed.dispose();
    composed = composeRuntime(openDatabase(':memory:'), {
      processes: {
        table: fake.table,
        self: { pid: 4, uid: 501 },
        termMs: 200,
        settleMs: 200,
        groups: {
          agentGroups: () => [],
          agentSessions: () => [{ start: SESSION_START, end: Date.now() }],
        },
      },
    });
    const task = (await composed.commands.createTask({ description: 'a standalone job' })).value;
    const st = await steward({ taskId: task.id });
    markerId = st.id;
    return { fake, task, st };
  }

  /** Ends the Steward and lets its (empty) sweep settle. */
  async function ended() {
    const s = await scripted();
    await composed.runtime.stop(s.st.id, USER);
    await composed.processes!.idle();
    s.fake.signals.length = 0;
    return s;
  }

  it("sweeps a closed task's ended Stewards, never a live one, and logs it once", async () => {
    const { fake, task, st } = await scripted();
    fake.alive.set(9001, during);

    // Alive and idle: its processes are its supervisor's call, not the server's.
    await composed.processes!.idle();
    expect(fake.killed).toEqual([]);

    // It ends: the sweep stops its orphan, once.
    await composed.runtime.stop(st.id, USER);
    await composed.processes!.idle();
    expect(fake.killed).toEqual([9001]);
    expect(stoppedEvents().map((e) => e.event)).toMatchObject([{ sweep: 'agent_ended' }]);

    // The task closes later and a leftover of its session is still there: swept as task_closed.
    fake.alive.set(9002, during);
    await composed.commands.closeTask(task.id, USER);
    await composed.processes!.idle();
    expect(fake.killed).toEqual([9001, 9002]);
    expect(stoppedEvents().map((e) => e.event)).toMatchObject([
      { sweep: 'agent_ended' },
      { sweep: 'task_closed', pids: [9002] },
    ]);
  });

  it('a sweep checks again right before the signals that the Steward did not come back', async () => {
    const { fake, st } = await ended();
    fake.alive.set(9003, during);
    // The Steward is resumed while the sweep reads the table (after its first liveness check).
    let reads = 0;
    fake.hooks.onList = () => {
      if (++reads !== 1) return;
      composed.statuses.fold({
        seq: 10_000,
        at: new Date().toISOString(),
        event: {
          type: 'agent.spawned',
          agentId: st.id,
          role: 'steward',
          runtime: 'fake',
          bodyId: st.bodyId,
          sessionRef: 'fake:resumed',
        },
      });
    };
    const result = await composed.processes!.sweep(st.id, 'task_closed');
    expect(result).toMatchObject({ stopped: [] });
    expect(fake.signals).toEqual([]);
    expect(fake.alive.has(9003)).toBe(true);
  });

  it('re-reads the table right before SIGTERM: a pid whose start time changed is left alone', async () => {
    const { fake, st } = await ended();
    fake.alive.set(9004, during);
    fake.alive.set(9005, during);
    // From the second read of this stop on, 9005 is another process under the same pid.
    let reads = 0;
    fake.hooks.onList = () => reads++;
    fake.hooks.startOf = (pid) => (pid === 9005 && reads >= 2 ? during + 7_000 : during);
    const result = await composed.processes!.stop(st.id, { pids: [9004, 9005], by: USER });
    expect(result).toMatchObject({ stopped: [9004], skipped: [9005] });
    expect(fake.signals.map(([pid]) => pid)).not.toContain(9005);
  });

  it('a process started in the snapshot’s own second is looked at again after it', async () => {
    const { fake, st } = await ended();
    fake.alive.set(9006, Math.floor(Date.now() / 1000) * 1000);
    const result = await composed.processes!.stop(st.id, { pids: [9006], by: USER });
    // Re-attributed once that second was over: no longer ambiguous, stopped.
    expect(result).toMatchObject({ stopped: [9006] });
    // One that every read shows as started in that read's own second is skipped, never signalled.
    fake.alive.set(9007, 0);
    fake.hooks.startOf = (pid) => (pid === 9007 ? Math.floor(Date.now() / 1000) * 1000 : during);
    fake.signals.length = 0;
    const again = await composed.processes!.stop(st.id, { pids: [9007], by: USER });
    expect(again).toMatchObject({ stopped: [], skipped: [9007] });
    expect(fake.signals).toEqual([]);
  });

  it('refuses a non-Steward and an unknown agent', async () => {
    await expect(composed.processes!.list('a-nobody')).rejects.toMatchObject({ code: 'not_found' });
    const brain = await composed.runtime.spawn({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: tmp,
    });
    if (!brain.ok) throw new Error(brain.reason);
    await expect(composed.processes!.list(brain.agent.id)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});
