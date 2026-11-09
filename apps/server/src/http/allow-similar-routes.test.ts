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
import { agentPeerGuard, type PeerCheck } from './peer-guard.js';

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
  outside: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'cat /etc/hosts' },
        permissionAction: 'outside_workspace',
      },
      { kind: 'idle' },
    ],
  },
  reasons: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'cd /tmp/pr83; curl https://example.com/x' },
        permissionAction: 'outside_workspace',
      },
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

async function setup(
  opts: { autoApproveRemote?: boolean; rulesPeer?: PeerCheck; answersPeer?: PeerCheck } = {},
) {
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
    ...(opts.answersPeer ? { answersPeer: opts.answersPeer } : {}),
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
/**
 * What the card sends back for the ticked rows of question `q` (review S1, P14): the digests of
 * the rows whose key or kind is in `ticked`, and the call's digest.
 */
async function ticked(q: Id, keys: string[], headers: Record<string, string> = {}) {
  const preview = await call('POST', `/api/questions/${q}/similar-preview`, {}, headers);
  const rows = preview.body['options'] as { key: string; kind: string; digest?: string }[];
  const digests = keys.map((k) => rows.find((r) => r.key === k || r.kind === k)?.digest ?? 'none');
  return { digests, callDigest: preview.body['callDigest'] as string };
}
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
  opts: { publishes?: boolean } = {},
): Promise<Id> {
  const taskId =
    role === 'steward'
      ? (
          await composed.commands.createTask({
            projectId: p.id,
            description: `t ${scenario}`,
            ...(opts.publishes ? { publishes: true } : {}),
          })
        ).value.id
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
      call: 'npm install left-pad',
      asking: ['npm install left-pad'],
      notRememberable: [],
      options: [
        {
          key: 'prefix',
          kind: 'prefix',
          available: true,
          label: 'npm install … (and any further arguments)',
          covers: ['npm install left-pad'],
        },
        { key: 'category', kind: 'category', available: true, label: 'network access' },
      ],
    });
    expect(preview.body['refused']).toBeUndefined();
    expect(preview.body['callDigest']).toMatch(/^[0-9a-f]{32}$/);

    const made = await call('POST', `/api/questions/${q1}/allow-similar`, {
      ...(await ticked(q1, ['prefix'])),
      version,
    });
    expect(made.status).toBe(200);
    const [rule] = made.body['rules'] as { id: Id }[];
    expect(made.body['rules']).toHaveLength(1);
    expect(rule).toMatchObject({
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
    expect(project(app.id).permissionRules?.map((r) => r.id)).toEqual([rule!.id]);
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
      ruleIds: [rule!.id],
      decidedBy: { type: 'system' },
    });
    const q3 = pending(steward)!;
    expect(composed.log.tables.questions.get(q3)?.context.toolCall?.input).toEqual({
      command: 'npm install x; rm -rf ~',
    });
    // The compound line reaches the home folder (`~`): no folder that broad, no prefix for two
    // commands; the category for its other reasons (review B2).
    const p3 = await call('POST', `/api/questions/${q3}/similar-preview`, {});
    expect(p3.body['options']).toMatchObject([
      { kind: 'folder', available: false },
      { key: 'prefix', available: false },
      { key: 'category', available: true },
    ]);
    const forgedPrefix = await call('POST', `/api/questions/${q3}/allow-similar`, {
      digests: [(await ticked(q1, ['prefix'])).digests[0]],
      callDigest: (await ticked(q3, [])).callDigest,
    });
    expect(forgedPrefix.status).toBe(409);

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
    const removed = await call('DELETE', `/api/projects/${app.id}/permission-rules/${rule!.id}`);
    expect(removed.status).toBe(200);
    expect(project(app.id).permissionRules).toBeUndefined();
    expect(events('permission.rule_removed')).toEqual([
      {
        type: 'permission.rule_removed',
        projectId: app.id,
        ruleId: rule!.id,
        by: { type: 'user' },
        reason: 'removed by the user',
      },
    ]);
    expect(
      (await call('DELETE', `/api/projects/${app.id}/permission-rules/${rule!.id}`)).status,
    ).toBe(404);
  });

  it('is never offered for a push, nor for a request outside any project', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'pushes');
    await waitFor(() => pending(steward) !== undefined, 'push request');
    const q = pending(steward)!;
    const preview = await call('POST', `/api/questions/${q}/similar-preview`, {});
    expect(preview.body).toMatchObject({
      options: [],
      notRememberable: [{ part: 'git push origin main' }],
    });
    expect((preview.body['notRememberable'] as { reason: string }[])[0]?.reason).toMatch(
      /push always asks/,
    );
    const refused = await call('POST', `/api/questions/${q}/allow-similar`, {
      digests: ['x'],
      callDigest: preview.body['callDigest'],
    });
    expect(refused.status).toBe(409);
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
    expect(
      (
        await call('POST', `/api/questions/${lq}/allow-similar`, {
          digests: ['x'],
          callDigest: 'c',
        })
      ).status,
    ).toBe(400);
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
    const remote = await call(
      'POST',
      `/api/questions/${q}/allow-similar`,
      await ticked(q, ['prefix']),
      REMOTE,
    );
    expect(remote.status).toBe(403);
    expect(remote.body['error']).toBe('remote_control');
    const stale = await call('POST', `/api/questions/${q}/allow-similar`, {
      ...(await ticked(q, ['prefix'])),
      version: 99,
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toBe('stale');
    expect(project(app.id).permissionRules).toBeUndefined();
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    // A remote client can still allow once (decision 90).
    expect(
      (await call('POST', `/api/questions/${q}/answer`, { answer: 'allow' }, REMOTE)).status,
    ).toBe(200);
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
    const del = await call(
      'DELETE',
      `/api/projects/${app.id}/permission-rules/${rule.id}`,
      undefined,
      REMOTE,
    );
    expect(del.status).toBe(403);
    expect(project(app.id).permissionRules).toHaveLength(1);
  });

  it('lets a remote client make and remove rules with autoApproveRemote', async () => {
    await setup({ autoApproveRemote: true });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    expect(
      (await call('POST', `/api/questions/${q}/similar-preview`, {}, REMOTE)).body['allowed'],
    ).toBe(true);
    const made = await call(
      'POST',
      `/api/questions/${q}/allow-similar`,
      await ticked(q, ['category'], REMOTE),
      REMOTE,
    );
    expect(made.status).toBe(200);
    expect(made.body['rules']).toMatchObject([{ origin: 'remote', scope: 'category' }]);
    const id = (made.body['rules'] as { id: string }[])[0]!.id;
    expect(
      (await call('DELETE', `/api/projects/${app.id}/permission-rules/${id}`, undefined, REMOTE))
        .status,
    ).toBe(200);
  });

  it("refuses an agent's or a run's process (the peer guard)", async () => {
    await setup({ rulesPeer: async () => ({ refused: 'from an agent' }) });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const made = await call(
      'POST',
      `/api/questions/${q}/allow-similar`,
      await ticked(q, ['prefix']),
    );
    expect(made).toEqual({ status: 403, body: { error: 'agent_peer', message: 'from an agent' } });
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    expect((await call('DELETE', `/api/projects/${app.id}/permission-rules/r-x`)).status).toBe(403);
  });
});

