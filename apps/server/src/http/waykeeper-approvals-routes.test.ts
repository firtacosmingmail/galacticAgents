import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Project, RecordedApproval, WaykeeperForward } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';
import type { PeerCheck } from './peer-guard.js';

/**
 * P13-05: the routes of the Waykeeper approvals — the standing approval from a forwarded card,
 * the project's switch, the removal — and their codes (403 `remote_control` and `agent_peer`, 400
 * for a request that cannot become one, 404, 409 for a card answered already).
 */

const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };
const rec = (i: number): RecordedApproval => ({
  kind: 'run the test suite',
  summary: `Bash {"command":"pnpm test ${i}"}`,
  agentId: 'a-0',
  questionId: `q-${i}`,
  at: '2026-11-09T10:00:00.000Z',
});
const THREE = [rec(1), rec(2), rec(3)];

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;
let root: string;

async function setup(opts: { rulesPeer?: PeerCheck } = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-wkap-')));
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 0, scenarios: { idle: { steps: [{ kind: 'idle' }] } } })],
    flushMs: 10,
    caps: { maxConcurrentAgents: 6 },
  });
  t = await startTestApp({
    config: testConfig({ autoApproveRemote: false }),
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
    ...(opts.rulesPeer ? { rulesPeer: opts.rulesPeer } : {}),
  });
}
afterEach(async () => {
  await composed?.dispose();
  await t?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const project = (id: Id) => composed.log.tables.projects.get(id)!;

async function newProject(): Promise<Project> {
  const ws = join(root, 'app');
  mkdirSync(ws);
  return (await composed.commands.createProject({ name: 'app', workspace: ws })).value;
}

/** A forwarded permission question of a Steward of `p` (as the approval watch opens one). */
async function forwarded(p: Project, over: Partial<WaykeeperForward> = {}): Promise<Id> {
  const task = (await composed.commands.createTask({ projectId: p.id, description: 'fix it' }))
    .value;
  const spawned = await composed.runtime.spawn({
    role: 'steward',
    runtime: 'fake',
    prompt: 'scenario:idle',
    cwd: p.workspace,
    projectId: p.id,
    taskId: task.id,
  });
  if (!spawned.ok) throw new Error(spawned.reason);
  const command = 'pnpm test 9';
  return (
    await composed.commands.openQuestion({
      kind: 'permission',
      originAgentId: spawned.agent.id,
      context: {
        text: 'run pnpm test?',
        toolCall: { toolName: 'Bash', input: { command } },
        waykeeper: {
          reason: 'not said',
          kind: 'run the test suite',
          parts: [{ text: command, categories: ['run_workspace'] }],
          similar: THREE,
          ...over,
        },
      },
    })
  ).value.id;
}

describe('POST /api/questions/:id/standing-approval', () => {
  it('answers allow and stores the approval, from a remote client too; a second call is 409', async () => {
    await setup();
    const p = await newProject();
    const q = await forwarded(p);
    const made = await call('POST', `/api/questions/${q}/standing-approval`, {}, REMOTE);
    expect(made.status).toBe(200);
    expect(made.body['approval']).toMatchObject({
      projectId: p.id,
      kind: 'run the test suite',
      origin: 'remote',
      questionId: q,
    });
    expect(composed.log.tables.questions.get(q)).toMatchObject({
      status: 'answered',
      answer: 'allow',
    });
    expect(project(p.id).standingApprovals).toHaveLength(1);
    const again = await call('POST', `/api/questions/${q}/standing-approval`, {});
    expect(again.status).toBe(409);
    expect(project(p.id).standingApprovals).toHaveLength(1);
  });

  it('refuses a card with too few similar approvals or a push with 400, an unknown one with 404', async () => {
    await setup();
    const p = await newProject();
    const few = await forwarded(p, { similar: [rec(1)] });
    expect((await call('POST', `/api/questions/${few}/standing-approval`, {})).status).toBe(400);
    const push = await forwarded(p, { parts: [{ text: 'git push', categories: ['push'] }] });
    expect((await call('POST', `/api/questions/${push}/standing-approval`, {})).status).toBe(400);
    expect(composed.log.tables.questions.get(push)?.status).toBe('open');
    expect((await call('POST', '/api/questions/nope/standing-approval', {})).status).toBe(404);
    expect(
      (await call('POST', `/api/questions/${few}/standing-approval`, { version: -1 })).status,
    ).toBe(400);
  });

  it('is refused to an agent’s process (403 agent_peer)', async () => {
    await setup({ rulesPeer: async () => ({ refused: 'from an agent' }) });
    const p = await newProject();
    const q = await forwarded(p);
    const res = await call('POST', `/api/questions/${q}/standing-approval`, {});
    expect(res).toEqual({ status: 403, body: { error: 'agent_peer', message: 'from an agent' } });
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    expect(
      (await call('PUT', `/api/projects/${p.id}/waykeeper-approvals`, { on: false })).status,
    ).toBe(403);
    expect((await call('DELETE', `/api/projects/${p.id}/standing-approvals/x`)).status).toBe(403);
  });
});

describe('PUT /api/projects/:id/waykeeper-approvals', () => {
  it('turns on from the Mac, off from anywhere; on from remote is 403', async () => {
    await setup();
    const p = await newProject();
    expect(
      (await call('PUT', `/api/projects/${p.id}/waykeeper-approvals`, { on: true })).status,
    ).toBe(200);
    expect(project(p.id).waykeeperApprovals).toBe(true);
    expect(
      (await call('PUT', `/api/projects/${p.id}/waykeeper-approvals`, { on: false }, REMOTE))
        .status,
    ).toBe(200);
    expect(project(p.id).waykeeperApprovals).toBeUndefined();
    const remote = await call(
      'PUT',
      `/api/projects/${p.id}/waykeeper-approvals`,
      { on: true },
      REMOTE,
    );
    expect(remote.status).toBe(403);
    expect(remote.body['error']).toBe('remote_control');
    expect(project(p.id).waykeeperApprovals).toBeUndefined();
    expect(
      (await call('PUT', `/api/projects/${p.id}/waykeeper-approvals`, { on: 'yes' })).status,
    ).toBe(400);
    expect((await call('PUT', '/api/projects/nope/waykeeper-approvals', { on: true })).status).toBe(
      404,
    );
  });
});

describe('DELETE /api/projects/:id/standing-approvals/:approvalId', () => {
  it('removes from anywhere, then 404', async () => {
    await setup();
    const p = await newProject();
    const q = await forwarded(p);
    const made = await call('POST', `/api/questions/${q}/standing-approval`, {});
    const id = (made.body['approval'] as { id: string }).id;
    const gone = await call(
      'DELETE',
      `/api/projects/${p.id}/standing-approvals/${id}`,
      undefined,
      REMOTE,
    );
    expect(gone.status).toBe(200);
    expect(project(p.id).standingApprovals).toBeUndefined();
    expect((await call('DELETE', `/api/projects/${p.id}/standing-approvals/${id}`)).status).toBe(
      404,
    );
  });
});
