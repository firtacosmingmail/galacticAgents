import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PERMISSION_POLICY, RuntimesInfo, type Event } from '@galactic/protocol';
import { originOfMessages } from '../domain/permissions.js';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';
import { projectHierarchy } from '../test/hierarchy.js';

let composed: ComposedRuntime;
let fake: FakeAdapter;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  fake = new FakeAdapter({ speed: 1 });
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [fake],
    flushMs: 10,
    // Three: the control test runs a Harmonizer, a Waykeeper and a Steward (P2-20).
    caps: { maxConcurrentAgents: 3 },
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
    scenarios: () => fake.scenarioNames(),
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const call = async (path: string, body?: unknown, token = TEST_TOKEN) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: body === undefined && path.startsWith('/api/runtimes') ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
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
const state = (id: string) => composed.statuses.get(id)?.state;

describe('/api agent routes (P1-11)', () => {
  it('needs the token', async () => {
    expect((await call('/api/runtimes', undefined, 'wrong')).status).toBe(401);
    expect(
      (await call('/api/agents', { runtime: 'fake', prompt: 'x', cwd: '/tmp' }, 'wrong')).status,
    ).toBe(401);
  });

  it('needs the token on percent-encoded paths too (P1-28)', async () => {
    for (const path of ['/%61pi/runtimes', '/ap%69/runtimes', '/%64ev/events', '/de%76/events']) {
      const res = await fetch(`${t.baseUrl}${path}`);
      expect([401, 404], path).toContain(res.status);
    }
    const spawn = await fetch(`${t.baseUrl}/%61pi/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runtime: 'fake', prompt: 'scenario:echo', cwd: '/tmp' }),
    });
    expect([401, 404]).toContain(spawn.status);
    expect(composed.runtime.liveAgents()).toHaveLength(0);
    const dev = await fetch(`${t.baseUrl}/%64ev/seed`, { method: 'POST' });
    expect([401, 404]).toContain(dev.status);
  });

  it('describes the runtimes, policies and caps for the spawn form', async () => {
    const { status, body } = await call('/api/runtimes');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      runtimes: [
        { name: 'fake', resumable: true, scenarios: expect.arrayContaining(['happy', 'asks']) },
      ],
      policies: ['default', 'trusting', 'cautious'],
      maxConcurrentAgents: 3,
    });
  });

  it("floors a remote client's policy at the global default unless configured (P2-04)", async () => {
    const spawn = async (headers: Record<string, string>) => {
      const res = await fetch(`${t.baseUrl}/api/agents`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: JSON.stringify({
          runtime: 'fake',
          prompt: 'scenario:echo',
          cwd: '/tmp',
          policy: 'trusting',
        }),
      });
      const id = ((await res.json()) as { agentId: string }).agentId;
      return composed.log.tables.agents.get(id)?.meta?.['permissionPolicy'] as
        { rules: Record<string, string> } | undefined;
    };
    const local = await spawn({});
    expect(local?.rules['network']).toBe('allow');
    const remote = await spawn({ origin: 'https://mymac.tail1234.ts.net' });
    expect(remote?.rules['network']).toBe('ask');
    expect(remote?.rules['edit_workspace']).toBe('allow');
  });

  it('spawns, messages, pauses, resumes and stops an agent', async () => {
    const spawned = await call('/api/agents', {
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/tmp',
      policy: 'trusting',
      caps: { maxToolCalls: 7 },
    });
    expect(spawned.status).toBe(201);
    const id = spawned.body['agentId'] as string;
    expect(composed.log.tables.agents.get(id)?.caps.maxToolCalls).toBe(7);
    await waitFor(() => state(id) === 'idle', 'idle');

    const sent = await call(`/api/agents/${id}/send`, { text: 'hello there' });
    expect(sent.status).toBe(200);
    expect(sent.body['messageId']).toBeTypeOf('string');
    await waitFor(
      () => composed.log.eventsSince(0).filter((e) => e.event.type === 'agent.idle').length >= 2,
      'second idle',
    );
    composed.transcripts.flush();
    expect(composed.transcripts.read(id).map((c) => c.text)).toContain('received: hello there');

    expect((await call(`/api/agents/${id}/pause`)).status).toBe(200);
    await waitFor(() => state(id) === 'paused', 'paused');
    expect((await call(`/api/agents/${id}/resume`)).status).toBe(200);
    await waitFor(() => state(id) === 'idle', 'idle after resume');
    expect((await call(`/api/agents/${id}/stop`)).status).toBe(200);
    await waitFor(() => state(id) === 'stopped', 'stopped');
    const afterStop = await call(`/api/agents/${id}/send`, { text: 'too late' });
    expect(afterStop.status).toBe(409);
  });

  it('answers questions of both kinds and reports a refused spawn', async () => {
    const a = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:full', cwd: '/tmp' });
    const id = a.body['agentId'] as string;
    await waitFor(() => state(id) === 'waiting_for_input', 'clarification');
    const q1 = composed.statuses.get(id)!.pendingQuestionId!;
    expect((await call(`/api/questions/${q1}/answer`, { answer: 'yes' })).status).toBe(200);
    await waitFor(
      () =>
        composed.statuses.get(id)?.pendingQuestionId !== undefined &&
        composed.statuses.get(id)?.pendingQuestionId !== q1,
      'permission',
    );
    const q2 = composed.statuses.get(id)!.pendingQuestionId!;
    expect(composed.log.tables.questions.get(q2)?.kind).toBe('permission');
    expect((await call(`/api/questions/${q2}/answer`, { answer: 'allow' })).status).toBe(200);
    await waitFor(() => state(id) === 'idle', 'idle');
    expect((await call(`/api/questions/${q2}/answer`, { answer: 'again' })).status).toBe(409);

    const b = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:long', cwd: '/tmp' });
    expect(b.status).toBe(201);
    const b2 = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:long', cwd: '/tmp' });
    expect(b2.status).toBe(201);
    const c = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:long', cwd: '/tmp' });
    expect(c.status).toBe(409);
    expect(c.body['message']).toMatch(/concurrency cap/);
    expect((await call('/api/agents', { runtime: 'pty', prompt: 'x', cwd: '/tmp' })).status).toBe(
      409,
    );
    expect((await call('/api/agents', { runtime: 'fake', prompt: '', cwd: '/tmp' })).status).toBe(
      400,
    );
  });

  it('recovers an interrupted agent on demand', async () => {
    const a = await call('/api/agents', { runtime: 'fake', prompt: 'scenario:asks', cwd: '/tmp' });
    const id = a.body['agentId'] as string;
    await waitFor(() => state(id) === 'waiting_for_input', 'question');
    await composed.runtime.shutdown();
    expect(state(id)).toBe('interrupted');
    expect((await call(`/api/agents/${id}/recover`)).status).toBe(200);
    await waitFor(() => state(id) === 'waiting_for_input', 're-asked');
    expect((await call(`/api/agents/nope/recover`)).status).toBe(404);
  });

  it('redacts the messages of 409 bodies (P1-38)', async () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    vi.spyOn(composed.runtime, 'pause').mockRejectedValue(new Error(`cli said: ${key} is bad`));
    const paused = await call('/api/agents/a1/pause');
    expect(paused.status).toBe(409);
    expect(paused.body['error']).toBe('rejected');
    expect(paused.body['message']).toMatch(/^cli said: \[redacted:anthropic-key\] is bad$/);
    expect(JSON.stringify(paused.body)).not.toContain(key);

    vi.spyOn(composed.runtime, 'spawn').mockResolvedValue({ ok: false, reason: `boom ${key}` });
    const spawned = await call('/api/agents', { runtime: 'fake', prompt: 'x', cwd: '/tmp' });
    expect(spawned.status).toBe(409);
    expect(spawned.body['error']).toBe('refused');
    expect(JSON.stringify(spawned.body)).not.toContain(key);
  });

  it('answers /api/runtimes with the protocol shape', async () => {
    const { body } = await call('/api/runtimes');
    expect(RuntimesInfo.safeParse(body).success).toBe(true);
  });
});

describe('POST /api/control (P2-14)', () => {
  it('pauses a task and its Steward, refuses bad bodies, unknown targets and refused states', async () => {
    const { commands, log } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/tmp' })).value;
    const task = (await commands.createTask({ description: 'parse', projectId: project.id })).value;
    const { waykeeper } = await projectHierarchy(commands, project.id);
    const steward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: waykeeper.id,
        prompt: 'scenario:long',
      })
    ).value;
    await waitFor(() => state(steward.id) === 'working', 'working');
    const target = { kind: 'task', id: task.id };

    const paused = await call('/api/control', { target, action: { action: 'pause' } });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ ok: true });
    await waitFor(() => state(steward.id) === 'paused', 'paused');
    expect(log.tables.tasks.get(task.id)?.state).toBe('paused');

    expect((await call('/api/control', { target, action: { action: 'fly' } })).status).toBe(400);
    expect(
      (
        await call('/api/control', {
          target: { kind: 'task', id: 't-x' },
          action: { action: 'stop' },
        })
      ).status,
    ).toBe(404);
    const refused = await call('/api/control', { target, action: { action: 'reopen' } });
    expect(refused.status).toBe(409);
    // A domain refusal of the input itself is a 400, not a conflict (wave-2 review).
    const bad = await call('/api/control', {
      target,
      action: { action: 'edit', changes: { bodyId: 'b-x' } },
    });
    expect(bad.status).toBe(400);
    expect(refused.body['message']).toMatch(/not finished/);
    expect(
      (await call('/api/control', { target, action: { action: 'stop' } }, 'wrong')).status,
    ).toBe(401);
  });
});

describe('the remote floor on every policy write (P2-21)', () => {
  /** A request as a phone through Tailscale Serve makes it: loopback, but a remote `Origin`. */
  const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };
  const LOOSE = { rules: { destructive: 'allow', network: 'allow' } } as const;
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
  const policyOf = (id: string) => composed.log.tables.projects.get(id)?.permissionPolicy;
  const editPolicy = (id: string, permissionPolicy: unknown, headers?: Record<string, string>) =>
    post(
      '/api/control',
      {
        target: { kind: 'project', id },
        action: { action: 'edit', changes: { permissionPolicy } },
      },
      headers,
    );

  it('a remote project edit cannot loosen the policy; a local one can; null clears it', async () => {
    const { commands, log } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/tmp' })).value;

    const remote = await editPolicy(project.id, LOOSE, REMOTE);
    expect(remote.status).toBe(200);
    expect(policyOf(project.id)).toEqual(DEFAULT_PERMISSION_POLICY);
    // The supervisors' mailboxes see what was applied, not what was asked.
    const edit = log
      .eventsSince(0)
      .map((e) => e.event)
      .filter((e): e is Extract<Event, { type: 'control.edit' }> => e.type === 'control.edit')
      .at(-1);
    expect(edit?.changes).toEqual({ permissionPolicy: DEFAULT_PERMISSION_POLICY });

    // Stricter than the default is the remote client's to choose.
    await editPolicy(project.id, { rules: { network: 'deny' } }, REMOTE);
    expect(policyOf(project.id)?.rules['network']).toBe('deny');
    expect(policyOf(project.id)?.rules['destructive']).toBe('ask');

    expect((await editPolicy(project.id, LOOSE)).status).toBe(200);
    expect(policyOf(project.id)).toEqual(LOOSE);

    // Clearing returns to the global default, never looser than the floor: fine from anywhere.
    expect((await editPolicy(project.id, null, REMOTE)).status).toBe(200);
    expect(policyOf(project.id)).toBeUndefined();

    expect((await editPolicy(project.id, { rules: { destructive: 'sure' } })).status).toBe(400);
    expect(
      (
        await post('/api/control', {
          target: { kind: 'task', id: 't-x' },
          action: { action: 'edit', changes: { permissionPolicy: LOOSE } },
        })
      ).status,
    ).toBe(404);
  });

  it('a forwarded request counts as remote too', async () => {
    const project = (await composed.commands.createProject({ name: 'CSV', workspace: '/tmp' }))
      .value;
    await editPolicy(project.id, LOOSE, { 'x-forwarded-for': '100.64.0.7' });
    expect(policyOf(project.id)).toEqual(DEFAULT_PERMISSION_POLICY);
  });

  it("records a message's origin, and a brain's write for a remote message is floored", async () => {
    const { commands, log } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/tmp' })).value;
    const harmonizer = (
      await commands.spawnAgent({
        role: 'harmonizer',
        runtime: 'fake',
        cwd: '/tmp',
        prompt: 'scenario:echo',
      })
    ).value;
    await waitFor(() => state(harmonizer.id) === 'idle', 'idle');
    const sent = () =>
      log
        .eventsSince(0)
        .map((e) => e.event)
        .filter((e): e is Extract<Event, { type: 'message.sent' }> => e.type === 'message.sent');

    // What a Harmonizer tool does for the turn's messages (the P2-08 seam): pass their origin.
    const brainWrite = (messages: ReturnType<typeof sent>) =>
      commands.updateProject(
        project.id,
        { permissionPolicy: LOOSE },
        { origin: originOfMessages(messages) },
      );

    expect(
      (await post(`/api/agents/${harmonizer.id}/send`, { text: 'trust it' }, REMOTE)).status,
    ).toBe(200);
    expect(sent().at(-1)?.origin).toBe('remote');
    await brainWrite(sent().slice(-1));
    expect(policyOf(project.id)).toEqual(DEFAULT_PERMISSION_POLICY);

    expect((await post(`/api/agents/${harmonizer.id}/send`, { text: 'trust it' })).status).toBe(
      200,
    );
    expect(sent().at(-1)?.origin).toBe('local');
    await brainWrite(sent().slice(-1));
    expect(policyOf(project.id)).toEqual(LOOSE);

    // A turn that folds a remote message with a local one acts for the remote one too.
    await commands.updateProject(project.id, { permissionPolicy: null }, { origin: 'local' });
    await brainWrite(sent());
    expect(policyOf(project.id)).toEqual(DEFAULT_PERMISSION_POLICY);
  });
});
