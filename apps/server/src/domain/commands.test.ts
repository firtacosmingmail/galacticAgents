import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { concernedSupervisors } from './cascade.js';
import { createAgent } from './agents.js';
import { Commands } from './commands.js';
import { DomainError } from './errors.js';
import { EventLog } from './event-log.js';

/**
 * The `DomainCommands` surface (P2-01) over a real runtime with the fake adapter: domain
 * commands resolve with their row and events, agent commands go through the runtime and land
 * where the hierarchy puts them (decision 24).
 */

const USER: Actor = { type: 'user' };
const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function boot(speed = 0) {
  const composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed })],
    flushMs: 10,
  });
  lives.push(composed);
  return composed;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Commands', () => {
  it('resolves a domain command with its row and events, and rejects with a DomainError', async () => {
    const { commands, log } = boot();
    const { value, events } = await commands.createProject({ name: 'CSV', workspace: '/w/csv' });
    expect(events.map((e) => e.type)).toEqual(['project.created', 'body.assigned']);
    expect(log.tables.projects.get(value.id)).toEqual(value);
    await expect(commands.closeTask('t-x', USER)).rejects.toBeInstanceOf(DomainError);
    await expect(commands.closeTask('t-x', USER)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('spawns a Steward in its project workspace, on the task body, under the project policy', async () => {
    const { commands, log, runtime } = boot();
    const policy = { rules: { network: 'allow' as const } };
    const project = (
      await commands.createProject({ name: 'CSV', workspace: '/w/csv', permissionPolicy: policy })
    ).value;
    const task = (await commands.createTask({ description: 'parse', projectId: project.id })).value;
    const { value: agent, events } = await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: task.id,
      prompt: 'scenario:echo',
    });
    expect(agent).toMatchObject({
      role: 'steward',
      bodyId: project.bodyId,
      taskId: task.id,
      projectId: project.id,
    });
    expect(agent.meta).toMatchObject({
      cwd: '/w/csv',
      workspace: '/w/csv',
      permissionPolicy: policy,
    });
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(['agent.created', 'agent.spawned']);
    expect(runtime.liveAgents().map((a) => a.id)).toContain(agent.id);
    expect(log.tables.agents.get(agent.id)?.bodyId).toBe(project.bodyId);
  });

  it('refuses a cwd for a standalone Steward that already has a worktree', async () => {
    const { commands } = boot();
    const task = (await commands.createTask({ description: 'flaky' })).value;
    await commands.updateTask(task.id, { worktreePath: '/w/scratch/t' });
    await expect(
      commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        cwd: '/x',
        prompt: 'x',
      }),
    ).rejects.toThrow(/workspace or worktree/);
  });

  it('runs a Steward in its task worktree once it has one', async () => {
    const { commands } = boot();
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (await commands.createTask({ description: 'parse', projectId: project.id })).value;
    await commands.updateTask(task.id, { worktreePath: '/w/csv/.galactic/worktrees/t' });
    const { value } = await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: task.id,
      prompt: 'x',
    });
    expect(value.meta).toMatchObject({ cwd: '/w/csv/.galactic/worktrees/t', workspace: '/w/csv' });
  });

  it("lets a standalone task's Steward name its working directory", async () => {
    const { commands } = boot();
    const task = (await commands.createTask({ description: 'flaky' })).value;
    const { value } = await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: task.id,
      cwd: '/w/scratch',
      prompt: 'x',
    });
    expect(value).toMatchObject({ bodyId: task.bodyId, taskId: task.id });
    expect(value.meta).toMatchObject({ cwd: '/w/scratch' });
    expect(value.projectId).toBeUndefined();
  });

  it('refuses spawns the hierarchy does not allow (decision 24), before anything is written', async () => {
    const { commands, log } = boot();
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (await commands.createTask({ description: 'parse', projectId: project.id })).value;
    const seq = log.currentSeq();
    await expect(
      commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'x',
        cwd: '/etc',
      }),
    ).rejects.toThrow(/workspace or worktree/);
    await expect(
      commands.spawnAgent({ role: 'steward', runtime: 'fake', prompt: 'x' }),
    ).rejects.toThrow(/needs a task/);
    await expect(
      commands.spawnAgent({ role: 'waykeeper', runtime: 'fake', prompt: 'x' }),
    ).rejects.toThrow(/needs a project/);
    await expect(
      commands.spawnAgent({ role: 'harmonizer', runtime: 'fake', prompt: 'x' }),
    ).rejects.toThrow(/working directory/);
    await expect(
      commands.spawnAgent({ role: 'steward', runtime: 'acp', taskId: task.id, prompt: 'x' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(log.currentSeq()).toBe(seq);
  });

  it('answers a live agent through its adapter, first answer wins', async () => {
    const { commands, log } = boot();
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (await commands.createTask({ description: 'export', projectId: project.id }))
      .value;
    const agent = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:asks',
      })
    ).value;
    await until(() => log.tables.questions.all().some((q) => q.originAgentId === agent.id));
    const question = log.tables.questions.all().find((q) => q.originAgentId === agent.id)!;
    const { value, events } = await commands.answerQuestion({
      questionId: question.id,
      answer: 'ISO 8601',
      by: USER,
      version: question.version,
    });
    expect(value).toMatchObject({ status: 'answered', answer: 'ISO 8601', answeredBy: USER });
    expect(events.map((e) => e.type)).toEqual(['question.answered']);
    await expect(
      commands.answerQuestion({ questionId: question.id, answer: 'EU', by: USER }),
    ).rejects.toThrow(/already answered by the user/);
  });

  it('pauses, resumes and stops agents through the runtime, as agent controls', async () => {
    const { commands, statuses } = boot();
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const agent = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        prompt: 'scenario:long',
      })
    ).value;
    await until(() => statuses.get(agent.id)?.state === 'working');
    const target = { kind: 'agent', id: agent.id } as const;
    expect((await commands.control(target, { action: 'pause' }, USER)).events[0]).toEqual({
      type: 'control.pause',
      target,
      by: USER,
    });
    await commands.resumeAgent(agent.id, USER);
    const stopped = await commands.control(target, { action: 'stop' }, USER);
    expect(stopped.events.map((e) => e.type)).toContain('agent.stopped');
    await expect(commands.control(target, { action: 'archive' }, USER)).rejects.toThrow(
      /cannot be given/,
    );
  });

  it('records an adapter event on the row too: agent.spawned keeps its session ref', async () => {
    const { commands, log } = boot();
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w' })).value;
    const agent = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        prompt: 'x',
      })
    ).value;
    const { events } = await commands.recordAgentEvent({
      type: 'agent.spawned',
      agentId: agent.id,
      role: 'waykeeper',
      runtime: 'fake',
      bodyId: agent.bodyId,
      sessionRef: 's-9',
    });
    expect(events).toMatchObject([{ type: 'agent.spawned', agentId: agent.id, sessionRef: 's-9' }]);
    expect(log.tables.agents.get(agent.id)?.sessionRef).toBe('s-9');
    const { events: idle } = await commands.recordAgentEvent({
      type: 'agent.idle',
      agentId: agent.id,
    });
    expect(idle).toEqual([{ type: 'agent.idle', agentId: agent.id }]);
    await expect(commands.recordAgentEvent({ type: 'agent.idle', agentId: 'a-x' })).rejects.toThrow(
      /no agent a-x/,
    );
  });

  it('refuses a second answer while the first is still reaching the adapter', async () => {
    const { commands, log } = boot();
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w' })).value;
    const task = (await commands.createTask({ description: 'x', projectId: project.id })).value;
    const agent = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:asks',
      })
    ).value;
    await until(() => log.tables.questions.all().some((q) => q.originAgentId === agent.id));
    const q = log.tables.questions.all().find((x) => x.originAgentId === agent.id)!;
    const first = commands.answerQuestion({ questionId: q.id, answer: 'ISO 8601', by: USER });
    const second = commands.answerQuestion({ questionId: q.id, answer: 'EU', by: USER });
    await expect(first).resolves.toMatchObject({ value: { answer: 'ISO 8601' } });
    await expect(second).rejects.toMatchObject({ code: 'stale' });
    expect(log.tables.questions.get(q.id)?.answer).toBe('ISO 8601');
  });

  it('refuses agent commands without a runtime', async () => {
    const log = new EventLog(openDatabase(':memory:'));
    const commands = new Commands({ log });
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w' })).value;
    await expect(
      commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        prompt: 'x',
      }),
    ).rejects.toThrow(/no agent runtime/);
  });
});

