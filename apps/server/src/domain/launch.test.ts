import { describe, expect, it } from 'vitest';
import {
  LAUNCH_ACTIONS,
  type Actor,
  type LaunchRequest,
  type RequestLaunchInput,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { Commands } from './commands.js';
import { DomainError } from './errors.js';
import { createProject } from './projects.js';
import { logRouting } from './question-service.js';
import { createTask } from './tasks.js';

/** P12-07: launch approvals are the user's alone and usable once, for one task, by one Waykeeper. */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const REQUEST: LaunchRequest = {
  flags: ['chrome'],
  reason: 'Check the page in a real browser',
  expectedUse: 'Open localhost and take a screenshot',
  check: 'The Steward used only the browser tools on localhost',
};

function setup() {
  const w = world();
  const commands = new Commands({ log: w.log, questions: logRouting(w.log, () => true) });
  const cmd = <T>(fn: Parameters<typeof w.log.runCommand<T>>[0]): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace: '/tmp/shop',
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    }),
  );
  const wk = cmd((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  );
  const task = cmd((ctx) => createTask(ctx, { projectId: project.id, description: 'Fix page' }));
  const other = cmd((ctx) => createTask(ctx, { projectId: project.id, description: 'Other' }));
  const input = (over: Partial<RequestLaunchInput> = {}): RequestLaunchInput => ({
    originAgentId: wk.id,
    taskId: task.id,
    request: REQUEST,
    instructions: 'Fix the page',
    cwd: '/tmp/shop/wt',
    runtime: 'claude-sdk',
    ...over,
  });
  const asked = async () => (await commands.requestLaunch(input())).value.questionId;
  const answer = (questionId: string, text: string, by: Actor = USER) =>
    commands.answerQuestion({ questionId, answer: text, by });
  const take = (questionId: string, taskId = task.id, by: Actor = { type: 'agent', id: wk.id }) =>
    commands.takeLaunchApproval({ questionId, taskId, by });
  return { ...w, commands, cmd, project, wk, task, other, input, asked, answer, take };
}

const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error('expected a DomainError');
};

describe('requestLaunch', () => {
  it('opens a launch question held by the user with the exact command', async () => {
    const s = setup();
    const id = await s.asked();
    const q = s.tables.questions.get(id)!;
    expect(q).toMatchObject({
      kind: 'launch',
      status: 'open',
      holder: USER,
      originAgentId: s.wk.id,
    });
    expect(q.context.options).toEqual([...LAUNCH_ACTIONS]);
    expect(q.context.text).toContain('with claude --chrome?');
    expect(q.context.launch).toMatchObject({
      ...REQUEST,
      taskId: s.task.id,
      command: 'claude --chrome',
      cwd: '/tmp/shop/wt',
      instructions: 'Fix the page',
    });
  });

  it('refuses an unsupported runtime, a second open request, and a foreign origin', async () => {
    const s = setup();
    expect(
      (await refusal(s.commands.requestLaunch(s.input({ runtime: 'codex' })))).message,
    ).toMatch(/not supported/);
    await s.asked();
    expect((await refusal(s.commands.requestLaunch(s.input()))).message).toMatch(/already waiting/);
    const steward = s.cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        taskId: s.other.id,
        projectId: s.project.id,
        supervisorId: s.wk.id,
      }),
    );
    expect(
      (
        await refusal(
          s.commands.requestLaunch(s.input({ originAgentId: steward.id, taskId: s.other.id })),
        )
      ).message,
    ).toMatch(/Waykeeper/);
  });
});

describe('answering a launch question', () => {
  it('accepts only the exact labels and only from the user', async () => {
    const s = setup();
    const id = await s.asked();
    expect((await refusal(s.answer(id, 'Approve'))).code).toBe('invalid');
    for (const by of [{ type: 'agent' as const, id: s.wk.id }, { type: 'system' as const }]) {
      expect((await refusal(s.answer(id, 'Approve and start', by))).message).toMatch(/user/);
    }
    await expect(s.commands.escalateQuestion(id, { type: 'agent', id: s.wk.id })).rejects.toThrow();
    expect((await s.answer(id, 'Approve and start')).value.status).toBe('answered');
  });
});

describe('takeLaunchApproval', () => {
  it('succeeds once after approval and is refused the second time', async () => {
    const s = setup();
    const id = await s.asked();
    await s.answer(id, 'Approve and start');
    const out = await s.take(id);
    expect(out.value).toMatchObject({ taskId: s.task.id, command: 'claude --chrome' });
    expect(s.tables.questions.get(id)?.meta?.['launchUsed']).toBe(true);
    expect((await refusal(s.take(id))).message).toMatch(/already used/);
  });

  it('is refused for another task, another agent, an open question', async () => {
    const s = setup();
    const id = await s.asked();
    expect((await refusal(s.take(id))).message).toMatch(/not answered/);
    await s.answer(id, 'Approve and start');
    await refusal(s.take(id, s.other.id));
    await refusal(s.take(id, s.task.id, USER));
    expect((await s.take(id)).value.taskId).toBe(s.task.id);
  });

  it.each(['Deny', 'Start without flags'])('is refused after %s', async (label) => {
    const s = setup();
    const id = await s.asked();
    await s.answer(id, label);
    expect((await refusal(s.take(id))).code).toBe('invalid_transition');
  });
});
