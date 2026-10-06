import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { attribute } from './process-attribution.js';
import { MemoryProcessStore, SqliteProcessStore } from './process-store.js';
import {
  INHERITED_ENV,
  ProcessSupervisor,
  bootTime,
  commandName,
  isAlive,
  isRunning,
  parseLstart,
  processName,
  processStartTime,
  type ProcessOutcome,
  type ProcessSpec,
} from './supervisor.js';

const NODE = process.execPath;
const node = (script: string, extra: Partial<ProcessSpec> = {}): ProcessSpec => ({
  agentId: extra.agentId ?? 'a-1',
  command: NODE,
  args: ['-e', script],
  cwd: process.cwd(),
  ...extra,
});

/** A child that stays alive and reports which signals it received on stdout. */
const LOITER = (ignore: string[]) => `
  ${ignore.map((s) => `process.on('${s}', () => console.log('ignored ${s}'));`).join('\n')}
  console.log('ready');
  setInterval(() => {}, 1000);
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await sleep(20);
  }
}

/** Outcomes reported so far, with a way to wait for one (the supervisor has no event stream). */
function outcomes() {
  const items: ProcessOutcome[] = [];
  const watchers = new Set<() => void>();
  return {
    items,
    push: (o: ProcessOutcome) => {
      items.push(o);
      for (const w of [...watchers]) w();
    },
    waitFor(predicate: (items: ProcessOutcome[]) => boolean, timeoutMs = 5_000) {
      if (predicate(items)) return Promise.resolve(items);
      return new Promise<ProcessOutcome[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error(`timed out; outcomes: ${JSON.stringify(items)}`));
        }, timeoutMs);
        const check = () => {
          if (!predicate(items)) return;
          clearTimeout(timer);
          watchers.delete(check);
          resolve(items);
        };
        watchers.add(check);
      });
    },
  };
}

const supervisors: ProcessSupervisor[] = [];
function makeSupervisor(opts: ConstructorParameters<typeof ProcessSupervisor>[0] = {}) {
  const events = outcomes();
  const s = new ProcessSupervisor({
    defaults: { graceMs: 300, termMs: 300 },
    onOutcome: events.push,
    ...opts,
  });
  supervisors.push(s);
  return { s, events };
}
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.dispose();
});

describe('ProcessSupervisor — spawn and exit detection', () => {
  it('captures stdio and reports a clean exit as `exited`, never as a crash', async () => {
    const { s, events } = makeSupervisor();
    const out: string[] = [];
    const proc = await s.spawn(
      node(`console.log('hello'); console.error('warn')`, { onStdout: (c) => out.push(c) }),
    );
    expect(proc.pid).toBeGreaterThan(0);
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(out.join('')).toContain('hello');
    await events.waitFor((e) => e.length === 1);
    expect(events.items).toEqual([
      { kind: 'exited', agentId: 'a-1', exit: expect.objectContaining({ code: 0, signal: null }) },
    ]);
    expect(s.processRecord('a-1')).toMatchObject({ agentId: 'a-1', status: 'exited', exitCode: 0 });
  });

  it('reports a non-zero exit as a crash', async () => {
    const { s, events } = makeSupervisor();
    await s.spawn(node(`process.exit(3)`));
    await events.waitFor((e) => e.some((x) => x.kind === 'crashed'));
    expect(events.items).toEqual([
      { kind: 'crashed', agentId: 'a-1', exit: expect.objectContaining({ code: 3, signal: null }) },
    ]);
    expect(s.processRecord('a-1')).toMatchObject({ status: 'exited', exitCode: 3 });
  });

  it('reports a child killed from outside as a crash', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(node(LOITER([])));
    process.kill(proc.pid, 'SIGKILL');
    await events.waitFor((e) => e.some((x) => x.kind === 'crashed'));
    expect(events.items[0]).toMatchObject({
      kind: 'crashed',
      exit: { code: null, signal: 'SIGKILL' },
    });
    expect(s.processRecord('a-1')).toMatchObject({ status: 'exited', signal: 'SIGKILL' });
    expect(s.get('a-1')?.state).toBe('exited');
  });

  it('rejects and reports `start_failed` when the command cannot start', async () => {
    const { s, events } = makeSupervisor();
    await expect(
      s.spawn({ agentId: 'a-1', command: 'galactic-no-such-binary', cwd: process.cwd() }),
    ).rejects.toThrow(/could not start galactic-no-such-binary/);
    expect(events.items).toEqual([
      expect.objectContaining({ kind: 'start_failed', error: expect.stringContaining('ENOENT') }),
    ]);
    expect(s.get('a-1')).toBeUndefined();
  });

  it('refuses a second live process for the same agent', async () => {
    const { s } = makeSupervisor();
    await s.spawn(node(LOITER([])));
    await expect(s.spawn(node(LOITER([])))).rejects.toThrow(/already has a running process/);
    expect(s.runningCount).toBe(1);
  });

  it('runs the child in its own working directory', async () => {
    const { s } = makeSupervisor();
    const out: string[] = [];
    const proc = await s.spawn(
      node(`console.log(process.cwd())`, { cwd: '/', onStdout: (c) => out.push(c) }),
    );
    await proc.exited;
    await eventually(() => out.join('').trim() === '/');
  });
});

describe('ProcessSupervisor — graceful stop', () => {
  it('interrupts first and lets a cooperative child exit on its own', async () => {
    const { s, events } = makeSupervisor();
    const out: string[] = [];
    const proc = await s.spawn(
      node(
        `process.on('SIGINT', () => { console.log('got SIGINT'); process.exit(0); }); ${LOITER([])}`,
        {
          onStdout: (c) => out.push(c),
        },
      ),
    );
    await eventually(() => out.join('').includes('ready'));
    const exit = await s.stop('a-1', { by: { type: 'user' } });
    expect(exit).toMatchObject({ code: 0, signal: null });
    expect(out.join('')).toContain('got SIGINT');
    expect(events.items).toEqual([
      expect.objectContaining({ kind: 'stopped', agentId: 'a-1', by: { type: 'user' } }),
    ]);
    expect(proc.state).toBe('exited');
    expect(s.processRecord('a-1')).toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it('terminates a child that ignores the interrupt', async () => {
    const { s, events } = makeSupervisor();
    const out: string[] = [];
    await s.spawn(node(LOITER(['SIGINT']), { onStdout: (c) => out.push(c) }));
    await eventually(() => out.join('').includes('ready'));
    const exit = await s.stop('a-1', { graceMs: 200, termMs: 500 });
    expect(exit?.signal).toBe('SIGTERM');
    expect(out.join('')).toContain('ignored SIGINT');
    expect(events.items).toEqual([
      expect.objectContaining({ kind: 'stopped', agentId: 'a-1', by: { type: 'system' } }),
    ]);
  });

  it('kills a child that ignores both the interrupt and SIGTERM', async () => {
    const { s } = makeSupervisor();
    const out: string[] = [];
    await s.spawn(node(LOITER(['SIGINT', 'SIGTERM']), { onStdout: (c) => out.push(c) }));
    await eventually(() => out.join('').includes('ready'));
    const exit = await s.stop('a-1', { graceMs: 150, termMs: 150 });
    expect(exit?.signal).toBe('SIGKILL');
    const seen = out.join('');
    expect(seen).toContain('ignored SIGINT');
    expect(seen).toContain('ignored SIGTERM');
    expect(seen.indexOf('ignored SIGINT')).toBeLessThan(seen.indexOf('ignored SIGTERM'));
  });

  it('uses the runtime interrupt hook and moves on as soon as the turn ends', async () => {
    const { s } = makeSupervisor();
    const out: string[] = [];
    let interrupted = 0;
    const proc = await s.spawn(
      node(LOITER(['SIGINT', 'SIGTERM']), {
        onStdout: (c) => out.push(c),
        interrupt: () => {
          interrupted++;
        },
      }),
    );
    await eventually(() => out.join('').includes('ready'));
    const started = Date.now();
    const stopping = s.stop('a-1', { graceMs: 5_000, termMs: 100 });
    await sleep(50);
    proc.turnEnded();
    const exit = await stopping;
    expect(interrupted).toBe(1);
    expect(out.join('')).not.toContain('ignored SIGINT');
    expect(exit?.signal).toBe('SIGKILL');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('does not lose a turn end reported from inside the interrupt hook', async () => {
    const { s } = makeSupervisor();
    const out: string[] = [];
    await s.spawn(
      node(LOITER(['SIGINT']), { onStdout: (c) => out.push(c), interrupt: (p) => p.turnEnded() }),
    );
    await eventually(() => out.join('').includes('ready'));
    const started = Date.now();
    const exit = await s.stop('a-1', { graceMs: 5_000, termMs: 100 });
    expect(exit?.signal).toBe('SIGTERM');
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it('kills orphaned grandchildren with the process group', async () => {
    const { s } = makeSupervisor();
    const out: string[] = [];
    await s.spawn({
      agentId: 'a-1',
      command: 'sh',
      args: ['-c', 'sleep 300 & echo "child $!"; trap "" INT TERM; wait'],
      cwd: process.cwd(),
      onStdout: (c) => out.push(c),
    });
    await eventually(() => /child \d+/.test(out.join('')));
    const grandchild = Number(/child (\d+)/.exec(out.join(''))![1]);
    expect(isAlive(grandchild)).toBe(true);
    await s.stop('a-1', { graceMs: 100, termMs: 100 });
    await eventually(() => !isAlive(grandchild));
  });

  it('an interrupt hook that never settles still reaches SIGTERM and SIGKILL', async () => {
    const { s, events } = makeSupervisor();
    const out: string[] = [];
    let called = 0;
    await s.spawn(
      node(LOITER(['SIGTERM']), {
        onStdout: (c) => out.push(c),
        interrupt: () => {
          called++;
          return new Promise<void>(() => {}); // a control request to a wedged CLI
        },
      }),
    );
    await eventually(() => out.join('').includes('ready'));
    const started = Date.now();
    const exit = await s.stop('a-1', { graceMs: 150, termMs: 150 });
    expect(called).toBe(1);
    expect(exit?.signal).toBe('SIGKILL');
    expect(out.join('')).toContain('ignored SIGTERM');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(events.items.map((o) => o.kind)).toEqual(['stopped']);
  });

  it('an interrupt hook that throws synchronously or rejects still stops the process', async () => {
    const errors: unknown[] = [];
    const { s } = makeSupervisor({ onError: (e) => errors.push(e) });
    await s.spawn(
      node(LOITER([]), {
        agentId: 'sync',
        interrupt: () => {
          throw new Error('boom');
        },
      }),
    );
    await s.spawn(
      node(LOITER([]), { agentId: 'async', interrupt: () => Promise.reject(new Error('later')) }),
    );
    const [a, b] = await Promise.all([
      s.stop('sync', { graceMs: 100, termMs: 300 }),
      s.stop('async', { graceMs: 100, termMs: 300 }),
    ]);
    expect(a?.signal).toBe('SIGTERM');
    expect(b?.signal).toBe('SIGTERM');
    expect(errors.map((e) => (e as Error).message).sort()).toEqual(['boom', 'later']);
  });

  it('stopping an unknown, exited or already stopping agent is harmless', async () => {
    const { s } = makeSupervisor();
    expect(await s.stop('nobody')).toBeUndefined();
    const proc = await s.spawn(node(`process.exit(0)`));
    await proc.exited;
    expect(await s.stop('a-1')).toMatchObject({ code: 0 });
    const live = await s.spawn(node(LOITER([]), { agentId: 'a-2' }));
    const [first, second] = await Promise.all([s.stop('a-2'), s.stop('a-2')]);
    expect(first).toEqual(second);
    expect(live.state).toBe('exited');
  });

  it('a stop reports exactly one outcome, and the spec hook sees it before the supervisor hook', async () => {
    const { s, events } = makeSupervisor();
    const order: string[] = [];
    await s.spawn(node(LOITER([]), { onOutcome: (o) => order.push(`spec:${o.kind}`) }));
    await s.stop('a-1');
    await sleep(20);
    expect(events.items.map((o) => o.kind)).toEqual(['stopped']);
    expect(order).toEqual(['spec:stopped']);
  });
});

describe('ProcessSupervisor — the group dies with its leader (corner case 4)', () => {
  /** `sh` that leaves a background `sleep` behind and exits with `code`. */
  const leaver = (code: number, extra: Partial<ProcessSpec> = {}): ProcessSpec => ({
    agentId: 'a-1',
    command: 'sh',
    args: ['-c', `sleep 60 & echo "child $!"; exit ${code}`],
    cwd: process.cwd(),
    ...extra,
  });
  const grandchildOf = (out: string[]) => Number(/child (\d+)/.exec(out.join(''))![1]);

  it.each([3, 0])(
    'the leader exits with %i: the grandchild is gone once exit settles',
    async (code) => {
      const { s, events } = makeSupervisor();
      const out: string[] = [];
      const proc = await s.spawn(leaver(code, { onStdout: (c) => out.push(c) }));
      const exit = await proc.exited;
      expect(exit.code).toBe(code);
      const grandchild = grandchildOf(out);
      expect(isRunning(grandchild)).toBe(false);
      await events.waitFor((e) => e.length === 1);
      expect(events.items[0]?.kind).toBe(code === 0 ? 'exited' : 'crashed');
    },
  );

  it('a leader killed from outside takes its group along, SIGKILL for members that ignore SIGTERM', async () => {
    const { s } = makeSupervisor({ defaults: { graceMs: 300, termMs: 150 } });
    const out: string[] = [];
    const proc = await s.spawn({
      agentId: 'a-1',
      command: 'sh',
      args: ['-c', `sh -c 'trap "" TERM; echo "child $$"; while :; do sleep 1; done' & wait`],
      cwd: process.cwd(),
      onStdout: (c) => out.push(c),
    });
    await eventually(() => /child \d+/.test(out.join('')));
    const grandchild = grandchildOf(out);
    process.kill(proc.pid, 'SIGKILL');
    await proc.exited;
    expect(isRunning(grandchild)).toBe(false);
  });

  it('reconcile kills the leftover group of a dead leader from this boot', async () => {
    const leader = spawn('sh', ['-c', 'sleep 60 & echo "child $!"; exit 0'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const out: string[] = [];
    leader.stdout!.on('data', (c: Buffer) => out.push(c.toString()));
    await new Promise((r) => leader.once('exit', r));
    await eventually(() => /child \d+/.test(out.join('')));
    const grandchild = grandchildOf(out);
    expect(isRunning(grandchild)).toBe(true);
    const store = new MemoryProcessStore();
    store.upsert({
      agentId: 'left',
      pid: leader.pid!,
      startedAt: new Date().toISOString(),
      status: 'running',
      meta: { command: 'sh', bootAt: bootTime() },
    });
    // The same leftovers recorded in another boot are never touched.
    store.upsert({
      agentId: 'old',
      pid: leader.pid!,
      startedAt: new Date().toISOString(),
      status: 'running',
      meta: { command: 'sh', bootAt: '2020-01-01T00:00:00.000Z' },
    });
    const { s } = makeSupervisor({ store });
    const result = s.reconcile();
    expect(result.orphans).toEqual(['left']);
    expect(result.dead).toEqual(['old']);
    await eventually(() => !isRunning(grandchild));
  });
});

describe('ProcessSupervisor — anchors of process attribution (P4-14)', () => {
  it("marks every child's environment with its agent id, which no spec can override", async () => {
    const { s } = makeSupervisor();
    expect(s.childEnv(node('', { env: { GALACTIC_AGENT_ID: 'a-forged' } }))).toMatchObject({
      GALACTIC_AGENT_ID: 'a-1',
    });
    let out = '';
    const p = await s.spawn(
      node(
        `require('child_process').spawn(process.execPath, ['-e', 'console.log(process.env.GALACTIC_AGENT_ID)'], { stdio: 'inherit' })`,
        { agentId: 'a-env', onStdout: (c) => (out += c) },
      ),
    );
    await p.exited;
    await eventually(() => out.includes('a-env'));
    // Inherited by the grandchild.
    expect(out.trim()).toBe('a-env');
  });

  it('gives only the groups and sessions of this run, never an earlier run’s row (B2)', async () => {
    const store = new MemoryProcessStore();
    const before = Date.now() - 60_000;
    // The previous run's Steward: its row says pid 424242 — a pgid the user's shell may own now.
    store.upsert({
      agentId: 'a-prev',
      pid: 424_242,
      startedAt: new Date(before).toISOString(),
      status: 'running',
      meta: { command: 'claude', bootAt: bootTime() },
    });
    const { s } = makeSupervisor({
      store,
      probe: { alive: () => false, groupAlive: () => false },
    });
    s.reconcile(); // interrupted, endedAt = now
    expect(store.get('a-prev')).toMatchObject({ status: 'interrupted' });
    expect(s.agentGroups()).toEqual([]);
    // Its session still bounds the orphan rule (which also needs the marker).
    const [prev] = s.agentSessions('a-prev');
    expect(prev!.start).toBe(before);
    expect(prev!.end).toBeGreaterThanOrEqual(before);

    // A reused pgid: the user's shell (60) runs a job in group 424242. With this run's groups
    // only, nothing claims it.
    const T = Date.now();
    const procs = [
      { pid: 1, ppid: 0, pgid: 1, uid: 501, startedAt: T - 3_600_000, command: '/sbin/launchd' },
      { pid: 60, ppid: 1, pgid: 60, uid: 501, startedAt: T - 600_000, command: '-zsh' },
      { pid: 424_250, ppid: 60, pgid: 424_242, uid: 501, startedAt: T - 30_000, command: 'vim' },
    ];
    const found = await attribute({
      agentId: 'a-prev',
      procs,
      groups: s.agentGroups(),
      self: { pid: 99, uid: 501 },
      sessions: s.agentSessions('a-prev'),
      cwdOf: () => new Map(),
      markerOf: () => new Map(),
    });
    expect(found).toEqual([]);
    // The old reading of the PID table would have anchored it (rule 3).
    const stale = await attribute({
      agentId: 'a-prev',
      procs,
      groups: [{ agentId: 'a-prev', pgid: 424_242, startedAt: before, endedAt: Date.now() }],
      self: { pid: 99, uid: 501 },
      sessions: [],
      cwdOf: () => new Map(),
      markerOf: () => new Map(),
    });
    expect(stale.map((p) => p.pid)).toEqual([424_250]);

    // Spawns of this run are anchors, one per spawn (a resume adds one), with the end it saw.
    const first = await s.spawn(node('', { agentId: 'a-now' }));
    await first.exited;
    const second = await s.spawn(node(LOITER([]), { agentId: 'a-now' }));
    const groups = s.agentGroups().filter((g) => g.agentId === 'a-now');
    expect(groups.map((g) => g.pgid)).toEqual([first.pid, second.pid]);
    expect(groups[0]!.endedAt).toBeGreaterThanOrEqual(groups[0]!.startedAt);
    expect(groups[1]!.endedAt).toBeUndefined();
    expect(s.agentSessions('a-now')).toHaveLength(2);
    expect(s.livePid('a-now')).toBe(second.pid);
    await s.stop('a-now');
    expect(s.livePid('a-now')).toBeUndefined();
  });
});

describe('ProcessSupervisor — group lifetimes and earlier sessions (P4-14 second review)', () => {
  it("ends a group's lifetime at its leader's exit, not after the drain and reap (N2)", async () => {
    const { s } = makeSupervisor({ defaults: { graceMs: 300, termMs: 400 } });
    let out = '';
    // The leader leaves an in-group child that ignores SIGTERM: the reap takes termMs + SIGKILL.
    const p = await s.spawn(
      node(
        `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
          LOITER(['SIGTERM']),
        )}], { stdio: ['ignore', 'pipe', 'ignore'] });
         c.stdout.on('data', (d) => { if (String(d).includes('ready')) { console.log('child ' + c.pid); process.exit(0); } });`,
        { agentId: 'a-n2', onStdout: (chunk) => (out += chunk) },
      ),
    );
    let child = 0;
    try {
      await p.exited;
      const settledAt = Date.now();
      child = Number(/child (\d+)/.exec(out)?.[1] ?? 0);
      const [group] = s.agentGroups().filter((g) => g.agentId === 'a-n2');
      expect(group!.endedAt).toBeDefined();
      // The reap (SIGTERM ignored, SIGKILL after 400 ms) happened after the recorded end.
      expect(settledAt - group!.endedAt!).toBeGreaterThanOrEqual(350);
      expect(child).toBeGreaterThan(0);
      expect(isRunning(child)).toBe(false);
    } finally {
      if (child > 0 && isAlive(child)) process.kill(child, 'SIGKILL');
    }
  });

  it("keeps an earlier run's session after this run resumes the agent (N3)", async () => {
    const store = new MemoryProcessStore();
    const start = Date.now() - 120_000;
    const end = start + 30_000;
    store.upsert({
      agentId: 'a-back',
      pid: 424_243,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      status: 'interrupted',
      meta: { command: 'claude', bootAt: bootTime() },
    });
    const { s } = makeSupervisor({ store });
    expect(s.agentSessions('a-back')).toEqual([{ start, end }]);
    // The resume overwrites the PID-table row; the earlier window stays.
    const p = await s.spawn(node(LOITER([]), { agentId: 'a-back' }));
    expect(store.get('a-back')).toMatchObject({ status: 'running', pid: p.pid });
    const sessions = s.agentSessions('a-back');
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toEqual({ start, end });
    expect(sessions[1]!.start).toBeGreaterThan(end);
    await s.stop('a-back');
    // A row from another boot is never a session.
    store.upsert({
      agentId: 'a-old-boot',
      pid: 1234,
      startedAt: new Date(start).toISOString(),
      endedAt: new Date(end).toISOString(),
      status: 'interrupted',
      meta: { command: 'claude', bootAt: new Date(0).toISOString() },
    });
    expect(s.agentSessions('a-old-boot')).toEqual([]);
  });
});

describe('ProcessSupervisor — restart policy', () => {
  it('is off by default', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(node(`process.exit(1)`));
    await proc.exited;
    await events.waitFor((e) => e.length === 1);
    expect(proc.restarts).toBe(0);
  });

  it('respawns on crash up to maxRestarts, then fails', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(
      node(`process.exit(1)`, { restart: { mode: 'on-crash', maxRestarts: 2, backoffMs: 10 } }),
    );
    await events.waitFor((e) => e.some((x) => x.kind === 'crashed'));
    expect(events.items.map((e) => e.kind)).toEqual(['restarting', 'restarting', 'crashed']);
    expect(events.items[0]).toMatchObject({ attempt: 1, maxRestarts: 2 });
    expect(proc.restarts).toBe(2);
    expect(proc.state).toBe('exited');
  });

  it('keeps one `exited` promise across restarts', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(
      node(`process.exit(1)`, { restart: { mode: 'on-crash', maxRestarts: 1, backoffMs: 10 } }),
    );
    const exited = proc.exited;
    await events.waitFor((e) => e.some((x) => x.kind === 'crashed'));
    await expect(exited).resolves.toMatchObject({ code: 1 });
    expect(proc.restarts).toBe(1);
  });

  it('a stop that lands during a restart wins and produces no crash events', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(
      node(`process.exit(1)`, { restart: { mode: 'on-crash', maxRestarts: 5, backoffMs: 150 } }),
    );
    await events.waitFor((e) => e.some((x) => x.kind === 'restarting'));
    const exit = await s.stop('a-1');
    expect(exit).toMatchObject({ code: 1 });
    await sleep(300);
    expect(proc.state).toBe('exited');
    expect(proc.restarts).toBe(0);
    expect(events.items.map((e) => e.kind)).toEqual(['restarting', 'stopped']);
  });

  it('does not respawn after a requested stop', async () => {
    const { s, events } = makeSupervisor();
    const out: string[] = [];
    const proc = await s.spawn(
      node(LOITER([]), {
        restart: { mode: 'on-crash', maxRestarts: 5, backoffMs: 10 },
        onStdout: (c) => out.push(c),
      }),
    );
    await eventually(() => out.join('').includes('ready'));
    await s.stop('a-1');
    await sleep(50);
    expect(proc.restarts).toBe(0);
    expect(events.items.map((e) => e.kind)).toEqual(['stopped']);
  });
});

describe('ProcessSupervisor — adopt and expected exits', () => {
  it('adopt() registers synchronously and reports a start failure as `start_failed`', async () => {
    const { s, events } = makeSupervisor();
    const proc = s.adopt({
      agentId: 'a-1',
      command: 'galactic-no-such-binary',
      cwd: process.cwd(),
    });
    expect(proc.state).toBe('running');
    await events.waitFor((e) => e.some((x) => x.kind === 'start_failed'));
    expect(events.items[0]).toMatchObject({ kind: 'start_failed' });
    await expect(proc.exited).resolves.toMatchObject({ code: null, signal: null });
    expect(s.get('a-1')).toBeUndefined();
  });

  it('adopt() rejects a restart policy (the caller owns the child it was handed)', () => {
    const { s } = makeSupervisor();
    expect(() =>
      s.adopt(node(LOITER([]), { restart: { mode: 'on-crash', maxRestarts: 1, backoffMs: 10 } })),
    ).toThrow(/adopt\(\) does not support a restart policy/);
    expect(s.get('a-1')).toBeUndefined();
    expect(s.processRecord('a-1')).toBeUndefined();
  });

  it('adopt() returns a live child the caller can hand to a runtime', async () => {
    const { s } = makeSupervisor();
    const out: string[] = [];
    const proc = s.adopt(
      node(`process.stdin.on('data', (d) => { console.log('got ' + d); process.exit(0); })`, {
        onStdout: (c) => out.push(c),
      }),
    );
    await sleep(50);
    proc.write('ping\n');
    await proc.exited;
    expect(out.join('')).toContain('got ping');
    expect(s.processRecord('a-1')).toMatchObject({ pid: proc.pid, status: 'exited', exitCode: 0 });
  });

  it('an exit the runtime announced with expectExit() is not a crash', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(node(LOITER([])));
    proc.expectExit();
    process.kill(proc.pid, 'SIGTERM');
    await proc.exited;
    await sleep(20);
    expect(events.items.map((o) => o.kind)).toEqual(['exited']);
    expect(proc.exit?.signal).toBe('SIGTERM');
  });
});

describe('ProcessSupervisor — persisted PID table and reconciliation', () => {
  it('marks dead rows interrupted and kills live orphans on startup', async () => {
    const store = new MemoryProcessStore();
    // A process from a "previous server life" that is gone.
    const meta = { command: NODE, bootAt: bootTime() };
    const gone = spawn(NODE, ['-e', 'process.exit(0)']);
    await new Promise((r) => gone.once('exit', r));
    store.upsert({
      agentId: 'dead',
      pid: gone.pid!,
      startedAt: '2026-09-30T00:00:00.000Z',
      status: 'running',
      meta,
    });
    // A live orphan in its own group, nobody supervising it.
    const orphan = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    orphan.unref();
    await new Promise((r) => orphan.once('spawn', r));
    store.upsert({
      agentId: 'orphan',
      pid: orphan.pid!,
      startedAt: new Date().toISOString(), // the start-time check compares with `ps -o lstart=`
      status: 'running',
      meta,
    });
    // A live process whose pid was recycled by something else: must not be killed.
    const stranger = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    stranger.unref();
    await new Promise((r) => stranger.once('spawn', r));
    store.upsert({
      agentId: 'reused',
      pid: stranger.pid!,
      startedAt: '2026-09-30T00:00:00.000Z',
      status: 'running',
      meta: { command: '/usr/bin/claude', bootAt: bootTime() },
    });
    // A live pid recorded in a previous boot: never the same process.
    store.upsert({
      agentId: 'oldboot',
      pid: stranger.pid!,
      startedAt: '2026-09-30T00:00:00.000Z',
      status: 'running',
      meta: { command: NODE, bootAt: '2020-01-01T00:00:00.000Z' },
    });
    // A row without a pid (a runtime that spawns its own process).
    store.upsert({ agentId: 'nopid', startedAt: '2026-09-30T00:00:00.000Z', status: 'running' });
    // An already finished row stays untouched.
    store.upsert({
      agentId: 'done',
      pid: 1,
      startedAt: '2026-09-30T00:00:00.000Z',
      status: 'exited',
      exitCode: 0,
    });

    const { s } = makeSupervisor({ store, now: () => '2026-09-30T01:00:00.000Z' });
    const result = s.reconcile();
    expect(result).toEqual({ dead: ['dead', 'reused', 'oldboot', 'nopid'], orphans: ['orphan'] });
    await eventually(() => !isAlive(orphan.pid!));
    expect(isAlive(stranger.pid!)).toBe(true);
    process.kill(stranger.pid!, 'SIGKILL');
    for (const id of ['dead', 'orphan', 'nopid', 'reused', 'oldboot']) {
      expect(store.get(id)).toMatchObject({
        status: 'interrupted',
        endedAt: '2026-09-30T01:00:00.000Z',
      });
    }
    expect(store.get('done')?.status).toBe('exited');
    // Running again finds nothing to do.
    expect(s.reconcile()).toEqual({ dead: [], orphans: [] });
  });

  const strays: number[] = [];
  /** A detached process nobody supervises, like a CLI left behind by a crashed server. */
  async function strayProcess() {
    const child = spawn(NODE, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await new Promise((r) => child.once('spawn', r));
    strays.push(child.pid!);
    return { pid: child.pid!, startedAt: new Date().toISOString() };
  }
  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });

  it('reads the command name from the whole `comm` (macOS paths with spaces) and the start time', () => {
    expect(commandName('/Applications/Claude Code.app/Contents/MacOS/claude\n')).toBe('claude');
    expect(commandName('/Users/c/Library/Application Support/x/claude')).toBe('claude');
    expect(commandName('node')).toBe('node');
    expect(parseLstart('Thu Oct  1 10:00:00 2026')).toBe(new Date(2026, 9, 1, 10, 0, 0).getTime());
    expect(parseLstart('garbage')).toBeUndefined();
    // The real probe on this very process.
    expect(processName(process.pid)).toBeDefined();
    const started = processStartTime(process.pid);
    expect(started).toBeDefined();
    expect(Math.abs(started! - (Date.now() - process.uptime() * 1000))).toBeLessThan(3_000);
  });

  it('a recycled pid with the right name but another start time is not killed', async () => {
    const store = new MemoryProcessStore();
    const stranger = await strayProcess();
    store.upsert({
      agentId: 'recycled',
      pid: stranger.pid,
      startedAt: stranger.startedAt,
      status: 'running',
      meta: { command: '/usr/local/bin/claude', bootAt: bootTime() },
    });
    const { s } = makeSupervisor({
      store,
      probe: {
        name: () => 'claude', // the user's own interactive `claude` now has this pid
        startTime: () => Date.parse(stranger.startedAt) + 3_600_000,
      },
    });
    expect(s.reconcile()).toEqual({ dead: ['recycled'], orphans: [] });
    await sleep(100);
    expect(isAlive(stranger.pid)).toBe(true);
    expect(store.get('recycled')?.status).toBe('interrupted');
  });

  it('a CLI under a path with spaces and the recorded start time is recognised and killed', async () => {
    const store = new MemoryProcessStore();
    const orphan = await strayProcess();
    const command = '/Users/cosmin/Library/Application Support/Claude/claude-code/claude';
    store.upsert({
      agentId: 'orphan',
      pid: orphan.pid,
      startedAt: orphan.startedAt,
      status: 'running',
      meta: { command, bootAt: bootTime() },
    });
    const { s } = makeSupervisor({
      store,
      probe: {
        name: () => commandName(`${command}\n`), // what macOS `ps -o comm=` prints
        startTime: () => Date.parse(orphan.startedAt) + 800, // lstart is truncated to seconds
      },
    });
    expect(s.reconcile()).toEqual({ dead: [], orphans: ['orphan'] });
    await eventually(() => !isAlive(orphan.pid));
  });

  it('falls back to name + boot when the start time cannot be read', async () => {
    const store = new MemoryProcessStore();
    const orphan = await strayProcess();
    store.upsert({
      agentId: 'orphan',
      pid: orphan.pid,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
      meta: { command: NODE, bootAt: bootTime() },
    });
    const { s } = makeSupervisor({ store, probe: { startTime: () => undefined } });
    expect(s.reconcile()).toEqual({ dead: [], orphans: ['orphan'] });
    await eventually(() => !isAlive(orphan.pid));
  });

  it('leaves this life’s own processes alone', async () => {
    const store = new MemoryProcessStore();
    const { s } = makeSupervisor({ store });
    await s.spawn(node(LOITER([])));
    expect(s.reconcile()).toEqual({ dead: [], orphans: [] });
    expect(store.get('a-1')?.status).toBe('running');
  });

  it('persists rows in SQLite through the real migration', async () => {
    const db = openDatabase(':memory:');
    const store = new SqliteProcessStore(db);
    const { s } = makeSupervisor({ store, now: () => '2026-09-30T02:00:00.000Z' });
    const proc = await s.spawn(node(`process.exit(0)`, { meta: { runtime: 'fake' } }));
    expect(store.get('a-1')).toEqual({
      agentId: 'a-1',
      pid: proc.pid,
      startedAt: '2026-09-30T02:00:00.000Z',
      status: 'running',
      meta: {
        runtime: 'fake',
        command: NODE,
        bootAt: expect.any(String),
        launchId: expect.any(String),
      },
    });
    expect(store.running().map((r) => r.agentId)).toEqual(['a-1']);
    await proc.exited;
    expect(store.get('a-1')).toMatchObject({
      status: 'exited',
      exitCode: 0,
      endedAt: '2026-09-30T02:00:00.000Z',
    });
    expect(store.running()).toEqual([]);
    expect(store.all()).toHaveLength(1);
    store.upsert({ agentId: 'x', startedAt: 't', status: 'interrupted', signal: 'SIGKILL' });
    expect(store.get('x')).toEqual({
      agentId: 'x',
      startedAt: 't',
      status: 'interrupted',
      signal: 'SIGKILL',
    });
    db.close();
  });
});

describe('ProcessSupervisor — child environment (P1-24)', () => {
  it('children inherit only the allow-list plus the spec env', async () => {
    const { s } = makeSupervisor({ inheritEnv: ['GALACTIC_TEST_OK'] });
    process.env['GALACTIC_TEST_SECRET'] = 'server-only';
    process.env['GALACTIC_TEST_OK'] = 'shared';
    try {
      const out: string[] = [];
      const proc = await s.spawn(
        node(`console.log(JSON.stringify(process.env))`, {
          env: { GALACTIC_SPEC: 'yes', PATH: undefined },
          onStdout: (c) => out.push(c),
        }),
      );
      await proc.exited;
      await eventually(() => out.join('').includes('}'));
      const env = JSON.parse(out.join('')) as Record<string, string>;
      expect(env['GALACTIC_TEST_SECRET']).toBeUndefined();
      expect(env['GALACTIC_TEST_OK']).toBe('shared');
      expect(env['GALACTIC_SPEC']).toBe('yes');
      expect(env['PATH']).toBeUndefined();
      expect(env['HOME']).toBe(process.env['HOME']);
      expect(INHERITED_ENV).not.toContain('ANTHROPIC_API_KEY');
    } finally {
      delete process.env['GALACTIC_TEST_SECRET'];
      delete process.env['GALACTIC_TEST_OK'];
    }
  });
});

describe('ProcessSupervisor — dispose', () => {
  it('stops every live process, reporting each stop', async () => {
    const { s, events } = makeSupervisor();
    await s.spawn(node(LOITER([]), { agentId: 'a-1' }));
    await s.spawn(node(LOITER(['SIGINT']), { agentId: 'a-2' }));
    await s.dispose();
    expect(s.list().every((p) => p.state === 'exited')).toBe(true);
    await sleep(20);
    expect(events.items.map((o) => o.kind).sort()).toEqual(['stopped', 'stopped']);
    await expect(s.spawn(node(LOITER([]), { agentId: 'a-3' }))).rejects.toThrow(/disposed/);
  });
});
