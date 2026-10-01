import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { BODIES } from '../test/world.js';
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

function boot() {
  const composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 0 })],
    flushMs: 10,
  });
  lives.push(composed);
  for (const body of BODIES) composed.log.tables.bodies.insert(body);
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

  it('refuses agent commands without a runtime', async () => {
    const log = new EventLog(openDatabase(':memory:'));
    const commands = new Commands({ log });
    for (const body of BODIES) log.tables.bodies.insert(body);
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
