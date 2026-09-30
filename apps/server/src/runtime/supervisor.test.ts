import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { collect } from './event-queue.js';
import { MemoryProcessStore, SqliteProcessStore } from './process-store.js';
import { ProcessSupervisor, isAlive, type ProcessSpec } from './supervisor.js';

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

const supervisors: ProcessSupervisor[] = [];
function makeSupervisor(opts: ConstructorParameters<typeof ProcessSupervisor>[0] = {}) {
  const s = new ProcessSupervisor({ defaults: { graceMs: 300, termMs: 300 }, ...opts });
  supervisors.push(s);
  return { s, events: collect<AgentEvent>(s.events) };
}
afterEach(async () => {
  for (const s of supervisors.splice(0)) await s.dispose();
});

describe('ProcessSupervisor — spawn and exit detection', () => {
  it('captures stdio and emits nothing for a clean exit', async () => {
    const { s, events } = makeSupervisor();
    const out: string[] = [];
    const proc = await s.spawn(
      node(`console.log('hello'); console.error('warn')`, { onStdout: (c) => out.push(c) }),
    );
    expect(proc.pid).toBeGreaterThan(0);
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(out.join('')).toContain('hello');
    await sleep(20);
    expect(events.items).toEqual([]);
    expect(s.processRecord('a-1')).toMatchObject({ agentId: 'a-1', status: 'exited', exitCode: 0 });
  });

  it('reports a non-zero exit as agent.failed(reason: crash)', async () => {
    const { s, events } = makeSupervisor();
    await s.spawn(node(`process.exit(3)`));
    await events.waitFor((e) => e.some((x) => x.type === 'agent.failed'));
    expect(events.items).toEqual([
      {
        type: 'agent.failed',
        agentId: 'a-1',
        reason: 'crash',
        error: 'process exited with code 3',
      },
    ]);
    expect(s.processRecord('a-1')).toMatchObject({ status: 'exited', exitCode: 3 });
  });

  it('reports a child killed from outside as a crash', async () => {
    const { s, events } = makeSupervisor();
    const proc = await s.spawn(node(LOITER([])));
    process.kill(proc.pid, 'SIGKILL');
    await events.waitFor((e) => e.some((x) => x.type === 'agent.failed'));
    expect(events.items[0]).toMatchObject({
      type: 'agent.failed',
      reason: 'crash',
      error: 'process killed by SIGKILL',
    });
    expect(s.processRecord('a-1')).toMatchObject({ status: 'exited', signal: 'SIGKILL' });
    expect(s.get('a-1')?.state).toBe('exited');
  });

  it('rejects and emits agent.failed(reason: runtime) when the command cannot start', async () => {
    const { s, events } = makeSupervisor();
    await expect(
      s.spawn({ agentId: 'a-1', command: 'galactic-no-such-binary', cwd: process.cwd() }),
    ).rejects.toThrow(/could not start galactic-no-such-binary/);
    expect(events.items).toEqual([
      expect.objectContaining({ type: 'agent.failed', reason: 'runtime' }),
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
    expect(events.items).toEqual([{ type: 'agent.stopped', agentId: 'a-1', by: { type: 'user' } }]);
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
      { type: 'agent.stopped', agentId: 'a-1', by: { type: 'system' } },
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

  it('silent stops emit nothing', async () => {
    const { s, events } = makeSupervisor();
    await s.spawn(node(LOITER([])));
    await s.stop('a-1', { silent: true });
    await sleep(20);
    expect(events.items).toEqual([]);
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
    await events.waitFor((e) => e.some((x) => x.type === 'agent.failed'));
    expect(events.items.map((e) => e.type)).toEqual([
      'agent.progress',
      'agent.progress',
      'agent.failed',
    ]);
    expect(events.items[0]).toMatchObject({ summary: expect.stringContaining('attempt 1/2') });
    expect(proc.restarts).toBe(2);
    expect(proc.state).toBe('exited');
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
    expect(events.items.map((e) => e.type)).toEqual(['agent.stopped']);
  });
});

describe('ProcessSupervisor — persisted PID table and reconciliation', () => {
  it('marks dead rows interrupted and kills live orphans on startup', async () => {
    const store = new MemoryProcessStore();
    // A process from a "previous server life" that is gone.
    const gone = spawn(NODE, ['-e', 'process.exit(0)']);
    await new Promise((r) => gone.once('exit', r));
    store.upsert({
      agentId: 'dead',
      pid: gone.pid!,
      startedAt: '2026-09-30T00:00:00.000Z',
      status: 'running',
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
      startedAt: '2026-09-30T00:00:00.000Z',
      status: 'running',
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
    expect(result).toEqual({ dead: ['dead', 'nopid'], orphans: ['orphan'] });
    await eventually(() => !isAlive(orphan.pid!));
    for (const id of ['dead', 'orphan', 'nopid']) {
      expect(store.get(id)).toMatchObject({
        status: 'interrupted',
        endedAt: '2026-09-30T01:00:00.000Z',
      });
    }
    expect(store.get('done')?.status).toBe('exited');
    // Running again finds nothing to do.
    expect(s.reconcile()).toEqual({ dead: [], orphans: [] });
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
      meta: { runtime: 'fake' },
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

describe('ProcessSupervisor — dispose', () => {
  it('stops every live process and ends the event stream', async () => {
    const { s, events } = makeSupervisor();
    await s.spawn(node(LOITER([]), { agentId: 'a-1' }));
    await s.spawn(node(LOITER(['SIGINT']), { agentId: 'a-2' }));
    await s.dispose();
    expect(s.list().every((p) => p.state === 'exited')).toBe(true);
    await sleep(20);
    expect(events.items).toEqual([]);
    await expect(s.spawn(node(LOITER([]), { agentId: 'a-3' }))).rejects.toThrow(/disposed/);
  });
});
