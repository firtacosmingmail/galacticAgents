import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isHarnessMeta,
  type EventEnvelope,
  type HarnessClearResponse,
  type HarnessScenarioResponse,
  type StatusRecord,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { createWakeScope } from '../brains/seed.js';
import { wakeLine } from '../brains/wake.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * The scene harness's routes (P4-06): development only, local only, and every action a real
 * event through the real commands — so the status stream and the scene see what an agent would
 * cause.
 */

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;
let seen: EventEnvelope[];

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
    // A fake agent never stalls on its own, even with a stall threshold this short.
    stallThresholdMs: () => 50,
    tickMs: 20,
  });
  seen = [];
  composed.log.subscribe((e) => seen.push(e));
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
});

const post = async (
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  baseUrl = t.baseUrl,
) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const state = (id: string) => composed.statuses.get(id)?.state;
const typesSince = (n: number) => seen.slice(n).map((e) => e.event.type);
const scenario = async (body: Record<string, unknown> = {}) => {
  const res = await post('/dev/harness/scenario', body);
  expect(res.status).toBe(200);
  return res.body as unknown as HarnessScenarioResponse;
};

describe('/dev/harness guards (P4-06)', () => {
  it('does not exist without GALACTIC_DEV', async () => {
    const prod = await startTestApp({
      log: composed.log,
      statuses: composed.statuses,
      commands: composed.commands,
      runtime: composed.runtime,
      config: testConfig({ dev: false }),
    });
    try {
      expect((await post('/dev/harness/scenario', {}, {}, prod.baseUrl)).status).toBe(404);
      const list = await fetch(`${prod.baseUrl}/dev/harness`, {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(list.status).toBe(404);
    } finally {
      await prod.stop();
    }
  });

  it('needs the token', async () => {
    const res = await fetch(`${t.baseUrl}/dev/harness/scenario`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('refuses a remote client, on the harness and the older dev routes alike', async () => {
    const remote = { 'x-forwarded-for': '100.64.0.7' };
    expect((await post('/dev/harness/scenario', {}, remote)).status).toBe(403);
    expect((await post('/dev/seed', undefined, remote)).status).toBe(403);
    const tailnet = await post('/dev/harness/clear', undefined, {
      origin: 'https://box.tail1234.ts.net',
    });
    expect(tailnet).toMatchObject({ status: 403, body: { error: 'remote_dev' } });
    expect(composed.log.tables.projects.all()).toHaveLength(0);
  });

  it('validates bodies', async () => {
    expect((await post('/dev/harness/agents/a-x/state', { state: 'dancing' })).status).toBe(400);
    expect((await post('/dev/harness/agents/a-x/state', { state: 'idle' })).status).toBe(404);
    expect((await post('/dev/harness/agents/a-x/activity', {})).status).toBe(400);
  });
});

describe('/dev/harness/scenario (P4-06)', () => {
  it('creates a project with a Waykeeper and Stewards, and an asteroid task, all working', async () => {
    const out = await scenario({ stewards: 3 });
    const { tables } = composed.log;
    const project = tables.projects.get(out.projectId)!;
    expect(isHarnessMeta(project.meta)).toBe(true);
    expect(tables.bodies.get(project.bodyId)?.kind).toBe('planet');
    expect(out.taskIds).toHaveLength(3);
    expect(out.stewardIds).toHaveLength(3);

    const waykeeper = tables.agents.get(out.waykeeperId)!;
    expect(waykeeper).toMatchObject({ role: 'waykeeper', projectId: project.id, runtime: 'fake' });
    expect(waykeeper.bodyId).toBe(project.bodyId);
    const hq = tables.agents.get(waykeeper.supervisorId!)!;
    // The dormant harness Harmonizer: never spawned, never "the newest Harmonizer".
    expect(hq).toMatchObject({ role: 'harmonizer', createdAt: new Date(0).toISOString() });
    expect(isHarnessMeta(hq.meta)).toBe(true);
    expect(composed.statuses.get(hq.id)).toBeUndefined();

    for (const [i, id] of out.stewardIds.entries()) {
      const steward = tables.agents.get(id)!;
      expect(steward).toMatchObject({
        role: 'steward',
        taskId: out.taskIds[i],
        projectId: project.id,
        supervisorId: waykeeper.id,
        bodyId: project.bodyId,
      });
      expect(state(id)).toBe('working');
    }
    const asteroidTask = tables.tasks.get(out.asteroidTaskId!)!;
    expect(asteroidTask.projectId).toBeUndefined();
    expect(tables.bodies.get(asteroidTask.bodyId)?.kind).toBe('asteroid');
    expect(tables.agents.get(out.asteroidStewardId!)).toMatchObject({
      supervisorId: hq.id,
      bodyId: asteroidTask.bodyId,
    });
    expect(state(out.waykeeperId)).toBe('working');
    // Each Steward a different archetype's tool call.
    const activities = out.stewardIds.map((id) => composed.statuses.get(id)?.currentActivity);
    expect(activities).toEqual([
      'Grep: TODO',
      'Bash: pnpm test',
      'Bash: git commit -m "harness: save work"',
    ]);
    // The work-state deriver saw real agents at work.
    expect(tables.tasks.get(out.taskIds[0]!)?.state).toBe('in_progress');

    // A second scenario reuses the dormant Harmonizer and takes another planet.
    const second = await scenario({ stewards: 0, asteroid: false });
    expect(tables.agents.get(second.waykeeperId)?.supervisorId).toBe(hq.id);
    expect(second.bodyId).not.toBe(out.bodyId);
    const list = await fetch(`${t.baseUrl}/dev/harness`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(await list.json()).toMatchObject({
      projects: [out.projectId, second.projectId],
    });
  });

  it('takes the body asked for, or a moon', async () => {
    const free = (await composed.commands.freePlanets()).at(-1)!;
    expect((await scenario({ bodyId: free.id, stewards: 0, asteroid: false })).bodyId).toBe(
      free.id,
    );
    const moon = await scenario({ kind: 'moon', stewards: 0, asteroid: false });
    expect(composed.log.tables.bodies.get(moon.bodyId)?.kind).toBe('moon');
  });
});

describe('/dev/harness agent states (P4-06)', () => {
  it('injects each state through the runtime’s events, and the status stream carries it', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const id = out.stewardIds[0]!;
    const pushed: StatusRecord[][] = [];
    composed.statuses.subscribe((records) => pushed.push(records));
    for (const target of [
      'idle',
      'paused',
      'working',
      'stalled',
      'failed',
      'working',
      'stopped',
    ] as const) {
      const n = seen.length;
      const res = await post(`/dev/harness/agents/${id}/state`, { state: target });
      expect(res.status, target).toBe(200);
      expect(state(id), target).toBe(target);
      // Every change is an agent event in the log (never a write around it), plus the task
      // state the work-state deriver derives from it.
      const types = typesSince(n).filter((type) => type !== 'task.state_changed');
      expect(types.length, target).toBeGreaterThan(0);
      expect(
        types.every((type) => type.startsWith('agent.')),
        target,
      ).toBe(true);
    }
    // failed → working went through a new `agent.spawned` (the only way out of an ending).
    expect(
      seen.filter(
        (e) => e.event.type === 'agent.spawned' && 'agentId' in e.event && e.event.agentId === id,
      ),
    ).toHaveLength(2);
    // The stream got the latest state.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      pushed
        .flat()
        .filter((r) => r.agentId === id)
        .at(-1)?.state,
    ).toBe('stopped');
  });

  it('reaches the status stream well within a second (the exit criterion)', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const id = out.stewardIds[0]!;
    await new Promise((r) => setTimeout(r, 30)); // let the scenario's diffs go out
    const got = new Promise<number>((resolve) => {
      composed.statuses.subscribe((records) => {
        if (records.some((r) => r.agentId === id && r.state === 'paused')) resolve(Date.now());
      });
    });
    const t0 = Date.now();
    await post(`/dev/harness/agents/${id}/state`, { state: 'paused' });
    expect((await got) - t0).toBeLessThan(1_000);
  });

  it('never lets a fake agent stall on its own', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    await new Promise((r) => setTimeout(r, 150)); // 3× the 50 ms threshold, ticked every 20 ms
    expect(state(out.stewardIds[0]!)).toBe('working');
  });

  it('sets activities from presets or text', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const id = out.stewardIds[0]!;
    await post(`/dev/harness/agents/${id}/activity`, { preset: 'building' });
    expect(composed.statuses.get(id)?.currentActivity).toBe('Bash: pnpm test');
    await post(`/dev/harness/agents/${id}/activity`, { text: 'Reading the docs' });
    expect(composed.statuses.get(id)).toMatchObject({
      state: 'working',
      currentActivity: 'Reading the docs',
    });
    await post(`/dev/harness/agents/${id}/state`, {
      state: 'working',
      activity: 'Editing 5 files',
    });
    expect(composed.statuses.get(id)?.currentActivity).toBe('Editing 5 files');
  });

  it('creates fake agents for existing work, one running per task', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const again = await post('/dev/harness/agents', { role: 'steward', taskId: out.taskIds[0] });
    expect(again.status).toBe(409);
    const fresh = await post('/dev/harness/agents', { role: 'steward', projectId: out.projectId });
    expect(fresh.status).toBe(200);
    const { agentId, taskId } = fresh.body as { agentId: string; taskId: string };
    expect(composed.log.tables.tasks.get(taskId)?.projectId).toBe(out.projectId);
    expect(state(agentId)).toBe('starting');
    const lone = await post('/dev/harness/agents', { role: 'steward' });
    const loneTask = composed.log.tables.tasks.get((lone.body as { taskId: string }).taskId)!;
    expect(composed.log.tables.bodies.get(loneTask.bodyId)?.kind).toBe('asteroid');
  });
});

