import { describe, expect, it } from 'vitest';
import { emptyWorld, type Question, type WorldState } from '@galactic/protocol';
import { domain } from '@galactic/protocol/fixtures';
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

function setup(
  opts: { lock?: LockHolder; healthy?: boolean; result?: StartResult; fetch?: typeof fetch } = {},
) {
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
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
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

  it('never starts over an import or a restore holding the data, however long it takes', async () => {
    for (const role of ['import', 'restore']) {
      const t = setup({ lock: { pid: 7, role } });
      await t.supervisor.tick();
      t.advance(10 * 60_000);
      await t.supervisor.tick();
      expect(t.owns, role).toHaveLength(0);
      expect(t.lastStatus()).toMatchObject({
        state: 'starting',
        detail: `a galactic ${role} is using the data`,
      });
    }
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

describe("Supervisor: the menu bar's permission requests (P9-15)", () => {
  const { answeredBy: _by, answer: _a, ...base } = domain.permissionQuestion;
  const request: Question = { ...base, id: 'q-7', status: 'open', version: 4 };
  const clarification: Question = {
    ...domain.question,
    id: 'q-8',
    holder: { type: 'user' },
  };
  const worldWith = (...questions: Question[]): WorldState => ({
    ...emptyWorld(),
    agents: { [domain.agent.id]: domain.agent },
    questions: Object.fromEntries(questions.map((q) => [q.id, q])),
  });

  async function live(fetchImpl?: typeof fetch) {
    const t = setup(fetchImpl ? { fetch: fetchImpl } : {});
    await t.supervisor.tick();
    const w = t.watchers[0]!;
    w.onWorld?.(worldWith(request, clarification));
    w.onState({ connection: 'live', waiting: 2, storage: 'ok' });
    const menus = () => t.lines.flatMap((l) => (l.type === 'menu' ? [l.menu] : []));
    const notes = () => t.lines.flatMap((l) => (l.type === 'notify' ? [l] : []));
    return { ...t, w, menus, notes };
  }

  it('sends the waiting requests and questions while live, and an empty menu otherwise', async () => {
    const t = await live();
    const menu = t.menus().at(-1)!;
    expect(menu.permissions).toEqual([
      { id: 'q-7', version: 4, title: expect.stringContaining('Bash git push origin task/t-1') },
    ]);
    expect(menu.questions.map((q) => q.id)).toEqual(['q-8']);
    // A change in the world is sent at once; an unchanged menu is not sent again.
    const before = t.menus().length;
    t.w.onWorld?.(worldWith(request, clarification));
    expect(t.menus()).toHaveLength(before);
    t.w.onWorld?.(worldWith(clarification));
    expect(t.menus().at(-1)!.permissionCount).toBe(0);
    t.w.onState({ connection: 'disconnected', waiting: 0, storage: 'ok' });
    expect(t.menus().at(-1)).toEqual({
      permissions: [],
      permissionCount: 0,
      questions: [],
      questionCount: 0,
    });
  });

  it('answers through the route with the token and the version, marking the item meanwhile', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let resolve: (r: Response) => void = () => {};
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Promise<Response>((r) => (resolve = r));
    }) as unknown as typeof fetch;
    const t = await live(fakeFetch);
    const pending = t.supervisor.answer({ questionId: 'q-7', version: 4, decision: 'allow' });
    expect(t.menus().at(-1)!.permissions[0]?.sending).toBe(true);
    // A second click while the first is on its way sends nothing.
    await t.supervisor.answer({ questionId: 'q-7', version: 4, decision: 'deny' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4400/api/questions/q-7/answer');
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ answer: 'allow', version: 4 });
    resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await pending;
    expect(t.menus().at(-1)!.permissions[0]?.sending).toBeUndefined();
    expect(t.notes()).toEqual([]);
  });

  it('a stale answer is said in a notification', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: 'stale', message: 'already answered by you' }), {
        status: 409,
      })) as unknown as typeof fetch;
    const t = await live(fakeFetch);
    await t.supervisor.answer({ questionId: 'q-7', version: 4, decision: 'deny' });
    expect(t.notes()).toEqual([
      {
        type: 'notify',
        id: 'galactic:tray-answer:q-7:1',
        title: 'Permission request already answered',
        body: 'Your Deny was not sent: already answered by you.',
      },
    ]);
    expect(JSON.stringify(t.lines)).not.toContain('tok"');
  });

  it('sends nothing for a request no longer open, held by an agent or unknown: it is not waiting', async () => {
    let called = 0;
    const fakeFetch = (async () => {
      called++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = await live(fakeFetch);
    const answered: Question = { ...request, status: 'answered' };
    const dismissed: Question = { ...request, id: 'q-9', status: 'cancelled' };
    const held: Question = { ...request, id: 'q-10', holder: { type: 'agent', id: 'a-1' } };
    t.w.onWorld?.(worldWith(answered, dismissed, held));
    for (const questionId of ['q-7', 'q-9', 'q-10', 'q-unknown']) {
      await t.supervisor.answer({ questionId, version: 4, decision: 'allow' });
    }
    expect(called).toBe(0);
    expect(t.notes().map((n) => n.title)).toEqual(
      Array(4).fill('Permission request is no longer waiting'),
    );
  });

  it('never answers a clarification from the menu, nor while disconnected', async () => {
    let called = 0;
    const fakeFetch = (async () => {
      called++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const t = await live(fakeFetch);
    await t.supervisor.answer({ questionId: 'q-8', version: 0, decision: 'allow' });
    expect(called).toBe(0);
    expect(t.notes().at(-1)?.title).toBe('Permission request is no longer waiting');
    t.w.onState({ connection: 'disconnected', waiting: 0, storage: 'ok' });
    await t.supervisor.answer({ questionId: 'q-7', version: 4, decision: 'allow' });
    expect(called).toBe(0);
    expect(t.notes().at(-1)?.title).toBe('Could not answer the permission request');
  });
});
