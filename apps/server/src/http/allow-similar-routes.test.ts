import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, EventOfType, Id, Project } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { addPermissionRule } from '../domain/project-rules.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';
import type { PeerCheck } from './peer-guard.js';

/**
 * P9-17 (SPEC decision 138): "Allow similar" from a permission card — the preview, the answer
 * that stores a rule, the rule allowing the next matching request of the project (logged as
 * allowed by the rule), other projects still asking, removal, and the routes' origin and agent
 * checks; the rules end with their project.
 */

const SCENARIOS: Record<string, FakeScenario> = {
  installs: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'npm install left-pad' },
        permissionAction: 'network',
      },
      { kind: 'tool_call', toolName: 'Bash', input: { command: 'npm install right-pad' } },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'npm install x; rm -rf ~' },
        permissionAction: 'network',
      },
      { kind: 'output', text: 'installed' },
      { kind: 'idle' },
    ],
  },
  pushes: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        permissionAction: 'push',
      },
      { kind: 'idle' },
    ],
  },
};

const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;
let root: string;

async function setup(opts: { autoApproveRemote?: boolean; rulesPeer?: PeerCheck } = {}) {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-rules-')));
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 0, scenarios: SCENARIOS })],
    flushMs: 10,
    caps: { maxConcurrentAgents: 6 },
    ...(opts.autoApproveRemote ? { autoApproveRemote: true } : {}),
  });
  t = await startTestApp({
    config: testConfig({ autoApproveRemote: opts.autoApproveRemote ?? false }),
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
const waitFor = (pred: () => boolean, what: string, ms = 3_000) =>
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
const events = <T extends Event['type']>(type: T) =>
  composed.log
    .eventsSince(0)
    .map((e) => e.event)
    .filter((e): e is EventOfType<T> => e.type === type);
const pending = (id: Id) => composed.statuses.get(id)?.pendingQuestionId;
const project = (id: Id) => composed.log.tables.projects.get(id)!;
const ran = (agentId: Id, command: string) =>
  events('agent.tool_call').some(
    (e) =>
      e.agentId === agentId && (e.input as { command?: string } | undefined)?.command === command,
  );

async function newProject(name: string): Promise<Project> {
  const ws = join(root, name);
  mkdirSync(ws);
  return (await composed.commands.createProject({ name, workspace: ws })).value;
}

async function spawn(
  p: Project,
  role: 'steward' | 'waykeeper',
  scenario: keyof typeof SCENARIOS,
): Promise<Id> {
  const taskId =
    role === 'steward'
      ? (await composed.commands.createTask({ projectId: p.id, description: `t ${scenario}` }))
          .value.id
      : undefined;
  const result = await composed.runtime.spawn({
    role,
    runtime: 'fake',
    prompt: `scenario:${scenario}`,
    cwd: p.workspace,
    projectId: p.id,
    ...(taskId ? { taskId } : {}),
  });
  if (!result.ok) throw new Error(result.reason);
  return result.agent.id;
}

describe('"Allow similar" (P9-17)', () => {
  it('previews, stores the rule with the answer, and the project’s next matching request runs', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'first request');
    const q1 = pending(steward)!;
    const version = composed.log.tables.questions.get(q1)!.version;

    const preview = await call('POST', `/api/questions/${q1}/similar-preview`, {});
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      projectId: app.id,
      projectName: 'app',
      allowed: true,
      options: [
        { scope: 'exact', available: true, label: 'npm install left-pad' },
        { scope: 'prefix', available: true, label: 'npm install …' },
        { scope: 'category', available: true, label: 'network access' },
      ],
    });
    expect(preview.body['refused']).toBeUndefined();

    const made = await call('POST', `/api/questions/${q1}/allow-similar`, {
      scope: 'prefix',
      version,
    });
    expect(made.status).toBe(200);
    const rule = made.body['rule'] as { id: Id };
    expect(made.body['rule']).toMatchObject({
      projectId: app.id,
      scope: 'prefix',
      match: { kind: 'words', words: ['npm', 'install'] },
      categories: ['network'],
      createdBy: { type: 'user' },
      origin: 'local',
      questionId: q1,
    });
    expect(composed.log.tables.questions.get(q1)).toMatchObject({
      status: 'answered',
      answer: 'allow',
    });
    expect(project(app.id).permissionRules?.map((r) => r.id)).toEqual([rule.id]);
    expect(events('permission.rule_added')).toHaveLength(1);

    // The next install ran without a card, logged as allowed by the rule; the compound one asks.
    await waitFor(() => pending(steward) !== undefined && pending(steward) !== q1, 'third request');
    expect(ran(steward, 'npm install left-pad')).toBe(true);
    expect(ran(steward, 'npm install right-pad')).toBe(true);
    expect(
      events('permission.decided').find((e) => e.agentId === steward && e.decision === 'allow'),
    ).toMatchObject({
      toolCall: { toolName: 'Bash', input: { command: 'npm install right-pad' } },
      action: 'network',
      ruleId: rule.id,
      decidedBy: { type: 'system' },
    });
    const q3 = pending(steward)!;
    expect(composed.log.tables.questions.get(q3)?.context.toolCall?.input).toEqual({
      command: 'npm install x; rm -rf ~',
    });
    // The compound line has no prefix; "exactly this" and its categories still are offered.
    const p3 = await call('POST', `/api/questions/${q3}/similar-preview`, {});
    expect(p3.body['options']).toMatchObject([
      { scope: 'exact', available: true },
      { scope: 'prefix', available: false },
      {
        scope: 'category',
        available: true,
        label: 'destructive actions, outside the workspace and network access',
      },
    ]);
    expect(
      (await call('POST', `/api/questions/${q3}/allow-similar`, { scope: 'prefix' })).status,
    ).toBe(400);

    // The project's Waykeeper is covered too; another project still asks.
    const waykeeper = await spawn(app, 'waykeeper', 'installs');
    await waitFor(() => pending(waykeeper) !== undefined, 'waykeeper third request');
    expect(ran(waykeeper, 'npm install left-pad')).toBe(true);
    const other = await newProject('other');
    const elsewhere = await spawn(other, 'steward', 'installs');
    await waitFor(() => pending(elsewhere) !== undefined, 'other project request');
    expect(ran(elsewhere, 'npm install left-pad')).toBe(false);
    expect(composed.log.tables.questions.get(pending(elsewhere)!)?.context.toolCall?.input).toEqual(
      { command: 'npm install left-pad' },
    );

    // Removed from the project's settings: gone from the row, logged.
    const removed = await call('DELETE', `/api/projects/${app.id}/permission-rules/${rule.id}`);
    expect(removed.status).toBe(200);
    expect(project(app.id).permissionRules).toBeUndefined();
    expect(events('permission.rule_removed')).toEqual([
      {
        type: 'permission.rule_removed',
        projectId: app.id,
        ruleId: rule.id,
        by: { type: 'user' },
        reason: 'removed by the user',
      },
    ]);
    expect(
      (await call('DELETE', `/api/projects/${app.id}/permission-rules/${rule.id}`)).status,
    ).toBe(404);
  });

  it('is never offered for a push, nor for a request outside any project', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'pushes');
    await waitFor(() => pending(steward) !== undefined, 'push request');
    const q = pending(steward)!;
    const preview = await call('POST', `/api/questions/${q}/similar-preview`, {});
    expect(preview.body).toMatchObject({ allowed: false, options: [] });
    expect(preview.body['refused']).toMatch(/push always asks/);
    const refused = await call('POST', `/api/questions/${q}/allow-similar`, { scope: 'exact' });
    expect(refused.status).toBe(400);
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');

    // A free agent with no project (as the Harmonizer or an asteroid's Steward would be).
    const loose = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:installs',
      cwd: app.workspace,
    });
    if (!loose.ok) throw new Error(loose.reason);
    await waitFor(() => pending(loose.agent.id) !== undefined, 'loose request');
    const lq = pending(loose.agent.id)!;
    const lp = await call('POST', `/api/questions/${lq}/similar-preview`, {});
    expect(lp.body['refused']).toMatch(/no project/);
    expect((await call('POST', `/api/questions/${lq}/allow-similar`, { scope: 'exact' })).status).toBe(
      400,
    );
  });

  it('refuses a remote client unless autoApproveRemote, and a stale card', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const preview = await call('POST', `/api/questions/${q}/similar-preview`, {}, REMOTE);
    expect(preview.status).toBe(200);
    expect(preview.body['allowed']).toBe(false);
    const remote = await call('POST', `/api/questions/${q}/allow-similar`, { scope: 'exact' }, REMOTE);
    expect(remote.status).toBe(403);
    expect(remote.body['error']).toBe('remote_control');
    const stale = await call('POST', `/api/questions/${q}/allow-similar`, {
      scope: 'exact',
      version: 99,
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('stale');
    expect(project(app.id).permissionRules).toBeUndefined();
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    // A remote client can still allow once (decision 90).
    expect((await call('POST', `/api/questions/${q}/answer`, { answer: 'allow' }, REMOTE)).status).toBe(
      200,
    );
    // And may not remove a rule either.
    const rule = composed.log.runCommand((ctx) =>
      addPermissionRule(
        ctx,
        app.id,
        {
          scope: 'category',
          tool: '*',
          match: { kind: 'categories' },
          categories: ['network'],
          label: 'network access',
          preview: '',
        },
        { by: { type: 'user' }, origin: 'local' },
      ),
    ).value;
    const del = await call('DELETE', `/api/projects/${app.id}/permission-rules/${rule.id}`, undefined, REMOTE);
    expect(del.status).toBe(403);
    expect(project(app.id).permissionRules).toHaveLength(1);
  });

  it('lets a remote client make and remove rules with autoApproveRemote', async () => {
    await setup({ autoApproveRemote: true });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    expect((await call('POST', `/api/questions/${q}/similar-preview`, {}, REMOTE)).body['allowed']).toBe(
      true,
    );
    const made = await call('POST', `/api/questions/${q}/allow-similar`, { scope: 'category' }, REMOTE);
    expect(made.status).toBe(200);
    expect(made.body['rule']).toMatchObject({ origin: 'remote', scope: 'category' });
    const id = (made.body['rule'] as { id: string }).id;
    expect(
      (await call('DELETE', `/api/projects/${app.id}/permission-rules/${id}`, undefined, REMOTE)).status,
    ).toBe(200);
  });

  it("refuses an agent's or a run's process (the peer guard)", async () => {
    await setup({ rulesPeer: async () => ({ refused: 'from an agent' }) });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const made = await call('POST', `/api/questions/${q}/allow-similar`, { scope: 'exact' });
    expect(made).toEqual({ status: 403, body: { error: 'agent_peer', message: 'from an agent' } });
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    expect(
      (await call('DELETE', `/api/projects/${app.id}/permission-rules/r-x`)).status,
    ).toBe(403);
  });
});