describe('/dev/harness work events (P4-06)', () => {
  it('moves a standalone task into the project: its Steward goes along (it flies)', async () => {
    const out = await scenario({ stewards: 1 });
    const n = seen.length;
    const res = await post(`/dev/harness/tasks/${out.asteroidTaskId}/move`, {
      projectId: out.projectId,
    });
    expect(res.status).toBe(200);
    expect(typesSince(n)).toEqual(
      expect.arrayContaining(['task.updated', 'body.moved', 'agent.updated']),
    );
    const steward = composed.log.tables.agents.get(out.asteroidStewardId!)!;
    expect(steward).toMatchObject({
      bodyId: out.bodyId,
      projectId: out.projectId,
      supervisorId: out.waykeeperId,
    });
    expect(state(steward.id)).toBe('working');
  });

  it('completes a task: its Steward finishes, then the task is closed', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const n = seen.length;
    expect((await post(`/dev/harness/tasks/${out.taskIds[0]}/complete`)).status).toBe(200);
    const types = typesSince(n);
    // Closed by the command, not the panel's `control.close`: no supervisor's brain is concerned.
    expect(types.some((type) => type.startsWith('control.'))).toBe(false);
    expect(types.indexOf('agent.finished')).toBeLessThan(types.lastIndexOf('task.state_changed'));
    expect(composed.log.tables.tasks.get(out.taskIds[0]!)?.state).toBe('completed');
    expect(state(out.stewardIds[0]!)).toBe('finished');
    expect((await post(`/dev/harness/tasks/${out.taskIds[0]}/complete`)).status).toBe(409);
  });

  it('closes a project: its Waykeeper finishes and the project completes', async () => {
    const out = await scenario({ stewards: 0, asteroid: false });
    expect((await post(`/dev/harness/projects/${out.projectId}/close`)).status).toBe(200);
    expect(composed.log.tables.projects.get(out.projectId)?.state).toBe('completed');
    expect(state(out.waykeeperId)).toBe('finished');
  });

  it('opens a permission question for the user and answers it', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const id = out.stewardIds[0]!;
    const asked = await post(`/dev/harness/agents/${id}/question`, { kind: 'permission' });
    const questionId = asked.body['questionId'] as string;
    const question = composed.log.tables.questions.get(questionId)!;
    expect(question).toMatchObject({
      kind: 'permission',
      status: 'open',
      holder: { type: 'user' },
    });
    expect(composed.statuses.get(id)).toMatchObject({
      state: 'waiting_for_input',
      pendingQuestionId: questionId,
    });
    expect((await post(`/dev/harness/questions/${questionId}/answer`, {})).status).toBe(200);
    expect(composed.log.tables.questions.get(questionId)?.status).toBe('answered');
    expect(state(id)).toBe('working');
  });

  it('opens a clarification for the user (not the supervising Waykeeper)', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const id = out.stewardIds[0]!;
    const asked = await post(`/dev/harness/agents/${id}/question`, {
      kind: 'clarification',
      text: 'Tabs or spaces?',
    });
    const question = composed.log.tables.questions.get(asked.body['questionId'] as string)!;
    expect(question).toMatchObject({
      kind: 'clarification',
      holder: { type: 'user' },
      context: { text: 'Tabs or spaces?' },
    });
    expect(state(id)).toBe('waiting_for_input');
    // `waiting_for_input` as a state asks a permission question; moving on withdraws it.
    const other = await scenario({ stewards: 1, asteroid: false });
    const otherId = other.stewardIds[0]!;
    await post(`/dev/harness/agents/${otherId}/state`, { state: 'waiting_for_input' });
    expect(state(otherId)).toBe('waiting_for_input');
    const pending = composed.statuses.get(otherId)!.pendingQuestionId!;
    await post(`/dev/harness/agents/${otherId}/state`, { state: 'paused' });
    expect(composed.log.tables.questions.get(pending)?.status).toBe('open');
    await post(`/dev/harness/agents/${otherId}/state`, { state: 'idle' });
    expect(composed.log.tables.questions.get(pending)?.status).toBe('cancelled');
    expect(composed.statuses.get(otherId)).toMatchObject({ state: 'idle' });
    // Failing the agent cancels its question (the runtime's ending path).
    await post(`/dev/harness/agents/${id}/state`, { state: 'failed' });
    expect(composed.log.tables.questions.get(question.id)?.status).toBe('cancelled');
  });

  it('clears what it made and nothing else', async () => {
    const real = await composed.commands.createProject({ name: 'Real', workspace: '/tmp/real' });
    const out = await scenario({ stewards: 2 });
    await post(`/dev/harness/tasks/${out.taskIds[0]}/complete`);
    const res = await post('/dev/harness/clear');
    expect(res.status).toBe(200);
    const cleared = res.body as unknown as HarnessClearResponse;
    expect(cleared.skipped).toEqual([]);
    expect(cleared.projects).toEqual([out.projectId]);
    expect(cleared.tasks).toHaveLength(3);
    expect(cleared.stopped.sort()).toEqual(
      [out.waykeeperId, out.stewardIds[1]!, out.asteroidStewardId!].sort(),
    );
    const { tables } = composed.log;
    expect(tables.projects.get(out.projectId)?.state).toBe('archived');
    expect(tables.bodies.get(out.bodyId)?.host).toBeUndefined();
    expect(tables.projects.get(real.value.id)?.state).toBe('approved');
    const list = await fetch(`${t.baseUrl}/dev/harness`, {
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(await list.json()).toMatchObject({ projects: [], tasks: [] });
  });
});

