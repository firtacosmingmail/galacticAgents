import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_POLICY_PRESETS, type Event } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { FAKE_PTY_AGENT, FAKE_PTY_IDLE } from '../adapters/pty/fake-agent.js';
import { PtyAdapter } from '../adapters/pty/pty-adapter.js';
import { openDatabase, type Database } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { ProcessSupervisor } from '../runtime/supervisor.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * A terminal agent through the REST surface (P8-08): the user's typing (local only, never remote
 * — proposed decision 111 — and logged as their message), and the restart of an interrupted
 * terminal agent from its first prompt (it cannot resume).
 */

const cwd = mkdtempSync(join(tmpdir(), 'galactic-pty-routes-'));
const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };

let db: Database;
let supervisor: ProcessSupervisor;
let pty: PtyAdapter;
let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

/** A runtime with a fresh PTY adapter (disposing a composition disposes its adapters). */
const compose = () => {
  pty = new PtyAdapter({
    supervisor,
    agent: { command: 'bash', args: [FAKE_PTY_AGENT], idlePattern: FAKE_PTY_IDLE, quietMs: 120 },
    graceMs: 2_000,
  });
  return composeRuntime(db, { adapters: [new FakeAdapter({ speed: 1 }), pty], flushMs: 10 });
};

beforeEach(async () => {
  db = openDatabase(':memory:');
  supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  composed = compose();
  // `autoApproveRemote` lifts the other remote limits (decision 90), never this one.
  t = await startTestApp({
    config: testConfig({ autoApproveRemote: true }),
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
  });
});
afterEach(async () => {
  await composed.dispose();
  await pty.dispose();
  await supervisor.dispose();
  await t.stop();
  db.close();
});

const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const waitFor = (pred: () => boolean, what: string, ms = 8_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () =>
      pred()
        ? resolve()
        : Date.now() - t0 > ms
          ? reject(new Error(`timeout: ${what}`))
          : setTimeout(tick, 10);
    tick();
  });
const text = (agentId: string) => {
  composed.transcripts.flush();
  return composed.transcripts
    .read(agentId)
    .filter((c) => c.kind === 'text')
    .map((c) => c.text)
    .join('\n');
};
const events = (agentId: string): Event[] =>
  composed.log
    .eventsSince(0, 10_000)
    .map((e) => e.event)
    .filter((e) => 'agentId' in e && e.agentId === agentId);

async function spawnEcho() {
  const result = await composed.runtime.spawn({
    role: 'steward',
    runtime: 'pty',
    prompt: 'scenario:echo',
    cwd,
    permissionPolicy: PERMISSION_POLICY_PRESETS.trusted,
  });
  if (!result.ok) throw new Error(result.reason);
  await waitFor(() => composed.statuses.get(result.agent.id)?.state === 'idle', 'idle');
  return result.agent.id;
}

describe('POST /api/agents/:id/terminal (P8-08)', () => {
  it('types a line from the Mac and logs it as the user message; a remote client is refused', async () => {
    const id = await spawnEcho();
    const remote = await post(`/api/agents/${id}/terminal`, { text: 'from the phone' }, REMOTE);
    expect(remote.status).toBe(403);
    expect(remote.body).toMatchObject({ error: 'remote_control' });
    const local = await post(`/api/agents/${id}/terminal`, { text: 'by hand' });
    expect(local.status).toBe(200);
    await waitFor(() => text(id).includes('echo: by hand'), 'echo');
    expect(text(id)).not.toContain('from the phone');
    const sent = events(id).filter((e) => e.type === 'message.sent');
    expect(sent).toEqual([
      expect.objectContaining({ text: 'by hand', sender: { type: 'user' }, origin: 'local' }),
    ]);
    const messageId = (sent[0] as { messageId: string }).messageId;
    expect(local.body).toEqual({ messageId });
    expect(events(id)).toContainEqual({ type: 'message.delivered', messageId, agentId: id });
  });

  it('refuses an agent without a terminal and a bad body', async () => {
    const result = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd,
    });
    if (!result.ok) throw new Error(result.reason);
    const refused = await post(`/api/agents/${result.agent.id}/terminal`, { text: 'x' });
    expect(refused.status).toBe(409);
    expect(refused.body['message']).toMatch(/no terminal/);
    expect((await post(`/api/agents/${result.agent.id}/terminal`, {})).status).toBe(400);
  });
});

describe('restarting an interrupted terminal agent (P8-08)', () => {
  it('startup leaves it interrupted; the user restart starts it afresh from its first prompt', async () => {
    const id = await spawnEcho();
    await composed.runtime.shutdown();
    await waitFor(() => composed.statuses.get(id)?.state === 'interrupted', 'interrupted');
    await composed.dispose();
    composed = compose();
    const report = await composed.recover();
    expect(report.needAttention).toContain(id);
    expect(composed.statuses.get(id)?.state).toBe('interrupted');
    const restarted = await composed.runtime.recoverAgent(id);
    expect(restarted, JSON.stringify(restarted)).toMatchObject({ ok: true, mode: 'fresh' });
    await waitFor(() => composed.statuses.get(id)?.state === 'idle', 'idle after the restart');
    expect(events(id).filter((e) => e.type === 'agent.spawned')).toHaveLength(2);
  });
});