describe('Commands.control on tasks and projects (P2-14)', () => {
  async function hierarchy() {
    // Real step delays: `scenario:long` keeps both agents working for the whole test.
    const composed = boot(1);
    const { commands, statuses } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (await commands.createTask({ description: 'parse', projectId: project.id })).value;
    const waykeeper = (
      await commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        prompt: 'scenario:long',
      })
    ).value;
    const steward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: waykeeper.id,
        prompt: 'scenario:long',
      })
    ).value;
    await until(
      () =>
        statuses.get(waykeeper.id)?.state === 'working' &&
        statuses.get(steward.id)?.state === 'working',
    );
    return { ...composed, project, task, waykeeper, steward };
  }

  it('a pause holds against a user-held question, and resume finds the task paused (review fix)', async () => {
    const composed = boot(1);
    const { commands, log, statuses } = composed;
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const task = (await commands.createTask({ description: 'clean', projectId: project.id })).value;
    const steward = (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        prompt: 'scenario:permission',
      })
    ).value;
    await until(() => log.tables.tasks.get(task.id)?.state === 'blocked_on_user');
    const target = { kind: 'task', id: task.id } as const;
    await commands.control(target, { action: 'pause' }, USER);
    await until(() => statuses.get(steward.id)?.state === 'paused');
    expect(log.tables.tasks.get(task.id)?.state).toBe('paused');
    await commands.control(target, { action: 'resume' }, USER);
    await until(() => log.tables.tasks.get(task.id)?.state === 'blocked_on_user');
  });

  it('pausing a task pauses its Steward and wakes its Waykeeper; resume undoes both', async () => {
    const { commands, log, statuses, task, waykeeper, steward } = await hierarchy();
    const target = { kind: 'task', id: task.id } as const;
    const { events } = await commands.control(target, { action: 'pause' }, USER);
    expect(events.map((e) => e.type)).toEqual([
      'control.pause',
      'task.state_changed',
      'control.pause',
      ...events.slice(3).map((e) => e.type),
    ]);
    expect(events[2]).toEqual({
      type: 'control.pause',
      target: { kind: 'agent', id: steward.id },
      by: USER,
    });
    await until(() => statuses.get(steward.id)?.state === 'paused');
    expect(statuses.get(waykeeper.id)?.state).toBe('working');
    expect(log.tables.tasks.get(task.id)?.state).toBe('paused');
    // The stand-in supervisor check: the task-level event goes to the Waykeeper's mailbox.
    expect(concernedSupervisors(log.tables, events[0]!)).toEqual([waykeeper.id]);
    expect(concernedSupervisors(log.tables, events[2]!)).toEqual([waykeeper.id]);

    await commands.control(target, { action: 'resume' }, USER);
    await until(() => statuses.get(steward.id)?.state !== 'paused');
    expect(log.tables.tasks.get(task.id)?.state).toBe('in_progress');
  });

  it('pausing a project pauses its Waykeeper and its Stewards', async () => {
    const { commands, statuses, project, waykeeper, steward } = await hierarchy();
    await commands.control({ kind: 'project', id: project.id }, { action: 'pause' }, USER);
    await until(
      () =>
        statuses.get(waykeeper.id)?.state === 'paused' &&
        statuses.get(steward.id)?.state === 'paused',
    );
  });

  it('stopping a task stops its Steward and leaves the task paused for its Waykeeper', async () => {
    const { commands, log, statuses, task, waykeeper, steward } = await hierarchy();
    const { events } = await commands.control(
      { kind: 'task', id: task.id },
      { action: 'stop' },
      USER,
    );
    expect(events.map((e) => e.type)).toContain('agent.stopped');
    expect(statuses.get(steward.id)?.state).toBe('stopped');
    expect(statuses.get(waykeeper.id)?.state).toBe('working');
    expect(log.tables.tasks.get(task.id)?.state).toBe('paused');
  });

  it('cancelling a project stops its agents; the body is freed when retention archives it', async () => {
    const { commands, log, statuses, runtime, project, task, waykeeper, steward } =
      await hierarchy();
    const target = { kind: 'project', id: project.id } as const;
    const { events } = await commands.control(target, { action: 'cancel' }, USER);
    expect(events.filter((e) => e.type === 'agent.stopped')).toHaveLength(2);
    expect(statuses.get(waykeeper.id)?.state).toBe('stopped');
    expect(statuses.get(steward.id)?.state).toBe('stopped');
    expect(runtime.liveAgents()).toEqual([]);
    expect(log.tables.projects.get(project.id)?.state).toBe('failed');
    expect(log.tables.tasks.get(task.id)?.state).toBe('failed');
    // Retained: the body still hosts the project until the archival job runs.
    expect(log.tables.bodies.get(project.bodyId)?.host).toEqual({
      kind: 'project',
      id: project.id,
    });
    // The retention step through the seam (P2-13 runs it on its timer).
    const archived = await commands.control(target, { action: 'archive' }, { type: 'system' });
    expect(archived.events.map((e) => e.type)).toEqual([
      'control.archive',
      'project.state_changed',
      'body.freed',
    ]);
    expect(log.tables.bodies.get(project.bodyId)?.host).toBeUndefined();
  });

  it('closing a project stops its Waykeeper', async () => {
    const { commands, statuses, project, task, waykeeper } = await hierarchy();
    await commands.control({ kind: 'task', id: task.id }, { action: 'close' }, USER);
    await commands.control({ kind: 'project', id: project.id }, { action: 'close' }, USER);
    expect(statuses.get(waykeeper.id)?.state).toBe('stopped');
  });

  it('a refused control touches no agent', async () => {
    const { commands, statuses, task, steward } = await hierarchy();
    await expect(
      commands.control({ kind: 'task', id: task.id }, { action: 'resume' }, USER),
    ).rejects.toThrow(/not paused/);
    expect(statuses.get(steward.id)?.state).toBe('working');
  });
});

