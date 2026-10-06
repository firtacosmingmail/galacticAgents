import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ServerMessage, StorageHealth } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import type { EventLog } from '../domain/event-log.js';
import { buildApp } from '../app.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';
import { StorageMonitor } from './storage-health.js';

/**
 * P8-09: the database's write health for the panel — from the runtime's held queue and from
 * refused commands — over the WebSocket (snapshot and replacing `status` messages), and the REST
 * refusals (507 `storage_full`, 503 `storage_unwritable` / `storage_unavailable`).
 *
 * A full disk as `held-writes.test.ts` makes it: the log's event insert fails with the SQLite
 * code while the switch is on (the drills fill a real file, `test/drills/disk-full.test.ts`).
 */

function diskOf(log: EventLog) {
  const insert = (log as unknown as { insertEvent: { run: (...args: unknown[]) => unknown } })
    .insertEvent;
  const run = insert.run.bind(insert);
  let failure: { code: string; message: string } | undefined;
  insert.run = (...args: unknown[]) => {
    if (failure) throw Object.assign(new Error(failure.message), { code: failure.code });
    return run(...args);
  };
  return {
    fill: () => void (failure = { code: 'SQLITE_FULL', message: 'database or disk is full' }),
    readOnly: () =>
      void (failure = { code: 'SQLITE_READONLY', message: 'attempt to write a readonly database' }),
    ioError: () => void (failure = { code: 'SQLITE_IOERR_WRITE', message: 'disk I/O error' }),
    restore: () => void (failure = undefined),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function compose(): ComposedRuntime {
  const composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
    onError: () => {},
  });
  cleanups.push(() => composed.dispose());
  return composed;
}

