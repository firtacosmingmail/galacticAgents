import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database.js';
import { MemoryProcessStore, SqliteProcessStore } from './process-store.js';
import {
  INHERITED_ENV,
  ProcessSupervisor,
  bootTime,
  commandName,
  isAlive,
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
      meta: { runtime: 'fake', command: NODE, bootAt: expect.any(String) },
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