describe('Commands.control result (wave-2 review)', () => {
  it('returns only what the call caused, never another actor’s events logged meanwhile', async () => {
    const log = new EventLog(openDatabase(':memory:'));
    const agentId = 'a-steward-x';
    const userPause = (taskId: string) =>
      log.runCommand(({ emit }) =>
        emit({ type: 'control.pause', target: { kind: 'task', id: taskId }, by: USER }),
      );
    let other = '';
    const agents = {
      spawn: () => Promise.reject(new Error('unused')),
      stop: () => Promise.resolve(),
      resumeAgent: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      hasQuestion: () => false,
      liveAgents: () => [log.tables.agents.get(agentId)!],
      pause: (id: string, by: Actor) => {
        userPause(other); // someone else, while the runtime call is under way
        log.runCommand(({ emit }) => {
          emit({ type: 'control.pause', target: { kind: 'agent', id }, by });
          emit({ type: 'agent.paused', agentId: id, by });
        });
        return Promise.resolve();
      },
    };
    const commands = new Commands({ log, agents });
    const project = (await commands.createProject({ name: 'CSV', workspace: '/w' })).value;
    const a = (await commands.createTask({ description: 'a', projectId: project.id })).value;
    other = (await commands.createTask({ description: 'b', projectId: project.id })).value.id;
    log.runCommand((ctx) =>
      createAgent(ctx, {
        agentId,
        role: 'steward',
        runtime: 'fake',
        caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
        bodyId: project.bodyId,
        taskId: a.id,
      }),
    );
    const brain: Actor = { type: 'agent', id: 'a-brain' };
    const { events } = await commands.control(
      { kind: 'task', id: a.id },
      { action: 'pause' },
      brain,
    );
    expect(events.map((e) => e.type)).toEqual([
      'control.pause',
      'task.state_changed',
      'control.pause',
      'agent.paused',
    ]);
    expect(events.some((e) => 'target' in e && e.target.id === other)).toBe(false);
  });
});
