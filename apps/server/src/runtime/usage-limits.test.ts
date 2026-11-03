import { afterEach, describe, expect, it } from 'vitest';
import {
  LIMIT_WAIT,
  type Actor,
  type AgentRuntime as RuntimeName,
  type Id,
  type ModelInfo,
  type Question,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { tickingClock } from '../test/world.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';
import { UsageLimits } from './usage-limits.js';

/**
 * P11-07 (plan Task 8; SPEC decision 148) — a Steward stopped by its provider's usage limit:
 * one question with the models that could take the step over, a switch that restarts the step
 * on the chosen model with a handover, a wait that retries at the reset time (an hour without
 * one), and a wait that survives a restart without retrying twice.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 60 * 60_000, maxToolCalls: 100 };
const START = Date.parse('2026-10-01T09:00:00.000Z');
const RESETS = '2026-10-01T14:00:00.000Z';

const model = (
  id: string,
  label: string,
  family: ModelInfo['family'],
  image = false,
): ModelInfo => ({
  id,
  label,
  family,
  isDefault: false,
  capabilities: image ? ['text', 'image'] : ['text'],
});

const GEMINI_MODELS = [
  model('gemini-3-pro-image', 'Gemini 3 Pro Image', 'gemini', true),
  model('gemini-3-flash-image', 'Gemini 3 Flash Image', 'gemini', true),
  model('gemini-3-flash', 'Gemini 3 Flash', 'gemini'),
  model('claude-opus-4', 'Opus', 'claude'),
];
const GPT_MODELS = [model('gpt-5.6', 'GPT-5.6', 'gpt')];
const CLAUDE_MODELS = [model('opus', 'Opus', 'claude'), model('sonnet', 'Sonnet', 'claude')];

/** The first attempt: a progress line, then the usage limit. */
const limited = (resetsAt?: string): FakeScenario => ({
  steps: [
    { kind: 'progress', summary: 'drew two of the four images' },
    {
      kind: 'fail',
      error: 'usage limit reached',
      reason: 'limit',
      ...(resetsAt ? { resetsAt } : {}),
    },
    { kind: 'output', text: 'carried on after the reset' },
  ],
});
const CARRY_ON: FakeScenario = { steps: [{ kind: 'output', text: 'carried on' }] };

const lives: ComposedRuntime[] = [];
const extra: UsageLimits[] = [];
afterEach(async () => {
  for (const u of extra.splice(0)) u.dispose();
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function boot(opts: { resetsAt?: string | null } = {}) {
  const clock = tickingClock(START);
  const resetsAt = opts.resetsAt === null ? undefined : (opts.resetsAt ?? RESETS);
  // A first spawn hits the limit; a Steward given the handover carries on.
  const scenarioFor = (spawn: { prompt: string }) =>
    spawn.prompt.includes('stopped at its usage limit')
      ? { name: 'carry', scenario: CARRY_ON }
      : { name: 'limited', scenario: limited(resetsAt) };
  const provider = (runtime: RuntimeName, models: ModelInfo[]) =>
    new FakeAdapter({ speed: 0, runtime, models, scenarioFor, canPublish: runtime !== 'agy' });
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [
      new FakeAdapter({ speed: 0 }),
      provider('claude-sdk', CLAUDE_MODELS),
      provider('codex', GPT_MODELS),
      provider('agy', GEMINI_MODELS),
    ],
    log: { now: clock },
    flushMs: 10,
    usageLimits: { tickMs: 0 },
  });
  lives.push(c);
  return { c, clock };
}

/** A project with a Waykeeper row (not running) and an approved image task on Gemini. */
async function imageTask(c: ComposedRuntime) {
  const project = (await c.commands.createProject({ name: 'Shop', workspace: '/w/shop' })).value;
  const wk = c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  ).value;
  const task = (
    await c.commands.createTask({
      projectId: project.id,
      description: 'Make the four campaign images',
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      makesImages: true,
    })
  ).value;
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'agy',
      model: 'gemini-3-pro-image',
      taskId: task.id,
      supervisorId: wk.id,
      prompt: 'Make the four campaign images.',
    })
  ).value;
  return { project, wk, task, steward };
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const limitQuestions = (c: ComposedRuntime, taskId: Id): Question[] =>
  c.log.tables.questions.all().filter((q) => q.context.usageLimit?.taskId === taskId);
