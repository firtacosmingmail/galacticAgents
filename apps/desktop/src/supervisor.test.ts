import { describe, expect, it } from 'vitest';
import type { ShellLine } from './lines.js';
import {
  dataPaths,
  type LockHolder,
  type OwnServerOptions,
  type StartResult,
} from './lifecycle.js';
import { Supervisor } from './supervisor.js';
import type { WatcherOptions } from './watcher.js';
import { trayView } from './tray-view.js';

class FakeOwn {
  running = false;
  stops = 0;
  constructor(
    readonly opts: OwnServerOptions,
    private readonly result: StartResult,
  ) {}
  async start() {
    this.running = this.result.kind === 'started';
    return this.result;
  }
  async stop() {
    this.stops++;
    this.running = false;
  }
  crash() {
    this.running = false;
    this.opts.onExit(1, null);
  }
}

function setup(opts: { lock?: LockHolder; healthy?: boolean; result?: StartResult } = {}) {
  const lines: ShellLine[] = [];
  const owns: FakeOwn[] = [];
  const watchers: WatcherOptions[] = [];
  const world = { lock: opts.lock, healthy: opts.healthy ?? true, alive: true };
  let clock = 0;
  const supervisor = new Supervisor({
    paths: dataPaths({ GALACTIC_HOME: '/data' }),
    token: () => 'tok',
    emit: (l) => lines.push(l),
    log: () => {},
    server: { launcher: '/x/galactic.mjs', env: {} },
    planDeps: {
      readLock: () => world.lock,
      alive: () => world.alive,
      healthy: async () => world.healthy,
    },
    makeOwnServer: (o) => {
      const own = new FakeOwn(o, opts.result ?? { kind: 'started', port: 4400, pid: 99 });
      owns.push(own);
      return own;
    },
    makeWatcher: (o) => {
      watchers.push(o);
      return { start: () => {}, stop: () => {} };
    },
    now: () => clock,
  });
  const servers = () => lines.flatMap((l) => (l.type === 'server' ? [l.server] : []));
  const lastStatus = () => [...lines].reverse().find((l) => l.type === 'status');
  return {
    supervisor,
    lines,
    owns,
    watchers,
    world,
    servers,
    lastStatus,
    advance: (ms: number) => (clock += ms),
  };
}

describe('Supervisor', () => {
  it('starts its own server when none runs, and stops only that one on quit', async () => {
    const t = setup();
    await t.supervisor.tick();
    expect(t.servers()).toEqual([
      { url: 'http://127.0.0.1:4400', port: 4400, owned: true, pid: 99 },
    ]);
    expect(t.watchers[0]!.url).toBe('ws://127.0.0.1:4400/ws');
    await t.supervisor.quit();
    expect(t.owns[0]!.stops).toBe(1);
    expect(t.lines.at(-1)).toEqual({ type: 'exited' });
  });

  it('attaches to a running server instead of starting a second', async () => {
    const t = setup({ lock: { pid: 7, role: 'server', port: 4500 } });
    await t.supervisor.tick();
    expect(t.owns).toHaveLength(0);
    expect(t.servers()).toEqual([
      { url: 'http://127.0.0.1:4500', port: 4500, owned: false, pid: 7 },
    ]);
    await t.supervisor.quit();
    expect(t.lines.at(-1)).toEqual({ type: 'exited' });
  });

  it('does not replace an attached server that went away; offers the start', async () => {
    const t = setup({ lock: { pid: 7, role: 'server', port: 4500 } });
    await t.supervisor.tick();
    t.world.lock = undefined;
    t.watchers[0]!.onState({ connection: 'disconnected', waiting: 0, storage: 'ok' });
    await t.supervisor.tick();
    expect(t.owns).toHaveLength(0);
    const status = t.lastStatus();
    expect(status).toMatchObject({ state: 'stopped', view: { canStart: true } });
    t.supervisor.requestStart();
    await t.supervisor.tick();
    expect(t.owns).toHaveLength(1);
  });

  it('a refused start (the lock) goes back to attaching', async () => {
    const t = setup({ result: { kind: 'locked' } });
    await t.supervisor.tick();
    expect(t.servers()).toEqual([]);
    t.world.lock = { pid: 7, role: 'server', port: 4500 };
    await t.supervisor.tick();
    expect(t.servers()[0]).toMatchObject({ owned: false, port: 4500 });
  });

  it('waits for a starting holder, then lets the server decide after the grace', async () => {
    const t = setup({ lock: { pid: 7, role: 'server' } });
    await t.supervisor.tick();
    expect(t.owns).toHaveLength(0);
    expect(t.lastStatus()).toMatchObject({
      state: 'starting',
      detail: 'Mission Control is starting',
    });
    t.advance(20_000);
    await t.supervisor.tick();
    expect(t.owns).toHaveLength(1);
  });

  it('restarts its own server after a crash, and gives up after three', async () => {
    const t = setup();
    await t.supervisor.tick();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 2; i++) {
      t.owns.at(-1)!.crash(); // starts again by itself
      await flush();
    }
    expect(t.owns).toHaveLength(3);
    t.owns.at(-1)!.crash();
    await flush();
    await t.supervisor.tick();
    expect(t.owns).toHaveLength(3);
    expect(t.lastStatus()).toMatchObject({ state: 'error', view: { canStart: true } });
  });

  it('reports the failure of a start that never listens', async () => {
    const t = setup({ result: { kind: 'failed', reason: 'boom' } });
    await t.supervisor.tick();
    expect(t.lastStatus()).toMatchObject({ state: 'error', detail: 'boom' });
    expect(t.owns[0]!.stops).toBe(1);
  });

  it('passes the watcher state and notifications through', async () => {
    const t = setup();
    await t.supervisor.tick();
    t.watchers[0]!.onState({ connection: 'live', waiting: 3, storage: 'ok' });
    expect(t.lastStatus()).toMatchObject({ state: 'live', waiting: 3, view: { title: '3' } });
    t.watchers[0]!.onNotify({ id: 'question:q', title: 'A question for you' });
    expect(t.lines.at(-1)).toEqual({
      type: 'notify',
      id: 'question:q',
      title: 'A question for you',
    });
  });
});

describe('trayView', () => {
  const server = { url: 'http://127.0.0.1:4400', port: 4400, owned: true };
  it('puts the loudest state first', () => {
    expect(trayView({ state: 'disconnected', waiting: 2, storage: 'full', server }).label).toBe(
      'Disconnected',
    );
    expect(trayView({ state: 'live', waiting: 2, storage: 'full', server })).toMatchObject({
      label: 'Storage problem: the disk is full',
      title: '!',
    });
    expect(trayView({ state: 'live', waiting: 2, storage: 'ok', server })).toMatchObject({
      label: '2 waiting for you',
      title: '2',
      serverLabel: 'Mission Control started by this app (port 4400)',
    });
    expect(trayView({ state: 'live', waiting: 0, storage: 'ok', server })).toMatchObject({
      label: 'Live',
      title: '',
      canStart: false,
    });
    expect(
      trayView({ state: 'live', waiting: 0, storage: 'ok', server: { ...server, owned: false } })
        .serverLabel,
    ).toBe('Attached to Mission Control on port 4400');
  });
});