describe('recovery and the scene harness (P4-06)', () => {
  it('ends a fake agent stopped at the next start instead of reopening it', async () => {
    const out = await scenario({ stewards: 1, asteroid: false });
    const report = await composed.recover();
    expect(report.resumed).toEqual([]);
    expect(state(out.stewardIds[0]!)).toBe('stopped');
    expect(state(out.waykeeperId)).toBe('stopped');
  });
});

describe('the harness touches only its own rows (P4-06 review)', () => {
  const waitFor = async (pred: () => boolean, what: string, ms = 3_000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  const spawnReal = async (role: 'steward' | 'harmonizer', prompt: string) => {
    const spawned = await composed.runtime.spawn({
      role,
      runtime: 'fake',
      prompt,
      cwd: '/tmp/real-worktree',
    });
    if (!spawned.ok) throw new Error(spawned.reason);
    return spawned.agent.id;
  };
  const refused = (res: { status: number; body: Record<string, unknown> }, what: string) => {
    expect(res.status, what).toBe(409);
    expect(res.body['error'], what).toBe('not_harness');
  };

  it('refuses a real agent, the Harmonizer too, writing nothing; recovery never resumes it', async () => {
    const steward = await spawnReal('steward', 'scenario:happy');
    await waitFor(() => state(steward) === 'finished', 'the real Steward finishes');
    const harmonizer = await spawnReal('harmonizer', 'scenario:happy');
    await waitFor(() => state(harmonizer) === 'finished', 'the real Harmonizer finishes');
    const n = seen.length;
    for (const id of [steward, harmonizer]) {
      refused(await post(`/dev/harness/agents/${id}/state`, { state: 'working' }), `${id} state`);
      refused(await post(`/dev/harness/agents/${id}/state`, { state: 'idle' }), `${id} idle`);
      refused(
        await post(`/dev/harness/agents/${id}/activity`, { preset: 'building' }),
        `${id} activity`,
      );
      refused(
        await post(`/dev/harness/agents/${id}/question`, { kind: 'permission' }),
        `${id} question`,
      );
    }
    expect(seen.length).toBe(n);
    expect(state(steward)).toBe('finished');
    // The next start: nothing to resume — the real session stays ended in its real worktree.
    const report = await composed.recover();
    expect(report.resumed).not.toContain(steward);
    expect(report.resumed).not.toContain(harmonizer);
    expect(state(steward)).toBe('finished');
  });

  it('never answers a real agent’s question (a real permission above all)', async () => {
    const steward = await spawnReal('steward', 'scenario:permission');
    await waitFor(() => state(steward) === 'waiting_for_input', 'the real permission question');
    const questionId = composed.statuses.get(steward)!.pendingQuestionId!;
    expect(composed.log.tables.questions.get(questionId)?.kind).toBe('permission');
    const n = seen.length;
    refused(await post(`/dev/harness/questions/${questionId}/answer`, {}), 'answer');
    expect(seen.length).toBe(n);
    expect(composed.log.tables.questions.get(questionId)?.status).toBe('open');
    expect(state(steward)).toBe('waiting_for_input');
  });

  it('refuses real tasks and projects: no move, complete, close or fake agent on them', async () => {
    const out = await scenario({ stewards: 0 });
    const { value: project } = await composed.commands.createProject({
      name: 'Real',
      workspace: '/tmp/real',
    });
    const { value: task } = await composed.commands.createTask({
      description: 'Real task',
      projectId: project.id,
    });
    const { value: solo } = await composed.commands.createTask({ description: 'Real solo' });
    const { tables } = composed.log;
    const before = { task: tables.tasks.get(task.id)!, project: tables.projects.get(project.id)! };
    const n = seen.length;
    refused(await post(`/dev/harness/tasks/${solo.id}/move`, { projectId: out.projectId }), 'mv');
    refused(
      await post(`/dev/harness/tasks/${out.asteroidTaskId}/move`, { projectId: project.id }),
      'move into a real project',
    );
    refused(await post(`/dev/harness/tasks/${task.id}/complete`), 'complete');
    refused(await post(`/dev/harness/tasks/${solo.id}/complete`), 'complete solo');
    refused(await post(`/dev/harness/projects/${project.id}/close`), 'close');
    refused(
      await post('/dev/harness/agents', { role: 'waykeeper', projectId: project.id }),
      'a fake Waykeeper on a real project',
    );
    refused(
      await post('/dev/harness/agents', { role: 'steward', projectId: project.id }),
      'a fake Steward on a new task of a real project',
    );
    refused(
      await post('/dev/harness/agents', { role: 'steward', taskId: solo.id }),
      'a fake Steward on a real task',
    );
    expect(seen.length).toBe(n);
    expect(tables.tasks.get(task.id)).toEqual(before.task);
    expect(tables.tasks.get(solo.id)?.projectId).toBeUndefined();
    expect(tables.projects.get(project.id)).toEqual(before.project);
  });

  it('a harness completion and close wake no real brain (no control event, no message)', async () => {
    const harmonizer = await spawnReal('harmonizer', 'scenario:long');
    await waitFor(() => state(harmonizer) === 'working', 'the real Harmonizer runs');
    const out = await scenario({ stewards: 1 });
    const n = seen.length;
    expect((await post(`/dev/harness/tasks/${out.taskIds[0]}/complete`)).status).toBe(200);
    expect((await post(`/dev/harness/tasks/${out.asteroidTaskId}/complete`)).status).toBe(200);
    expect((await post(`/dev/harness/projects/${out.projectId}/close`)).status).toBe(200);
    const events = seen.slice(n).map((e) => e.event);
    expect(events.some((e) => e.type.startsWith('control.'))).toBe(false);
    expect(events.some((e) => e.type === 'message.sent')).toBe(false);
    const scope = createWakeScope(
      composed.log.tables,
      { brainId: harmonizer, role: 'harmonizer' },
      { isLive: () => true },
    );
    expect(events.map((e) => wakeLine(e, scope)).filter(Boolean)).toEqual([]);
  });
});