const stewardsOf = (c: ComposedRuntime, taskId: Id) =>
  c.log.tables.agents.all().filter((a) => a.role === 'steward' && a.taskId === taskId);
const spawnsOf = (c: ComposedRuntime, agentId: Id) =>
  c.log
    .eventsSince(0, Number.MAX_SAFE_INTEGER)
    .filter((e) => e.event.type === 'agent.spawned' && e.event.agentId === agentId).length;

async function limitedTask(c: ComposedRuntime) {
  const made = await imageTask(c);
  await until(() => limitQuestions(c, made.task.id).length === 1, 'the limit question');
  return { ...made, question: limitQuestions(c, made.task.id)[0]! };
}

describe('usage limits (P11-07)', () => {
  it('one question with eligible models', async () => {
    const { c } = boot();
    const { task, steward, question } = await limitedTask(c);
    expect(question).toMatchObject({
      kind: 'clarification',
      originAgentId: steward.id,
      holder: { type: 'user' },
      status: 'open',
      meta: { toUser: true, jobOwned: false },
    });
    expect(question.context.text).toBe(
      `Gemini · Gemini 3 Pro Image usage limit reached — resets ${RESETS}. Switch to another model or wait?`,
    );
    expect(question.context.usageLimit).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      resetsAt: RESETS,
      taskId: task.id,
    });
    // An image step: only another Gemini image model; no ChatGPT or Claude model makes images.
    expect(question.context.usageLimit?.switchTo).toEqual([
      { provider: 'gemini', model: 'gemini-3-flash-image' },
    ]);
    const options = question.context.options ?? [];
    expect(options).toEqual(['Switch to Gemini · Gemini 3 Flash Image', LIMIT_WAIT]);
    expect(options.some((o) => o.includes('ChatGPT') || o.includes('GPT'))).toBe(false);
    expect(options.at(-1)).toBe(LIMIT_WAIT);
    // The step is paused, not failed.
    await until(() => c.log.tables.tasks.get(task.id)?.state === 'paused', 'the task paused');
  });

  it('a second limit opens nothing', async () => {
    const { c } = boot();
    const { task, wk } = await limitedTask(c);
    // Another Steward of the task hits the limit while the question is open.
    const again = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'agy',
        model: 'gemini-3-pro-image',
        taskId: task.id,
        supervisorId: wk.id,
        prompt: 'Make the four campaign images.',
      })
    ).value;
    await until(() => c.statuses.get(again.id)?.state === 'failed', 'the second limit');
    await c.usageLimits.settled();
    expect(limitQuestions(c, task.id)).toHaveLength(1);
  });

  it('switch updates the task and starts a Steward with the handover', async () => {
    const { c } = boot();
    const { task, wk, steward, question } = await limitedTask(c);
    await c.commands.answerQuestion({
      questionId: question.id,
      answer: 'Switch to Gemini · Gemini 3 Flash Image',
      by: USER,
    });
    await until(() => stewardsOf(c, task.id).length === 2, 'the new Steward');
    await c.usageLimits.settled();
    expect(c.log.tables.tasks.get(task.id)).toMatchObject({
      provider: 'gemini',
      model: 'gemini-3-flash-image',
    });
    const fresh = stewardsOf(c, task.id).find((a) => a.id !== steward.id)!;
    expect(fresh).toMatchObject({ runtime: 'agy', supervisorId: wk.id });
    expect(fresh.meta).toMatchObject({ model: 'gemini-3-flash-image' });
    const prompt = (fresh.meta as { prompt: string }).prompt;
    expect(prompt).toContain(
      'An earlier attempt on Gemini · Gemini 3 Pro Image stopped at its usage limit. Its work so far is in this folder; its last report: drew two of the four images. Continue from there.',
    );
    expect(prompt).toContain('Make the four campaign images');
    expect(c.log.tables.questions.get(question.id)?.meta).toMatchObject({
      switchTo: { provider: 'gemini', model: 'gemini-3-flash-image' },
    });
    // A switch is carried out once: a tick finds nothing left to do.
    await c.usageLimits.tick();
    expect(stewardsOf(c, task.id)).toHaveLength(2);
  });

  it('only the user answers, with one of the options', async () => {
    const { c } = boot();
    const { wk, question } = await limitedTask(c);
    await expect(
      c.commands.answerQuestion({ questionId: question.id, answer: 'Switch to Mars', by: USER }),
    ).rejects.toThrow(/answer the usage limit/);
    await expect(
      c.commands.answerQuestion({
        questionId: question.id,
        answer: LIMIT_WAIT,
        by: { type: 'agent', id: wk.id },
      }),
    ).rejects.toThrow();
  });

  it('wait retries at the reset time', async () => {
    const { c, clock } = boot();
    const { task, steward, question } = await limitedTask(c);
    await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
    expect(c.log.tables.questions.get(question.id)?.meta).toMatchObject({ retryAt: RESETS });
    // Before the reset: nothing.
    clock.advance(Date.parse(RESETS) - START - 60 * 60_000);
    await c.usageLimits.tick();
    expect(spawnsOf(c, steward.id)).toBe(1);
    // Past it: the stopped session runs again, on the same model.
    clock.advance(2 * 60 * 60_000);
    await c.usageLimits.tick();
    await until(() => spawnsOf(c, steward.id) === 2, 'the resumed Steward');
    expect(stewardsOf(c, task.id)).toHaveLength(1);
    expect(c.log.tables.agents.get(steward.id)?.meta).toMatchObject({
      model: 'gemini-3-pro-image',
    });
    expect(c.log.tables.questions.get(question.id)?.meta?.['retriedAt']).toBeDefined();
  });

  it('limit wait survives a restart', async () => {
    const { c, clock } = boot();
    const { task, steward, question } = await limitedTask(c);
    await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
    // The composition's watcher goes away; a new one on the same log takes over.
    c.usageLimits.dispose();
    const after = new UsageLimits({
      log: c.log,
      commands: c.commands,
      catalog: c.catalog,
      resume: (agentId, prompt) => c.runtime.resumeAfterLimit(agentId, prompt),
      tickMs: 0,
    });
    extra.push(after);
    clock.advance(Date.parse(RESETS) - START + 60_000);
    await after.tick();
    await until(() => spawnsOf(c, steward.id) === 2, 'the retried Steward');
    await after.tick();
    await after.settled();
    expect(spawnsOf(c, steward.id)).toBe(2);
    expect(stewardsOf(c, task.id)).toHaveLength(1);
  });

  it('no reset time waits an hour', async () => {
    const { c, clock } = boot({ resetsAt: null });
    const { steward, question } = await limitedTask(c);
    expect(question.context.text).toBe(
      'Gemini · Gemini 3 Pro Image usage limit reached. Switch to another model or wait?',
    );
    await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
    const retryAt = c.log.tables.questions.get(question.id)?.meta?.['retryAt'] as string;
    const answeredAt = Date.parse(c.log.tables.questions.get(question.id)!.updatedAt);
    expect(Date.parse(retryAt) - answeredAt).toBe(60 * 60_000);
    clock.advance(58 * 60_000);
    await c.usageLimits.tick();
    expect(spawnsOf(c, steward.id)).toBe(1);
    clock.advance(3 * 60_000);
    await c.usageLimits.tick();
    await until(() => spawnsOf(c, steward.id) === 2, 'the retried Steward');
  });
});