describe('rules end with their project (P9-17)', () => {
  it('closing, cancelling and archiving remove them, logged as the system', async () => {
    await setup();
    const add = (projectId: Id) =>
      composed.log.runCommand((ctx) =>
        addPermissionRule(
          ctx,
          projectId,
          {
            scope: 'exact',
            tool: 'Bash',
            match: { kind: 'text', text: 'npm test' },
            categories: ['run_workspace'],
            label: 'npm test',
            preview: '',
          },
          { by: { type: 'user' }, origin: 'local' },
        ),
      ).value;
    const user = { type: 'user' } as const;

    const closed = await newProject('closed');
    add(closed.id);
    await composed.commands.closeProject(closed.id, user);
    expect(project(closed.id).permissionRules).toBeUndefined();
    await composed.commands.reopenProject(closed.id, user);
    expect(project(closed.id).permissionRules).toBeUndefined();

    const cancelled = await newProject('cancelled');
    add(cancelled.id);
    await composed.commands.control({ kind: 'project', id: cancelled.id }, { action: 'cancel' }, user, {
      origin: 'local',
    });
    expect(project(cancelled.id).state).toBe('failed');
    expect(project(cancelled.id).permissionRules).toBeUndefined();

    // A completed project takes no new rule.
    expect(() => add(closed.id)).not.toThrow(); // reopened: approved again
    await composed.commands.closeProject(closed.id, user);
    expect(() => add(closed.id)).toThrow(/takes no rules/);

    // Archived straight from a proposal (nothing to close first).
    const ws = join(root, 'archived');
    mkdirSync(ws);
    const archived = (
      await composed.commands.createProject({ name: 'archived', workspace: ws, state: 'proposed' })
    ).value;
    add(archived.id);
    await composed.commands.archiveProject(archived.id, user);
    expect(project(archived.id).permissionRules).toBeUndefined();

    expect(
      events('permission.rule_removed').map((e) => [e.projectId, e.reason, e.by.type]),
    ).toEqual([
      [closed.id, 'the project was closed', 'system'],
      [cancelled.id, 'the project was cancelled', 'system'],
      [closed.id, 'the project was closed', 'system'],
      [archived.id, 'the project was archived', 'system'],
    ]);
  });
});