describe('"Allow similar" after the review (P9-17)', () => {
  it('refuses a rule that is not the one the preview showed (S1)', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    // A digest no row has (another rule, or one from before the table changed): 409 stale.
    const { digests, callDigest } = await ticked(q, ['prefix']);
    const wrong = await call('POST', `/api/questions/${q}/allow-similar`, {
      digests: ['0'.repeat(32)],
      callDigest,
    });
    expect(wrong.status).toBe(409);
    expect(wrong.body['error']).toBe('stale');
    // Another call's digest: 409 stale too.
    const otherCall = await call('POST', `/api/questions/${q}/allow-similar`, {
      digests,
      callDigest: '0'.repeat(32),
    });
    expect(otherCall.status).toBe(409);
    // No ticked row: refused by the body's schema.
    const none = await call('POST', `/api/questions/${q}/allow-similar`, {
      digests: [],
      callDigest,
    });
    expect(none.status).toBe(400);
    await composed.commands.updateProject(
      app.id,
      { permissionPolicy: { rules: { network: 'ask', outside_workspace: 'ask' } } },
      { origin: 'local' },
    );
    expect(await ticked(q, ['prefix'])).toEqual({ digests, callDigest }); // same rule
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    expect(project(app.id).permissionRules).toBeUndefined();
    expect(
      (await call('POST', `/api/questions/${q}/allow-similar`, { digests, callDigest })).status,
    ).toBe(200);
  });

  it('outside the workspace: a folder only, its real path stored (B2)', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'outside');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const etc = realpathSync('/etc');
    const preview = await call('POST', `/api/questions/${q}/similar-preview`, {});
    expect(preview.body['options']).toMatchObject([
      { key: `folder:${etc}`, available: true, label: '/etc/…', covers: ['cat /etc/hosts'] },
      { key: 'category', available: false },
    ]);
    const made = await call('POST', `/api/questions/${q}/allow-similar`, {
      ...(await ticked(q, [`folder:${etc}`])),
    });
    expect(made.status).toBe(200);
    expect(made.body['rules']).toMatchObject([
      {
        scope: 'folder',
        match: { kind: 'folder', folder: etc, access: 'any' },
        categories: ['outside_workspace'],
      },
    ]);
  });

  it('allows once and stores one rule per ticked row (P14)', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'reasons');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const pr83 = join(realpathSync('/tmp'), 'pr83');
    const preview = await call('POST', `/api/questions/${q}/similar-preview`, {});
    expect(preview.body).toMatchObject({
      call: 'cd /tmp/pr83; curl https://example.com/x',
      asking: ['cd /tmp/pr83', 'curl https://example.com/x'],
    });
    expect((preview.body['options'] as { key: string }[]).map((o) => o.key)).toEqual([
      `folder:${pr83}`,
      'site:example.com',
      'category',
    ]);
    // An unknown digest among known ones: 409, nothing stored.
    const body = await ticked(q, [`folder:${pr83}`, 'site:example.com']);
    const unknown = await call('POST', `/api/questions/${q}/allow-similar`, {
      ...body,
      digests: [...body.digests, 'f'.repeat(32)],
    });
    expect(unknown.status).toBe(409);
    expect(project(app.id).permissionRules).toBeUndefined();

    const made = await call('POST', `/api/questions/${q}/allow-similar`, body);
    expect(made.status).toBe(200);
    expect(made.body['rules']).toHaveLength(2);
    expect(made.body['rules']).toMatchObject([
      { scope: 'folder', match: { kind: 'folder', folder: pr83, access: 'any' } },
      { scope: 'site', match: { kind: 'host', host: 'example.com' } },
    ]);
    expect(composed.log.tables.questions.get(q)).toMatchObject({
      status: 'answered',
      answer: 'allow',
    });
    expect(project(app.id).permissionRules).toHaveLength(2);
    expect(events('permission.rule_added')).toHaveLength(2);
  });

  it('checks the project before answering, and answer and rule are one transaction (S6)', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    // A request no session waits on (opened in the log): answer and rule in one command.
    const opened = await composed.commands.openQuestion({
      kind: 'permission',
      originAgentId: steward,
      context: {
        text: 'May I?',
        toolCall: { toolName: 'Bash', input: { command: 'npm install zod' } },
        permissionAction: 'network',
      },
    });
    const q = opened.value.id;
    expect(composed.runtime.hasQuestion(q)).toBe(false);
    const body = await ticked(q, ['prefix']);
    const since = composed.log.currentSeq();
    const made = await call('POST', `/api/questions/${q}/allow-similar`, body);
    expect(made.status).toBe(200);
    const after = composed.log.eventsSince(since).map((e) => e.event.type);
    expect(after.filter((t) => t === 'question.answered' || t === 'permission.rule_added')).toEqual(
      ['question.answered', 'permission.rule_added'],
    );

    // A project that takes no rules any more: refused before anything is answered.
    const q1 = pending(steward)!;
    const d1 = await ticked(q1, ['prefix']);
    composed.log.runCommand((ctx) =>
      ctx.tables.projects.upsert({ ...ctx.tables.projects.get(app.id)!, state: 'completed' }),
    );
    const refused = await call('POST', `/api/questions/${q1}/allow-similar`, d1);
    expect(refused.status).toBe(400);
    expect(composed.log.tables.questions.get(q1)?.status).toBe('open');
  });

  it('says "allowed once; rule not stored" when the rule fails after the session took the answer (S6)', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const body = await ticked(q, ['prefix', 'category']);
    // The project closes while the session takes the answer.
    const runtime = composed.runtime as unknown as {
      answer: (...args: unknown[]) => Promise<unknown>;
    };
    const original = runtime.answer.bind(runtime);
    runtime.answer = async (...args: unknown[]) => {
      composed.log.runCommand((ctx) =>
        ctx.tables.projects.upsert({ ...ctx.tables.projects.get(app.id)!, state: 'completed' }),
      );
      return original(...args);
    };
    const made = await call('POST', `/api/questions/${q}/allow-similar`, body);
    expect(made.status).toBe(200);
    expect(made.body['rules']).toBeUndefined();
    expect(made.body['ruleNotStored']).toMatch(/allowed once; the rules were not stored/);
    expect(composed.log.tables.questions.get(q)).toMatchObject({ status: 'answered' });
    expect(project(app.id).permissionRules).toBeUndefined();
  });

  it('refuses answering a permission or dismissing from an agent; a clarification may be answered (S4)', async () => {
    await setup({ answersPeer: async () => ({ refused: 'from an agent' }) });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    const answered = await call('POST', `/api/questions/${q}/answer`, { answer: 'allow' });
    expect(answered).toEqual({
      status: 403,
      body: { error: 'agent_peer', message: 'from an agent' },
    });
    const dismissed = await call('POST', `/api/questions/${q}/dismiss`, {});
    expect(dismissed.status).toBe(403);
    expect(composed.log.tables.questions.get(q)?.status).toBe('open');
    const clarification = await composed.commands.openQuestion({
      kind: 'clarification',
      originAgentId: steward,
      context: { text: 'Which colour?' },
    });
    const c = clarification.value.id;
    // Held by its supervisor or the user: answered as the user it is not refused by the guard.
    const res = await call('POST', `/api/questions/${c}/answer`, { answer: 'blue' });
    expect(res.status).not.toBe(403);
  });

  it('lets the panel and the desktop app answer when the peer is not an agent (S4)', async () => {
    const seen: string[] = [];
    await setup({
      answersPeer: async () => {
        seen.push('checked');
        return {};
      },
    });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    expect((await call('POST', `/api/questions/${q}/answer`, { answer: 'allow' })).status).toBe(
      200,
    );
    expect(seen).toEqual(['checked']);
  });

  it("the desktop app (the server's parent, no agent marker) passes the guard; an agent does not (S4)", async () => {
    const SELF = 200;
    const proc = (pid: number, ppid: number) => ({
      pid,
      ppid,
      pgid: pid,
      uid: 501,
      startedAt: 0,
      command: `p${pid}`,
    });
    // launchd (1) → the desktop app (100) → Mission Control (200) → a Steward (300) → curl (301).
    const table = {
      list: async () => [
        proc(100, 1),
        proc(SELF, 100),
        proc(300, SELF),
        proc(301, 300),
        proc(400, 1),
      ],
      environment: async (chain: readonly { pid: number }[]) =>
        new Map(
          chain.map((p) => [
            p.pid,
            new Map<string, string>(p.pid === 400 ? [['GALACTIC_AGENT_ID', 'a-1']] : []),
          ]),
        ),
    };
    const guardFor = (peer: number) =>
      agentPeerGuard({
        table,
        selfPid: SELF,
        lsof: async () => `p${peer}\nn127.0.0.1:5000->127.0.0.1:4000\n`,
      });
    const req = {
      raw: { socket: { remotePort: 5000, localPort: 4000, remoteAddress: '127.0.0.1' } },
    } as never;
    expect(await guardFor(100)(req)).toEqual({}); // the desktop app's menu bar
    expect((await guardFor(301)(req)).refused).toBeDefined(); // below Mission Control
    expect((await guardFor(400)(req)).refused).toBeDefined(); // carries an agent's marker
  });

  it('allows and logs when the peer cannot be identified (S4)', async () => {
    await setup({ answersPeer: async () => ({ unknown: 'lsof is not available' }) });
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    const q = pending(steward)!;
    expect((await call('POST', `/api/questions/${q}/dismiss`, {})).status).toBe(200);
  });
});

