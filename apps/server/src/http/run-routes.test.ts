import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RunOutputResponse,
  RunPreviewResponse,
  RunsResponse,
  StartRunResponse,
  type Actor,
  type RunOutputMessage,
} from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createProject } from '../domain/projects.js';
import { composeRuntime } from '../runtime/compose.js';
import { MemoryProcessStore } from '../runtime/process-store.js';
import { ProcessSupervisor } from '../runtime/supervisor.js';
import { connectWs, startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * P9-08 — the runs' routes and the run output stream (TECHNOLOGY §9.8, §9.9; SPEC decision 131):
 * the phone follows and stops a run, never starts or restarts one (`autoApproveRemote` or not);
 * a stale confirmation is refused with the current row; a launch the disk cannot record is 507.
 */

const USER: Actor = { type: 'user' };
const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function eventually(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const storageFull = () =>
  Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });

async function setup(opts: { autoApproveRemote?: boolean; diskFull?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-p908-routes-')));
  const ws = join(root, 'app');
  mkdirSync(ws);
  const store = new MemoryProcessStore();
  if (opts.diskFull) {
    store.addLaunch = () => {
      throw storageFull();
    };
  }
  const supervisor = new ProcessSupervisor({ store, defaults: { graceMs: 300, termMs: 300 } });
  const composed = composeRuntime(openDatabase(':memory:'), {
    deliverables: { dataDir: join(root, 'data'), home: join(root, 'home') },
    runs: { supervisor, termMs: 1_000, flushMs: 20, holdMs: 20 },
    ...(opts.autoApproveRemote ? { autoApproveRemote: true } : {}),
  });
  const config = testConfig({ autoApproveRemote: opts.autoApproveRemote ?? false });
  const t = await startTestApp({
    config,
    log: composed.log,
    commands: composed.commands,
    runs: { service: composed.runs!, output: composed.runOutput! },
  });
  cleanups.push(async () => {
    await t.stop();
    await composed.dispose();
    await supervisor.dispose({ graceMs: 100, termMs: 100 });
    rmSync(root, { recursive: true, force: true });
  });
  const project = composed.log.runCommand((ctx) =>
    createProject(ctx, { name: 'App', workspace: ws, bodyId: 'b-saturn' }),
  ).value;
  const command = async (line: string) =>
    (
      await composed.commands.addDeliverable(
        {
          projectId: project.id,
          kind: 'command',
          title: 'Dev',
          source: 'user',
          command: { line, cwd: ws },
        },
        USER,
        { origin: 'local' },
      )
    ).value;
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    token: string | null = TEST_TOKEN,
  ) => {
    const res = await fetch(`${t.baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  return { t, composed, command, call, ws };
}

describe('the run routes (P9-08)', () => {
  it('starts on the Mac, lists, pages the output, previews and stops', async () => {
    const s = await setup();
    const d = await s.command('echo hello; sleep 30');
    const preview = await s.call('GET', `/api/deliverables/${d.id}/run-preview`);
    expect(preview.status).toBe(200);
    expect(RunPreviewResponse.parse(preview.json)).toMatchObject({
      line: 'echo hello; sleep 30',
      cwd: s.ws,
      version: d.version,
    });
    const started = await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version });
    expect(started.status).toBe(201);
    const { run } = StartRunResponse.parse(started.json);
    await eventually(async () => {
      const out = await s.call('GET', `/api/runs/${run.id}/output?after=0`);
      return RunOutputResponse.parse(out.json).chunks.some((c) => c.chunk.includes('hello'));
    });
    const list = RunsResponse.parse((await s.call('GET', `/api/deliverables/${d.id}/runs`)).json);
    expect(list.runs.map((r) => [r.id, r.state])).toEqual([[run.id, 'running']]);
    // A second Run while one lives.
    const again = await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version });
    expect(again).toMatchObject({ status: 409, json: { error: 'running' } });
    const stopped = await s.call('POST', `/api/runs/${run.id}/stop`);
    expect(stopped.status).toBe(200);
    expect(StartRunResponse.parse(stopped.json).run).toMatchObject({
      state: 'ended',
      outcome: 'stopped',
      stoppedBy: USER,
    });
    expect((await s.call('GET', `/api/runs/${run.id}/output`, undefined, {}, null)).status).toBe(
      401,
    );
  }, 20_000);

  it('refuses a stale confirmation with the current row, and a bad body', async () => {
    const s = await setup();
    const d = await s.command('echo one');
    await s.composed.commands.updateDeliverable(
      d.id,
      { command: { line: 'echo two', cwd: s.ws } },
      USER,
      {
        origin: 'local',
      },
    );
    const stale = await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      error: 'stale',
      deliverable: { id: d.id, command: { line: 'echo two' } },
    });
    expect((await s.call('POST', `/api/deliverables/${d.id}/runs`, {})).status).toBe(400);
    expect((await s.call('POST', '/api/deliverables/nope/runs', { version: 1 })).status).toBe(404);
  });

  for (const autoApproveRemote of [false, true]) {
    it(`a remote client may stop a run, never start or restart one (autoApproveRemote ${autoApproveRemote})`, async () => {
      const s = await setup({ autoApproveRemote });
      const d = await s.command('sleep 30');
      const start = await s.call(
        'POST',
        `/api/deliverables/${d.id}/runs`,
        { version: d.version },
        REMOTE,
      );
      expect(start).toMatchObject({ status: 403, json: { error: 'remote_control' } });
      expect(s.composed.runs!.liveCount).toBe(0);
      const { run } = StartRunResponse.parse(
        (await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version })).json,
      );
      const restart = await s.call(
        'POST',
        `/api/runs/${run.id}/restart`,
        { version: d.version },
        REMOTE,
      );
      expect(restart).toMatchObject({ status: 403, json: { error: 'remote_control' } });
      expect(s.composed.log.tables.runs.get(run.id)?.state).toBe('running');
      // Viewing works from the phone…
      expect(
        (await s.call('GET', `/api/deliverables/${d.id}/run-preview`, undefined, REMOTE)).status,
      ).toBe(200);
      expect((await s.call('GET', `/api/runs/${run.id}/output`, undefined, REMOTE)).status).toBe(
        200,
      );
      // …and so does Stop.
      const stop = await s.call('POST', `/api/runs/${run.id}/stop`, undefined, REMOTE);
      expect(stop.status).toBe(200);
      expect(s.composed.log.tables.runs.get(run.id)).toMatchObject({ outcome: 'stopped' });
    }, 20_000);
  }

  it('restarts on the Mac: the old run stops, a new one starts with the confirmation', async () => {
    const s = await setup();
    const d = await s.command('sleep 30');
    const first = StartRunResponse.parse(
      (await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version })).json,
    ).run;
    const stale = await s.call('POST', `/api/runs/${first.id}/restart`, { version: d.version + 1 });
    expect(stale.json).toMatchObject({ error: 'stale' });
    expect(s.composed.log.tables.runs.get(first.id)?.state).toBe('running'); // nothing stopped
    const restarted = await s.call('POST', `/api/runs/${first.id}/restart`, { version: d.version });
    expect(restarted.status).toBe(201);
    const second = StartRunResponse.parse(restarted.json).run;
    expect(second.id).not.toBe(first.id);
    expect(s.composed.log.tables.runs.get(first.id)).toMatchObject({ outcome: 'stopped' });
    await s.call('POST', `/api/runs/${second.id}/stop`);
  }, 20_000);

  it('answers 507 when the launch cannot be recorded (a full disk), starting nothing', async () => {
    const s = await setup({ diskFull: true });
    const d = await s.command('echo never');
    const res = await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version });
    expect(res).toMatchObject({ status: 507, json: { error: 'storage_full' } });
    expect(s.composed.log.tables.runs.of(d.id)).toEqual([]);
    expect(s.composed.runs!.liveCount).toBe(0);
  });

  it('streams a run’s output to a socket that subscribed (run.subscribe → run_output)', async () => {
    const s = await setup();
    const d = await s.command('echo streamed-line; sleep 30');
    const { run } = StartRunResponse.parse(
      (await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version })).json,
    );
    const outcome = await connectWs(s.t.wsUrl, {
      send: [
        { type: 'hello', token: TEST_TOKEN },
        { type: 'run.subscribe', runId: run.id, since: 0 },
      ],
      until: (messages) =>
        messages.some(
          (m) =>
            m.type === 'run_output' &&
            (m as RunOutputMessage).chunks.some((c) => c.chunk.includes('streamed-line')),
        ),
    });
    expect(outcome.error).toBeUndefined();
    const batch = outcome.messages.find((m) => m.type === 'run_output') as RunOutputMessage;
    expect(batch.runId).toBe(run.id);
    await s.call('POST', `/api/runs/${run.id}/stop`);
  }, 20_000);
});
