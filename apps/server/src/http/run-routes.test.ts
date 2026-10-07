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
  /** The Run dialog's preview: the body a start (or restart) sends back. */
  const confirm = async (id: string, line?: string) => {
    const res =
      line === undefined
        ? await call('GET', `/api/deliverables/${id}/run-preview`)
        : await call('POST', `/api/deliverables/${id}/run-preview`, { line });
    const preview = RunPreviewResponse.parse(res.json);
    return {
      version: preview.version,
      confirmation: preview.confirmation!,
      ...(line !== undefined ? { line } : {}),
    };
  };
  return { t, composed, command, call, confirm, ws };
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
    const started = await s.call('POST', `/api/deliverables/${d.id}/runs`, await s.confirm(d.id));
    expect(started.status).toBe(201);
    const { run } = StartRunResponse.parse(started.json);
    await eventually(async () => {
      const out = await s.call('GET', `/api/runs/${run.id}/output?after=0`);
      return RunOutputResponse.parse(out.json).chunks.some((c) => c.chunk.includes('hello'));
    });
    const list = RunsResponse.parse((await s.call('GET', `/api/deliverables/${d.id}/runs`)).json);
    expect(list.runs.map((r) => [r.id, r.state])).toEqual([[run.id, 'running']]);
    // A second Run while one lives.
    const again = await s.call('POST', `/api/deliverables/${d.id}/runs`, await s.confirm(d.id));
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
    const before = await s.confirm(d.id);
    await s.composed.commands.updateDeliverable(
      d.id,
      { command: { line: 'echo two', cwd: s.ws } },
      USER,
      {
        origin: 'local',
      },
    );
    const stale = await s.call('POST', `/api/deliverables/${d.id}/runs`, before);
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      error: 'stale',
      deliverable: { id: d.id, command: { line: 'echo two' } },
    });
    expect((await s.call('POST', `/api/deliverables/${d.id}/runs`, {})).status).toBe(400);
    expect(
      (await s.call('POST', '/api/deliverables/nope/runs', { version: 1, confirmation: 'x' }))
        .status,
    ).toBe(404);
  });

  for (const autoApproveRemote of [false, true]) {
    it(`a remote client may stop a run, never start or restart one (autoApproveRemote ${autoApproveRemote})`, async () => {
      const s = await setup({ autoApproveRemote });
      const d = await s.command('sleep 30');
      const start = await s.call(
        'POST',
        `/api/deliverables/${d.id}/runs`,
        await s.confirm(d.id),
        REMOTE,
      );
      expect(start).toMatchObject({ status: 403, json: { error: 'remote_control' } });
      expect(s.composed.runs!.liveCount).toBe(0);
      const { run } = StartRunResponse.parse(
        (await s.call('POST', `/api/deliverables/${d.id}/runs`, await s.confirm(d.id))).json,
      );
      const restart = await s.call(
        'POST',
        `/api/runs/${run.id}/restart`,
        await s.confirm(d.id),
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
      (await s.call('POST', `/api/deliverables/${d.id}/runs`, await s.confirm(d.id))).json,
    ).run;
    const ok = await s.confirm(d.id);
    const stale = await s.call('POST', `/api/runs/${first.id}/restart`, {
      ...ok,
      version: d.version + 1,
    });
    expect(stale.json).toMatchObject({ error: 'stale' });
    expect(s.composed.log.tables.runs.get(first.id)?.state).toBe('running'); // nothing stopped
    // A confirmation of another line, or a folder that no longer passes: nothing stopped either.
    const other = await s.call('POST', `/api/runs/${first.id}/restart`, {
      ...ok,
      line: 'sleep 31',
    });
    expect(other).toMatchObject({ status: 400, json: { error: 'unconfirmed' } });
    expect(s.composed.log.tables.runs.get(first.id)?.state).toBe('running');
    rmSync(s.ws, { recursive: true, force: true });
    const gone = await s.call('POST', `/api/runs/${first.id}/restart`, ok);
    expect(gone).toMatchObject({ status: 409, json: { error: 'folder' } });
    expect(s.composed.log.tables.runs.get(first.id)?.state).toBe('running');
    mkdirSync(s.ws);
    const restarted = await s.call('POST', `/api/runs/${first.id}/restart`, ok);
    expect(restarted.status).toBe(201);
    const second = StartRunResponse.parse(restarted.json).run;
    expect(second.id).not.toBe(first.id);
    expect(s.composed.log.tables.runs.get(first.id)).toMatchObject({ outcome: 'stopped' });
    await s.call('POST', `/api/runs/${second.id}/stop`);
  }, 20_000);

  it('answers 507 when the launch cannot be recorded (a full disk), starting nothing', async () => {
    const s = await setup({ diskFull: true });
    const d = await s.command('echo never');
    const res = await s.call('POST', `/api/deliverables/${d.id}/runs`, await s.confirm(d.id));
    expect(res).toMatchObject({ status: 507, json: { error: 'storage_full' } });
    expect(s.composed.log.tables.runs.of(d.id)).toEqual([]);
    expect(s.composed.runs!.liveCount).toBe(0);
  });

  it('starts only the exact line the confirmation covers; an edited line is previewed first', async () => {
    const s = await setup();
    const d = await s.command('echo stored');
    const stored = await s.confirm(d.id);
    // The stored line's confirmation does not cover an edit (wave-3 review S3)…
    const swapped = await s.call('POST', `/api/deliverables/${d.id}/runs`, {
      ...stored,
      line: 'echo something-else',
    });
    expect(swapped).toMatchObject({ status: 400, json: { error: 'unconfirmed' } });
    // …nor does a made-up token, or none.
    const forged = await s.call('POST', `/api/deliverables/${d.id}/runs`, {
      ...stored,
      confirmation: `${Date.now().toString(36)}.AAAA`,
    });
    expect(forged).toMatchObject({ status: 400, json: { error: 'unconfirmed' } });
    expect(
      (await s.call('POST', `/api/deliverables/${d.id}/runs`, { version: d.version })).status,
    ).toBe(400);
    // The edited line's own preview classifies it, and its confirmation starts it.
    const preview = await s.call('POST', `/api/deliverables/${d.id}/run-preview`, {
      line: 'curl -s https://example.invalid || true',
    });
    expect(RunPreviewResponse.parse(preview.json).warnings).toContain('uses the network');
    const edited = await s.confirm(d.id, 'echo edited');
    const started = await s.call('POST', `/api/deliverables/${d.id}/runs`, edited);
    expect(started.status).toBe(201);
    expect(StartRunResponse.parse(started.json).run).toMatchObject({ line: 'echo edited' });
    expect(s.composed.log.tables.runs.of(d.id)).toHaveLength(1);
  }, 20_000);

  it('refuses an edited line with a newline or a control character (400), in the preview too', async () => {
    const s = await setup();
    const d = await s.command('echo stored');
    for (const line of ['echo a\nrm -rf x', 'echo a\rb', 'echo \u001b[2Jx', 'echo a\u2028b']) {
      const preview = await s.call('POST', `/api/deliverables/${d.id}/run-preview`, { line });
      expect(preview).toMatchObject({ status: 400, json: { error: 'invalid' } });
      const start = await s.call('POST', `/api/deliverables/${d.id}/runs`, {
        ...(await s.confirm(d.id)),
        line,
      });
      expect(start).toMatchObject({ status: 400, json: { error: 'invalid' } });
    }
    expect(s.composed.log.tables.runs.of(d.id)).toEqual([]);
  });

  it('logs and previews a line with a secret redacted, and runs the real one', async () => {
    const s = await setup();
    const key = `sk-ant-${'b'.repeat(40)}`;
    const d = await s.command('echo stored');
    const line = `TOKEN=${key} sh -c 'echo "$TOKEN" | wc -c'`;
    const preview = RunPreviewResponse.parse(
      (await s.call('POST', `/api/deliverables/${d.id}/run-preview`, { line })).json,
    );
    expect(preview.line).not.toContain(key);
    expect(preview.line).toContain('[redacted:');
    const started = await s.call('POST', `/api/deliverables/${d.id}/runs`, {
      version: preview.version,
      confirmation: preview.confirmation,
      line,
    });
    expect(started.status).toBe(201);
    const { run } = StartRunResponse.parse(started.json);
    expect(run.line).not.toContain(key);
    await eventually(() => s.composed.log.tables.runs.get(run.id)?.state === 'ended');
    // The real line ran: the key's length (plus the newline) came out.
    const out = RunOutputResponse.parse((await s.call('GET', `/api/runs/${run.id}/output`)).json);
    expect(out.chunks.map((c) => c.chunk).join('')).toContain(String(key.length + 1));
    const events = JSON.stringify(s.composed.log.tables.runs.of(d.id));
    expect(events).not.toContain(key);
    // The mask itself is never run: an edit must type the secret again.
    const masked = await s.call('POST', `/api/deliverables/${d.id}/run-preview`, {
      line: preview.line,
    });
    expect(masked).toMatchObject({ status: 400, json: { error: 'invalid' } });
  }, 20_000);

  it('streams a run’s output to a socket that subscribed (run.subscribe → run_output)', async () => {
    const s = await setup();
    const d = await s.command('echo streamed-line; sleep 30');
    const { run } = StartRunResponse.parse(
      (await s.call('POST', `/api/deliverables/${d.id}/runs`, await s.confirm(d.id))).json,
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