describe('one project for the table and the rules (P9-17 review S7, S8)', () => {
  it("a Steward spawned with only its task is judged by its task's project table and rules", async () => {
    await setup();
    const app = await newProject('app');
    await composed.commands.updateProject(
      app.id,
      { permissionPolicy: { rules: { network: 'allow' } } },
      { origin: 'local' },
    );
    const taskId = (await composed.commands.createTask({ projectId: app.id, description: 't' }))
      .value.id;
    const result = await composed.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:installs',
      cwd: app.workspace,
      taskId,
    });
    if (!result.ok) throw new Error(result.reason);
    const steward = result.agent.id;
    await waitFor(() => pending(steward) !== undefined, 'the compound request');
    // The table of the task's project allowed both installs without a card.
    expect(ran(steward, 'npm install left-pad')).toBe(true);
    expect(ran(steward, 'npm install right-pad')).toBe(true);
    expect(composed.log.tables.questions.get(pending(steward)!)?.context.toolCall?.input).toEqual({
      command: 'npm install x; rm -rf ~',
    });
  });

  it('a request whose agent is not running is previewed with the deliverables folder (S8)', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'request');
    await composed.runtime.stop(steward, { type: 'user' });
    expect(composed.runtime.permissionContext(steward)).toBeUndefined();
    const opened = await composed.commands.openQuestion({
      kind: 'permission',
      originAgentId: steward,
      context: {
        text: 'May I?',
        toolCall: {
          toolName: 'Write',
          input: { file_path: join(app.workspace, 'deliverables', 'report.pdf'), content: 'x' },
        },
        permissionAction: 'outside_workspace',
      },
    });
    const preview = await call('POST', `/api/questions/${opened.value.id}/similar-preview`, {});
    expect(preview.body['options']).toEqual([]);
    expect(preview.body['notRememberable']).toEqual([
      {
        part: expect.stringContaining('report.pdf'),
        reason: expect.stringMatching(/deliverables folder/),
      },
    ]);
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
    await composed.commands.control(
      { kind: 'project', id: cancelled.id },
      { action: 'cancel' },
      user,
      {
        origin: 'local',
      },
    );
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

