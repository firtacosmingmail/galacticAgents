import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIMIT_WAIT,
  type Provider,
  type ProviderUsage,
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
import { DomainError } from '../domain/errors.js';
import { tickingClock } from '../test/world.js';
import type { CapsConfig } from './caps.js';
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
const TEXT_ON_GEMINI: Step = { provider: 'gemini', runtime: 'agy', model: 'gemini-3-flash' };
const CARRY_ON: FakeScenario = { steps: [{ kind: 'output', text: 'carried on' }] };

const lives: ComposedRuntime[] = [];
const extra: UsageLimits[] = [];
afterEach(async () => {
  for (const u of extra.splice(0)) u.dispose();
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function boot(
  opts: {
    resetsAt?: string | null;
    agyUsage?: ProviderUsage;
    caps?: CapsConfig;
    /** A database file (a restart: a second composition over the same file). */
    file?: string;
    clock?: ReturnType<typeof tickingClock>;
  } = {},
) {
  const clock = opts.clock ?? tickingClock(START);
  const resetsAt = opts.resetsAt === null ? undefined : (opts.resetsAt ?? RESETS);
  // A first spawn hits the limit; a Steward given the handover carries on.
  const scenarioFor = (spawn: { prompt: string }) =>
    spawn.prompt.includes('stopped at its usage limit')
      ? { name: 'carry', scenario: CARRY_ON }
      : { name: 'limited', scenario: limited(resetsAt) };
  const provider = (runtime: RuntimeName, models: ModelInfo[], usage?: ProviderUsage) =>
    new FakeAdapter({
      speed: 0,
      runtime,
      models,
      scenarioFor,
      canPublish: runtime !== 'agy',
      ...(usage ? { usage } : {}),
    });
  const c = composeRuntime(openDatabase(opts.file ?? ':memory:'), {
    adapters: [
      new FakeAdapter({ speed: 0 }),
      provider('claude-sdk', CLAUDE_MODELS),
      provider('codex', GPT_MODELS),
      provider('agy', GEMINI_MODELS, opts.agyUsage),
    ],
    log: { now: clock },
    flushMs: 10,
    ...(opts.caps ? { caps: opts.caps } : {}),
    usageLimits: { tickMs: 0 },
  });
  lives.push(c);
  return { c, clock };
}

interface Step {
  provider: Provider;
  runtime: RuntimeName;
  model: string;
  makesImages?: boolean;
}
const IMAGES: Step = {
  provider: 'gemini',
  runtime: 'agy',
  model: 'gemini-3-pro-image',
  makesImages: true,
};

/** A project with a Waykeeper row (not running) and an approved task (default: images on Gemini). */
async function stepTask(c: ComposedRuntime, step: Step = IMAGES) {
  const project = (await c.commands.createProject({ name: 'Shop', workspace: '/w/shop' })).value;
  const wk = c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  ).value;
  const task = (
    await c.commands.createTask({
      projectId: project.id,
      description: 'Make the four campaign images',
      provider: step.provider,
      model: step.model,
      ...(step.makesImages ? { makesImages: true } : {}),
    })
  ).value;
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: step.runtime,
      model: step.model,
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

async function limitedTask(c: ComposedRuntime, step?: Step) {
  const made = await stepTask(c, step);
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
    // An image step: no ChatGPT or Claude model makes images, and Gemini's other image model
    // shares the used-up subscription (ruling R17): only the wait is left.
    expect(question.context.usageLimit?.switchTo).toEqual([]);
    const options = question.context.options ?? [];
    expect(options).toEqual([LIMIT_WAIT]);
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
    const { task, wk, steward, question } = await limitedTask(c, TEXT_ON_GEMINI);
    await c.commands.answerQuestion({
      questionId: question.id,
      answer: 'Switch to ChatGPT · GPT-5.6',
      by: USER,
    });
    await until(() => stewardsOf(c, task.id).length === 2, 'the new Steward');
    await c.usageLimits.settled();
    expect(c.log.tables.tasks.get(task.id)).toMatchObject({
      provider: 'chatgpt',
      model: 'gpt-5.6',
    });
    const fresh = stewardsOf(c, task.id).find((a) => a.id !== steward.id)!;
    expect(fresh).toMatchObject({ runtime: 'codex', supervisorId: wk.id });
    expect(fresh.meta).toMatchObject({ model: 'gpt-5.6' });
    const prompt = (fresh.meta as { prompt: string }).prompt;
    expect(prompt).toContain(
      'An earlier attempt on Gemini · Gemini 3 Flash stopped at its usage limit. Its work so far is in this folder; its last report: drew two of the four images. Continue from there.',
    );
    expect(prompt).toContain('Make the four campaign images');
    expect(c.log.tables.questions.get(question.id)?.meta).toMatchObject({
      switchTo: { provider: 'chatgpt', model: 'gpt-5.6' },
    });
    // A switch is carried out once: a tick finds nothing left to do.
    await c.usageLimits.tick();
    expect(stewardsOf(c, task.id)).toHaveLength(2);
  });

  it('a Claude limit offers no Claude model', async () => {
    const { c } = boot();
    const { question } = await limitedTask(c, {
      provider: 'claude',
      runtime: 'claude-sdk',
      model: 'opus',
    });
    expect(question.context.options).toEqual([
      'Switch to ChatGPT · GPT-5.6',
      'Switch to Gemini · Gemini 3 Pro Image',
      'Switch to Gemini · Gemini 3 Flash Image',
      'Switch to Gemini · Gemini 3 Flash',
      'Switch to Opus through Antigravity',
      LIMIT_WAIT,
    ]);
    expect(question.context.options!.some((o) => o.startsWith('Switch to Claude'))).toBe(false);
  });

  it('a ChatGPT limit offers no ChatGPT model', async () => {
    const { c } = boot();
    const { question } = await limitedTask(c, {
      provider: 'chatgpt',
      runtime: 'codex',
      model: 'gpt-5.6',
    });
    const options = question.context.options ?? [];
    expect(options.some((o) => o.startsWith('Switch to ChatGPT'))).toBe(false);
    expect(options).toContain('Switch to Claude · Sonnet');
    expect(options.at(-1)).toBe(LIMIT_WAIT);
  });

  it('agy Gemini limit may offer agy Claude when its bucket has room', async () => {
    const usage = (claudeRoom: number): ProviderUsage => ({
      windows: [
        { label: 'Gemini Models · weekly', remainingFraction: 0 },
        { label: 'Claude and GPT models · weekly', remainingFraction: claudeRoom },
      ],
    });
    const roomy = boot({ agyUsage: usage(0.6) });
    const { question } = await limitedTask(roomy.c, TEXT_ON_GEMINI);
    const options = question.context.options ?? [];
    expect(options).toContain('Switch to Opus through Antigravity');
    expect(options.some((o) => o.startsWith('Switch to Gemini'))).toBe(false);

    const spent = boot({ agyUsage: usage(0) });
    const other = await limitedTask(spent.c, TEXT_ON_GEMINI);
    expect(other.question.context.options).not.toContain('Switch to Opus through Antigravity');
  });

  it('nothing restarts before start(); start() ticks once', async () => {
    const { c, clock } = boot();
    const { steward, question } = await limitedTask(c);
    await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
    c.usageLimits.dispose();
    clock.advance(Date.parse(RESETS) - START + 60_000);
    // A new server: built before recovery, it restarts nothing on its own.
    const after = new UsageLimits({
      log: c.log,
      commands: c.commands,
      catalog: c.catalog,
      resume: (agentId, prompt) => c.runtime.resumeAfterLimit(agentId, prompt),
      tickMs: 0,
    });
    extra.push(after);
    await after.settled();
    expect(spawnsOf(c, steward.id)).toBe(1);
    after.start();
    await after.settled();
    await until(() => spawnsOf(c, steward.id) === 2, 'the retried Steward');
  });

  it('a Steward already back on the task is not started twice', async () => {
    const { c, clock } = boot();
    const { task, wk, steward, question } = await limitedTask(c, TEXT_ON_GEMINI);
    await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
    clock.advance(Date.parse(RESETS) - START + 60_000);
    // As after a crash between the restart's spawn and its done mark: a Steward is on the task.
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'agy',
      model: 'gemini-3-flash',
      taskId: task.id,
      supervisorId: wk.id,
      prompt: 'An earlier attempt stopped at its usage limit. Continue.',
    });
    await c.usageLimits.tick();
    expect(spawnsOf(c, steward.id)).toBe(1);
    expect(stewardsOf(c, task.id)).toHaveLength(2);
    expect(c.log.tables.questions.get(question.id)?.meta?.['retriedAt']).toBeDefined();
  });

  it('a refused restart fails the task with the reason, once', async () => {
    // One spawn per brain per hour: the Waykeeper's first Steward used it.
    const { c } = boot({ caps: { maxSpawnsPerHourPerBrain: 1 } });
    const { task, question } = await limitedTask(c, TEXT_ON_GEMINI);
    await c.commands.answerQuestion({
      questionId: question.id,
      answer: 'Switch to ChatGPT · GPT-5.6',
      by: USER,
    });
    await c.usageLimits.settled();
    const failed = c.log.tables.tasks.get(task.id)!;
    expect(failed.state).toBe('failed');
    const reason = failed.meta?.['limitRestartFailed'] as string;
    expect(reason).toMatch(/^could not restart after the usage limit: .*cap/);
    const logged = c.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter(
        (e) =>
          (e.type === 'task.state_changed' && e.taskId === task.id && e.to === 'failed') ||
          (e.type === 'task.updated' &&
            e.taskId === task.id &&
            e.changes.meta?.['limitRestartFailed'] === reason),
      );
    expect(logged).toHaveLength(2);
    expect(c.log.tables.questions.get(question.id)?.meta).toMatchObject({
      limitRestartFailed: reason,
    });
    // Not retried.
    await c.usageLimits.tick();
    expect(stewardsOf(c, task.id)).toHaveLength(1);
  });

  it('only the user answers, with one of the options', async () => {
    const { c } = boot();
    const { wk, question } = await limitedTask(c);
    await expect(
      c.commands.answerQuestion({ questionId: question.id, answer: 'Switch to Mars', by: USER }),
    ).rejects.toThrow(/^Answer with one of: /);
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

  it('an open limit question is withdrawn when its task closes; a late answer is refused', async () => {
    const { c } = boot();
    const { task, question } = await limitedTask(c, TEXT_ON_GEMINI);
    await c.commands.closeTask(task.id, USER);
    expect(c.log.tables.questions.get(question.id)?.status).toBe('cancelled');
    const cancelled = c.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => e.type === 'question.cancelled' && e.questionId === question.id);
    expect(cancelled).toEqual([expect.objectContaining({ reason: 'the task was closed' })]);
    await expect(
      c.commands.answerQuestion({
        questionId: question.id,
        answer: 'Switch to ChatGPT · GPT-5.6',
        by: USER,
      }),
    ).rejects.toThrow(/withdrawn|cancelled|not open/);
    await c.usageLimits.tick();
    expect(stewardsOf(c, task.id)).toHaveLength(1);
  });

  it('a paused task keeps its limit question; a failed one withdraws it', async () => {
    const { c } = boot();
    const { task, question } = await limitedTask(c, TEXT_ON_GEMINI);
    await until(() => c.log.tables.tasks.get(task.id)?.state === 'paused', 'the task paused');
    expect(c.log.tables.questions.get(question.id)?.status).toBe('open');
    await c.commands.setTaskState(task.id, 'failed');
    expect(c.log.tables.questions.get(question.id)?.status).toBe('cancelled');
  });

  it('a refused task update in the switch path fails the task, once', async () => {
    const { c } = boot();
    const { task, question } = await limitedTask(c, TEXT_ON_GEMINI);
    c.commands.updateTask = () =>
      Promise.reject(new DomainError('invalid', 'the task cannot change provider now'));
    await c.commands.answerQuestion({
      questionId: question.id,
      answer: 'Switch to ChatGPT · GPT-5.6',
      by: USER,
    });
    await c.usageLimits.settled();
    const failed = c.log.tables.tasks.get(task.id)!;
    expect(failed.state).toBe('failed');
    expect(failed.meta?.['limitRestartFailed']).toBe(
      'could not restart after the usage limit: the task cannot change provider now',
    );
    expect(c.log.tables.questions.get(question.id)?.meta?.['switchedAt']).toBeDefined();
    await c.usageLimits.tick();
    expect(stewardsOf(c, task.id)).toHaveLength(1);
  });

  it('a free-text answer is refused with the choices; the question stays open', async () => {
    const { c } = boot();
    const { question } = await limitedTask(c, TEXT_ON_GEMINI);
    await expect(
      c.commands.answerQuestion({
        questionId: question.id,
        answer: 'use the cheaper one',
        by: USER,
      }),
    ).rejects.toThrow(
      `Answer with one of: ${question.context.options!.join(', ')} — not "use the cheaper one"`,
    );
    expect(question.context.options).toContain(LIMIT_WAIT);
    expect(c.log.tables.questions.get(question.id)?.status).toBe('open');
  });

  it('a waiting limit is retried after the reset by a fresh composition over the same database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'galactic-limits-restart-'));
    try {
      const file = join(dir, 'galactic.db');
      const clock = tickingClock(START);
      const first = boot({ file, clock });
      const { task, steward, question } = await limitedTask(first.c, TEXT_ON_GEMINI);
      await first.c.commands.answerQuestion({
        questionId: question.id,
        answer: LIMIT_WAIT,
        by: USER,
      });
      await first.c.shutdown();
      lives.splice(lives.indexOf(first.c), 1);
      await first.c.dispose().catch(() => {});

      // A new server on the same file, the reset passed while it was down.
      clock.advance(Date.parse(RESETS) - START + 60_000);
      const second = boot({ file, clock });
      expect(second.c.log.tables.questions.get(question.id)?.meta).toMatchObject({
        retryAt: RESETS,
      });
      await second.c.recover();
      second.c.usageLimits.start();
      await second.c.usageLimits.settled();
      await until(
        () => spawnsOf(second.c, steward.id) === 2 || stewardsOf(second.c, task.id).length === 2,
        'the retried Steward',
      );
      await second.c.usageLimits.tick();
      await second.c.usageLimits.settled();
      expect(second.c.log.tables.questions.get(question.id)?.meta?.['retriedAt']).toBeDefined();
      expect(spawnsOf(second.c, steward.id) + stewardsOf(second.c, task.id).length).toBe(3);
    } finally {
      for (const c of lives.splice(0)) await c.dispose().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
