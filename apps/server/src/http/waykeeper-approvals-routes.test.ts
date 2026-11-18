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
import { addSendGrant } from '../domain/send-grants.js';
import { standaloneOf } from '../domain/waykeeper-approvals.js';

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

/** The log's clock, moved by the tests (marks count `APPROVAL_MARK_DAYS`). */
let now = Date.parse('2026-11-14T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

async function setup(opts: { rulesPeer?: PeerCheck } = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-wkap-')));
  now = Date.parse('2026-11-14T10:00:00.000Z');
  composed = composeRuntime(openDatabase(':memory:'), {
    log: { now: () => new Date(now).toISOString() },
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
  it('turns on and off from anywhere, the phone too', async () => {
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
      { on: true, auto: true },
      REMOTE,
    );
    expect(remote.status).toBe(200);
    expect(project(p.id)).toMatchObject({ waykeeperApprovals: true, waykeeperAuto: true });
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

/** A Steward of `p` and a `permission.decided` of it, logged now; returns the event's seq. */
async function decided(
  p: Project,
  over: {
    waykeeperApproval?: boolean;
    /** The event's cwd from the task id; `null` logs none (an approval from before P13-16). */
    cwd?: (taskId: Id) => string | null;
    command?: (taskId: Id) => string;
    /** Sets the task's worktree path. */
    worktreePath?: (taskId: Id) => string;
  } = {},
): Promise<number> {
  const task = (await composed.commands.createTask({ projectId: p.id, description: 'clean up' }))
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
  const command = over.command?.(task.id) ?? 'rm -rf node_modules';
  const cwd = over.cwd ? over.cwd(task.id) : p.workspace;
  if (over.worktreePath) {
    const row = composed.log.tables.tasks.get(task.id)!;
    composed.log.tables.tasks.upsert({ ...row, worktreePath: over.worktreePath(task.id) });
  }
  composed.log.runCommand((ctx) =>
    ctx.emit({
      type: 'permission.decided',
      agentId: spawned.agent.id,
      toolCall: { toolName: 'Bash', input: { command } },
      decision: 'allow',
      action: 'destructive',
      decidedBy: { type: 'agent', id: 'a-waykeeper' },
      ...(over.waykeeperApproval === false ? {} : { waykeeperApproval: true as const }),
      parts: [{ text: command, categories: ['destructive'] }],
      ...(cwd !== null ? { cwd } : {}),
    }),
  );
  return composed.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .filter((e) => e.event.type === 'permission.decided')
    .at(-1)!.seq;
}

const types = () => composed.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event.type);

describe('approval marks (P13-16)', () => {
  it('a mark from a 2-day-old Waykeeper approval, from a remote client; DELETE removes it', async () => {
    await setup();
    const p = await newProject();
    const seq = await decided(p);
    now += 2 * DAY;
    const made = await call('POST', `/api/projects/${p.id}/approval-marks`, { seq }, REMOTE);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      ok: true,
      mark: {
        projectId: p.id,
        match: {
          kind: 'folder',
          category: 'destructive',
          // The Steward's own worktree is kept as a token: the mark binds every Steward.
          paths: ['{worktree}/node_modules'],
        },
        example: 'rm -rf node_modules',
        fromSeq: seq,
        origin: 'remote',
        createdBy: { type: 'user' },
      },
    });
    expect(types()).toContain('approval_mark.added');
    expect(project(p.id).approvalMarks).toHaveLength(1);
    const id = (made.body['mark'] as { id: string }).id;
    const gone = await call(
      'DELETE',
      `/api/projects/${p.id}/approval-marks/${id}`,
      undefined,
      REMOTE,
    );
    expect(gone).toEqual({ status: 200, body: { ok: true } });
    expect(types()).toContain('approval_mark.removed');
    expect(project(p.id).approvalMarks).toBeUndefined();
    expect((await call('DELETE', `/api/projects/${p.id}/approval-marks/${id}`)).status).toBe(404);
  });

  it('refuses an approval older than 10 days, one not the Waykeeper’s, another project’s, an unknown seq', async () => {
    await setup();
    const p = await newProject();
    const old = await decided(p);
    const plain = await decided(p, { waykeeperApproval: false });
    const otherWs = join(root, 'other');
    mkdirSync(otherWs);
    const other = (await composed.commands.createProject({ name: 'other', workspace: otherWs }))
      .value;
    const theirs = await decided(other);
    now += 11 * DAY;
    const post = (seq: unknown) => call('POST', `/api/projects/${p.id}/approval-marks`, { seq });
    for (const seq of [old, plain, theirs, 99_999]) {
      const res = await post(seq);
      expect(res.status, `seq ${String(seq)}`).toBe(400);
      expect(res.body['error']).toBe('invalid');
    }
    // `theirs` is refused for the project, not for its age: it is fine on its own project.
    now -= 10 * DAY;
    expect((await post(theirs)).status).toBe(400);
    expect(
      (await call('POST', `/api/projects/${other.id}/approval-marks`, { seq: theirs })).status,
    ).toBe(200);
    expect((await post('x')).status).toBe(400);
    expect(project(p.id).approvalMarks).toBeUndefined();
    expect(types()).not.toContain('approval_mark.removed');
  });

  it('refuses a fresh approval that is not the Waykeeper’s', async () => {
    await setup();
    const p = await newProject();
    const plain = await decided(p, { waykeeperApproval: false });
    now += 1 * DAY;
    const res = await call('POST', `/api/projects/${p.id}/approval-marks`, { seq: plain });
    expect(res.status).toBe(400);
    expect(res.body['error']).toBe('invalid');
    expect(project(p.id).approvalMarks).toBeUndefined();
  });

  const pathsOf = (body: Record<string, unknown>) =>
    (body['mark'] as { match: { paths?: string[] } }).match.paths;

  it('an approval logged without a cwd falls back to the task’s worktree, kept as a token', async () => {
    await setup();
    const p = await newProject();
    const wt = (id: Id) => join(p.workspace, '.galactic', 'worktrees', id);
    const seq = await decided(p, { cwd: () => null, worktreePath: wt });
    const made = await call('POST', `/api/projects/${p.id}/approval-marks`, { seq });
    expect(made.status).toBe(200);
    expect(pathsOf(made.body)).toEqual(['{worktree}/node_modules']);
  });

  it('without a cwd or a worktree, the project workspace is the root, kept as a token', async () => {
    await setup();
    const p = await newProject();
    const seq = await decided(p, { cwd: () => null });
    const made = await call('POST', `/api/projects/${p.id}/approval-marks`, { seq });
    expect(made.status).toBe(200);
    expect(pathsOf(made.body)).toEqual(['{worktree}/node_modules']);
  });

  it('derives the scratch folder from the approval’s cwd, not the project’s spelling', async () => {
    await setup();
    const p = await newProject();
    // Another spelling of the workspace (a symlink, /private/var for /var): the Steward's cwd.
    const ws = join(root, 'alias');
    const seq = await decided(p, {
      cwd: (id) => join(ws, '.galactic', 'worktrees', id),
      command: (id) => `rm -rf ${join(ws, '.galactic', 'scratch', id, 'out')}`,
    });
    const made = await call('POST', `/api/projects/${p.id}/approval-marks`, { seq });
    expect(made.status).toBe(200);
    expect(pathsOf(made.body)).toEqual(['{scratch}/out']);
  });

  it('is refused to an agent’s process (403 agent_peer)', async () => {
    await setup({ rulesPeer: async () => ({ refused: 'from an agent' }) });
    const p = await newProject();
    expect((await call('POST', `/api/projects/${p.id}/approval-marks`, { seq: 1 })).status).toBe(
      403,
    );
    expect((await call('DELETE', `/api/projects/${p.id}/approval-marks/x`)).status).toBe(403);
  });
});

describe('PUT /api/projects/:id/waykeeper-approvals with auto (P13-16)', () => {
  it('turns Auto on from the Mac', async () => {
    await setup();
    const p = await newProject();
    const res = await call('PUT', `/api/projects/${p.id}/waykeeper-approvals`, {
      on: true,
      auto: true,
    });
    expect(res.status).toBe(200);
    expect(project(p.id)).toMatchObject({ waykeeperApprovals: true, waykeeperAuto: true });
  });
});

/** A Waykeeper-style approval of a standalone task's Steward (no project), logged; its seq. */
async function standaloneDecided(over: { waykeeperApproval?: boolean } = {}): Promise<number> {
  const task = (await composed.commands.createTask({ description: 'tidy up' })).value;
  const ws = join(root, 'loose');
  mkdirSync(ws, { recursive: true });
  const spawned = await composed.runtime.spawn({
    role: 'steward',
    runtime: 'fake',
    prompt: 'scenario:idle',
    cwd: ws,
    taskId: task.id,
  });
  if (!spawned.ok) throw new Error(spawned.reason);
  composed.log.runCommand((ctx) =>
    ctx.emit({
      type: 'permission.decided',
      agentId: spawned.agent.id,
      toolCall: { toolName: 'Bash', input: { command: 'curl https://api.example.com' } },
      decision: 'allow',
      action: 'network',
      decidedBy: { type: 'agent', id: 'a-harmonizer' },
      ...(over.waykeeperApproval === false ? {} : { waykeeperApproval: true as const }),
      parts: [{ text: 'curl https://api.example.com', categories: ['network'] }],
      cwd: ws,
    }),
  );
  return composed.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .filter((e) => e.event.type === 'permission.decided')
    .at(-1)!.seq;
}

describe('standalone approval marks (P13-30)', () => {
  it('a mark from a standalone approval, from a remote client; DELETE removes it, then 404', async () => {
    await setup();
    const seq = await standaloneDecided();
    const made = await call('POST', '/api/standalone/approval-marks', { seq }, REMOTE);
    expect(made.status).toBe(200);
    const mark = made.body['mark'] as Record<string, unknown>;
    expect(mark).toMatchObject({
      match: { kind: 'site', host: 'api.example.com' },
      fromSeq: seq,
      origin: 'remote',
    });
    expect(mark['projectId']).toBeUndefined();
    expect(standaloneOf(composed.log.tables).approvalMarks.map((m) => m.id)).toEqual([mark['id']]);
    const path = `/api/standalone/approval-marks/${String(mark['id'])}`;
    expect(await call('DELETE', path, undefined, REMOTE)).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(standaloneOf(composed.log.tables).approvalMarks).toEqual([]);
    expect((await call('DELETE', path)).status).toBe(404);
  });

  it('refuses a project’s approval on the standalone route, and a standalone one on a project’s', async () => {
    await setup();
    const p = await newProject();
    const ours = await decided(p);
    const loose = await standaloneDecided();
    const plain = await standaloneDecided({ waykeeperApproval: false });
    for (const seq of [ours, plain]) {
      const res = await call('POST', '/api/standalone/approval-marks', { seq });
      expect(res.status, `seq ${seq}`).toBe(400);
      expect(res.body['error']).toBe('invalid');
    }
    const res = await call('POST', `/api/projects/${p.id}/approval-marks`, { seq: loose });
    expect(res.status).toBe(400);
    expect(standaloneOf(composed.log.tables).approvalMarks).toEqual([]);
    expect(project(p.id).approvalMarks).toBeUndefined();
  });

  it('is refused to an agent’s process (403 agent_peer)', async () => {
    await setup({ rulesPeer: async () => ({ refused: 'from an agent' }) });
    expect((await call('POST', '/api/standalone/approval-marks', { seq: 1 })).status).toBe(403);
    expect((await call('DELETE', '/api/standalone/approval-marks/x')).status).toBe(403);
  });
});

describe('DELETE send grants (P13-30)', () => {
  const grant = (projectId?: Id) =>
    composed.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          ...(projectId !== undefined ? { projectId } : {}),
          words: 'post it today',
          summary: 'Instagram posts today',
          createdBy: { type: 'user' },
          origin: 'local',
          questionId: 'q-1',
        },
        now,
      ),
    ).value;

  it('removes a project’s grant and a standalone one, from a remote client; another scope’s is 404', async () => {
    await setup();
    const p = await newProject();
    const ours = grant(p.id);
    const loose = grant();
    expect((await call('DELETE', `/api/standalone/send-grants/${ours.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/projects/${p.id}/send-grants/${loose.id}`)).status).toBe(
      404,
    );
    expect(
      await call('DELETE', `/api/projects/${p.id}/send-grants/${ours.id}`, undefined, REMOTE),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(project(p.id).sendGrants).toBeUndefined();
    expect(
      await call('DELETE', `/api/standalone/send-grants/${loose.id}`, undefined, REMOTE),
    ).toEqual({ status: 200, body: { ok: true } });
    expect(standaloneOf(composed.log.tables).sendGrants).toEqual([]);
    expect(types().filter((t) => t === 'send_grant.removed')).toHaveLength(2);
    expect((await call('DELETE', `/api/standalone/send-grants/${loose.id}`)).status).toBe(404);
  });

  it('is refused to an agent’s process (403 agent_peer)', async () => {
    await setup({ rulesPeer: async () => ({ refused: 'from an agent' }) });
    expect((await call('DELETE', '/api/standalone/send-grants/x')).status).toBe(403);
    expect((await call('DELETE', '/api/projects/p/send-grants/x')).status).toBe(403);
  });
});

describe('GET /api/history/standalone-decisions (P13-30)', () => {
  it('returns the decisions of agents in no project, not a project’s', async () => {
    await setup();
    const p = await newProject();
    await decided(p);
    const loose = await standaloneDecided();
    const res = await call('GET', '/api/history/standalone-decisions?limit=10');
    expect(res.status).toBe(200);
    const seqs = (res.body['events'] as { seq: number }[]).map((e) => e.seq);
    expect(seqs).toEqual([loose]);
    expect(res.body['hasMore']).toBe(false);
  });
});