async function until(pred: () => boolean, what: string, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A Steward of the `long` scenario: progress every 50 ms for a second, then it finishes. */
async function busySteward(c: ComposedRuntime): Promise<string> {
  const spawned = await c.runtime.spawn({
    role: 'steward',
    runtime: 'fake',
    prompt: 'scenario:long',
    cwd: '/tmp',
  });
  if (!spawned.ok) throw new Error(spawned.reason);
  return spawned.agent.id;
}

describe('StorageMonitor (P8-09)', () => {
  it('a refused command marks the disk full with nothing held; the next commit clears it', async () => {
    const c = compose();
    const disk = diskOf(c.log);
    const seen: StorageHealth[] = [];
    c.storage.subscribe((h) => seen.push(h));
    expect(c.storage.current()).toEqual({ condition: 'ok', held: 0, dropped: 0 });

    disk.fill();
    await expect(c.commands.createProject({ name: 'Full', workspace: '/w/full' })).rejects.toThrow(
      /disk is full/,
    );
    await until(() => seen.length > 0, 'the full disk to be published');
    expect(seen.at(-1)).toMatchObject({
      condition: 'full',
      held: 0,
      dropped: 0,
      error: 'database or disk is full',
      since: expect.any(String),
    });

    disk.restore();
    await c.commands.createProject({ name: 'Room', workspace: '/w/room' });
    await until(() => seen.at(-1)?.condition === 'ok', 'the storage to be ok again');
    expect(c.storage.current()).toEqual({ condition: 'ok', held: 0, dropped: 0 });
  });

  it('agent events held for a full disk are counted, and the state clears when they are written', async () => {
    const c = compose();
    const disk = diskOf(c.log);
    const seen: StorageHealth[] = [];
    c.storage.subscribe((h) => seen.push(h));
    const steward = await busySteward(c);
    await until(() => (c.statuses.get(steward)?.progress?.done ?? 0) > 0, 'the Steward at work');

    disk.fill();
    await until(() => c.runtime.heldWrites > 0, 'a held agent event');
    await until(() => c.storage.current().held > 0, 'the held events to be published');
    const first = c.storage.current();
    expect(first).toMatchObject({ condition: 'full', error: 'database or disk is full' });
    // The count follows the queue (at most once a second per change of counts alone).
    await until(() => c.runtime.liveAgents().every((a) => a.id !== steward), 'the finish', 5_000);
    await until(
      () => c.storage.current().held === c.runtime.heldWrites,
      'the count to catch up',
      2_500,
    );
    expect(c.storage.current().held).toBeGreaterThan(first.held);
    expect(seen.filter((h) => h.condition === 'full').length).toBeLessThan(c.runtime.heldWrites);

    disk.restore();
    expect(c.runtime.writeHeld()).toBe(0);
    await until(() => c.storage.current().condition === 'ok', 'the banner state to clear');
    expect(seen.at(-1)).toEqual({ condition: 'ok', held: 0, dropped: 0 });
  });

  it('names a read-only database unwritable and an I/O error unavailable', async () => {
    const c = compose();
    const disk = diskOf(c.log);
    disk.readOnly();
    await expect(c.commands.createProject({ name: 'RO', workspace: '/w/ro' })).rejects.toThrow();
    await until(() => c.storage.current().condition === 'unwritable', 'unwritable');
    disk.ioError();
    await expect(c.commands.createProject({ name: 'IO', workspace: '/w/io' })).rejects.toThrow();
    await until(() => c.storage.current().condition === 'unavailable', 'unavailable');
  });

  it('a permanent refusal while agent events are held is unwritable', () => {
    const c = compose();
    const monitor = new StorageMonitor({
      log: c.log,
      state: () => ({
        held: 3,
        bytes: 900,
        dropped: 1,
        since: '2026-10-06T10:00:00.000Z',
        error: 'attempt to write a readonly database',
        code: 'SQLITE_READONLY',
        permanent: true,
      }),
    });
    cleanups.push(() => monitor.dispose());
    expect(monitor.check()).toEqual({
      condition: 'unwritable',
      held: 3,
      dropped: 1,
      since: '2026-10-06T10:00:00.000Z',
      error: 'attempt to write a readonly database',
    });
  });

  it('publishes a change of counts alone at most once per interval, a change of condition at once', async () => {
    const c = compose();
    let held = 0;
    let now = 0;
    const monitor = new StorageMonitor({
      log: c.log,
      state: () => ({ held, bytes: held * 100, dropped: 0, permanent: false, code: 'SQLITE_FULL' }),
      minIntervalMs: 1_000,
      pollMs: 60_000,
      now: () => now,
    });
    cleanups.push(() => monitor.dispose());
    const seen: number[] = [];
    monitor.subscribe((h) => seen.push(h.held));
    held = 1;
    monitor.check();
    held = 2;
    now = 100;
    monitor.check();
    held = 3;
    now = 200;
    monitor.check();
    expect(seen).toEqual([1]);
    now = 1_000;
    held = 4;
    monitor.check();
    expect(seen).toEqual([1, 4]);
    held = 0;
    now = 1_001;
    monitor.check();
    expect(seen).toEqual([1, 4, 0]);
  });
});

describe('storage health over the socket and REST (P8-09)', () => {
  async function app(c: ComposedRuntime) {
    const t = await startTestApp({
      log: c.log,
      statuses: c.statuses,
      transcripts: c.transcripts,
      runtime: c.runtime,
      commands: c.commands,
      storage: c.storage,
    });
    cleanups.push(() => t.stop());
    const post = async (path: string, body: unknown = {}) => {
      const res = await fetch(`${t.baseUrl}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const open = (hello: Record<string, unknown> = {}) => {
      const ws = new WebSocket(t.wsUrl);
      const messages: ServerMessage[] = [];
      ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN, ...hello })));
      cleanups.push(() => ws.close());
      const storage = () =>
        messages.flatMap((m) =>
          (m.type === 'status' || m.type === 'snapshot') && m.storage ? [m.storage] : [],
        );
      return { messages, storage };
    };
    return { t, post, open };
  }

  it('the snapshot carries the storage health, and a change goes out as a replacing status', async () => {
    const c = compose();
    const disk = diskOf(c.log);
    const { open, post } = await app(c);
    const steward = await busySteward(c);
    const client = open();
    await until(() => client.messages.some((m) => m.type === 'snapshot'), 'the snapshot');
    expect(client.storage()).toEqual([{ condition: 'ok', held: 0, dropped: 0 }]);

    disk.fill();
    await until(() => client.storage().some((s) => s.condition === 'full'), 'the full disk', 1_000);
    const message = client.messages.find(
      (m) => m.type === 'status' && m.storage?.condition === 'full',
    ) as Extract<ServerMessage, { type: 'status' }>;
    // The whole record set with it: a page built before `storage` reads a replacing set.
    expect(message.replace).toBe(true);
    expect(message.statuses.map((s) => s.agentId)).toContain(steward);

    // A refused action: 507 `storage_full`, in the user's words; nothing done.
    const seq = c.log.currentSeq();
    const paused = await post(`/api/agents/${steward}/pause`);
    expect(paused).toEqual({
      status: 507,
      body: {
        error: 'storage_full',
        message: expect.stringMatching(/^The disk is full: your action was not saved/),
      },
    });
    const control = await post('/api/control', {
      target: { kind: 'agent', id: steward },
      action: { action: 'stop' },
    });
    expect(control.status).toBe(507);
    expect(control.body['error']).toBe('storage_full');
    const sent = await post(`/api/agents/${steward}/send`, { text: 'hello?' });
    expect(sent.status).toBe(507);
    expect(c.log.currentSeq()).toBe(seq);

    // A client that connects meanwhile gets it in its snapshot; one that resumes, after caught_up.
    const late = open();
    await until(() => late.messages.some((m) => m.type === 'snapshot'), 'the late snapshot');
    expect(late.storage()[0]?.condition).toBe('full');
    const resumed = open({ lastEventId: seq, logId: c.log.logId });
    await until(() => resumed.storage().length > 0, 'the resumed client storage');
    expect(resumed.messages.map((m) => m.type).slice(0, 2)).toEqual(['caught_up', 'status']);
    expect(resumed.storage()[0]?.condition).toBe('full');

    disk.restore();
    c.runtime.writeHeld();
    await until(() => client.storage().at(-1)?.condition === 'ok', 'the banner to clear', 2_000);
    expect((await post(`/api/agents/${steward}/send`, { text: 'hello?' })).status).not.toBe(507);
  });

  it('a read-only database is 503 storage_unwritable, an I/O error 503 storage_unavailable', async () => {
    const c = compose();
    const disk = diskOf(c.log);
    const { post } = await app(c);
    const create = () =>
      post('/api/control', {
        target: { kind: 'project', id: 'p-none' },
        action: { action: 'pause' },
      });
    // An unknown target is a 404 before anything is written: make one that writes.
    const project = (await c.commands.createProject({ name: 'Docs', workspace: '/w/docs' })).value;
    const pause = () =>
      post('/api/control', {
        target: { kind: 'project', id: project.id },
        action: { action: 'pause' },
      });
    expect((await create()).status).toBe(404);

    disk.readOnly();
    const ro = await pause();
    expect(ro.status).toBe(503);
    expect(ro.body).toEqual({
      error: 'storage_unwritable',
      message: expect.stringMatching(/read-only or missing/),
    });
    disk.ioError();
    const io = await pause();
    expect(io.status).toBe(503);
    expect(io.body['error']).toBe('storage_unavailable');
    disk.restore();
    expect((await pause()).status).toBe(200);
  });

  it('a storage failure that escapes a route is answered 507, not 500', async () => {
    const c = compose();
    const config = testConfig();
    const built = buildApp({ config, log: c.log });
    cleanups.push(async () => {
      await built.close();
      if ('cleanup' in config) (config as { cleanup: () => void }).cleanup();
    });
    built.fastify.get('/boom', async () => {
      throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    });
    const res = await built.fastify.inject({
      method: 'GET',
      url: '/boom',
      headers: { host: '127.0.0.1' },
    });
    expect(res.statusCode).toBe(507);
    expect(res.json<{ error: string }>().error).toBe('storage_full');
  });
});