describe('a publishing run offers no "Allow similar" (P11-12)', () => {
  it('marks its permission request, and the preview and the rule are refused', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs', { publishes: true });
    await waitFor(() => pending(steward) !== undefined, 'first request');
    const q1 = pending(steward)!;
    const question = composed.log.tables.questions.get(q1)!;
    expect(question.context.origin?.publishingRun).toBe(true);

    const preview = await call('POST', `/api/questions/${q1}/similar-preview`, {});
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({ allowed: false, options: [] });
    expect(preview.body['refused']).toMatch(/publishing/);
    // A refused preview spells the call as a drafted one does.
    expect(preview.body['call']).toBe('npm install left-pad');

    const made = await call('POST', `/api/questions/${q1}/allow-similar`, {
      digests: ['x'],
      callDigest: 'c',
      version: question.version,
    });
    expect(made.status).toBe(400);
    expect(project(app.id).permissionRules ?? []).toEqual([]);
    expect(composed.log.tables.questions.get(q1)?.status).toBe('open');
  });

  it('leaves an ordinary Steward’s request unmarked', async () => {
    await setup();
    const app = await newProject('app');
    const steward = await spawn(app, 'steward', 'installs');
    await waitFor(() => pending(steward) !== undefined, 'first request');
    const question = composed.log.tables.questions.get(pending(steward)!)!;
    expect(question.context.origin?.publishingRun).toBeUndefined();
  });
});
