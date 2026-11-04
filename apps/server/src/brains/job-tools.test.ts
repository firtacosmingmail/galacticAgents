import { afterEach, describe, expect, it } from 'vitest';
import {
  FINDING_ACTIONS,
  PUBLISH_ACTIONS,
  SPEND_ACTIONS,
  isJobOwned,
  type Actor,
  type Event,
  type JobDraft,
  type SpawnOptions,
  type ToolDefinition,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { createTask } from '../domain/tasks.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { tickingClock } from '../test/world.js';
import { JOB_TOOL_NAMES, SpendRelay, stewardJobTools } from './job-tools.js';
import { publishEtiquette, spendEtiquette, stewardEtiquette } from './steward-prompt.js';

/**
 * P10-05 (plan Task 9) — the Steward's job and spend tools with the fake runtime (which serves the
 * server's tools like `claude-sdk`): a task Steward gets `request_spend` only, a job-run Steward
 * also `report_finding` and `report_run`; a finding is a job-owned question held by the user; the
 * 21st finding of a run is refused; `report_run('failed')` makes the scheduler fail the run and
 * pause the job; a task Steward hears its spend answer as one message, a job spend's answer
 * reaches no agent.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 60 * 60_000, maxToolCalls: 100 };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and summarise them.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};
const ECHO: FakeScenario = { steps: [{ kind: 'output', text: 'Nothing new today.' }] };
/** Holds the run's turn on a clarification, so its tools can be called while it runs. */
const ASKS: FakeScenario = {
  steps: [
    { kind: 'ask', text: 'Which reviews count?' },
    { kind: 'output', text: 'Two reviews.' },
  ],
};

const oct = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function boot(
  scenario: (spawn: SpawnOptions) => FakeScenario = () => ECHO,
  providers: FakeAdapter[] = [],
) {
  const clock = tickingClock(oct(1, 8).getTime());
  const spawns: SpawnOptions[] = [];
  const errors: string[] = [];
  const adapter = new FakeAdapter({
    speed: 0,
    scenarioFor: (spawn) => ({ name: 'job', scenario: scenario(spawn) }),
  });
  const spawn = adapter.spawn.bind(adapter);
  adapter.spawn = (opts) => {
    spawns.push(opts);
    return spawn(opts);
  };
  for (const p of providers) {
    const spawnP = p.spawn.bind(p);
    p.spawn = (opts) => {
      spawns.push(opts);
      return spawnP(opts);
    };
  }
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter, ...providers],
    log: { now: clock },
    flushMs: 10,
    stewardRuntimeOverride: () => 'fake',
    onError: (e, ctx) => errors.push(`${ctx}: ${(e as Error).message}`),
  });
  lives.push(c);
  const setTo = (at: Date) => clock.advance(at.getTime() - Date.parse(clock()) - 1000);
  return { c, spawns, errors, setTo };
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const events = (c: ComposedRuntime): Event[] =>
  c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
const messages = (c: ComposedRuntime) =>
  events(c).filter((e): e is Extract<Event, { type: 'message.sent' }> => e.type === 'message.sent');
const names = (tools: readonly ToolDefinition[] | undefined) => (tools ?? []).map((t) => t.name);
const tool = (tools: readonly ToolDefinition[] | undefined, name: string): ToolDefinition => {
  const found = tools?.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

/** A long-term project, its Waykeeper row (not running) and one job, then the job's first run. */
async function jobRun(b: ReturnType<typeof boot>) {
  const { c } = b;
  const project = (
    await c.commands.createProject({
      name: 'Shop',
      workspace: '/w/shop',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    })
  ).value;
  c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  );
  const { job } = (
    await c.commands.createJob({
      projectId: project.id,
      area: { name: 'Feedback' },
      draft: DRAFT,
      by: USER,
    })
  ).value;
  b.setTo(oct(1, 9));
  await c.jobs.tick();
  const run = c.log.tables.jobRuns.get(c.log.tables.jobs.get(job.id)!.runningRunId!)!;
  const spawn = b.spawns.find((s) => s.agentId === run.agentId)!;
  return { project, job, run, stewardId: run.agentId!, tools: spawn.tools };
}

const tools = (b: ReturnType<typeof boot>, id: string, taskId: string) =>
  stewardJobTools(b.c.commands, b.c.log.tables, { id, taskId });

/** A project task's Steward, spawned on the fake runtime. */
async function taskSteward(b: ReturnType<typeof boot>, opts: { publishes?: boolean } = {}) {
  const { c } = b;
  const project = (await c.commands.createProject({ name: 'App', workspace: '/w/app' })).value;
  const wk = c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  ).value;
  const task = c.log.runCommand((ctx) =>
    createTask(ctx, {
      projectId: project.id,
      description: 'Launch the ad',
      ...(opts.publishes ? { publishes: true } : {}),
    }),
  ).value;
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      taskId: task.id,
      projectId: project.id,
      supervisorId: wk.id,
      prompt: 'Launch the ad.',
    })
  ).value;
  const spawn = b.spawns.find((s) => s.agentId === steward.id)!;
  return { project, task, steward, tools: spawn.tools };
}

describe('Steward job and spend tools (P10-05)', () => {
  it('a task Steward gets request_spend and request_publish, beside its deliverable tools', async () => {
    const b = boot();
    const { steward, tools } = await taskSteward(b);
    expect(names(tools)).toEqual(['request_spend', 'request_publish']);
    expect(names(stewardJobTools(b.c.commands, b.c.log.tables, steward))).toEqual([
      'request_spend',
      'request_publish',
    ]);
  });

  it('a job-run Steward gets request_spend, request_publish, report_finding and report_run', async () => {
    const b = boot(() => ASKS);
    const { tools } = await jobRun(b);
    expect(names(tools)).toEqual(['request_spend', 'request_publish', ...JOB_TOOL_NAMES]);
  });

  it('request_spend in a follow-up spend run: the approved spend is not asked again (final review I4)', async () => {
    const b = boot(() => ASKS);
    const { run, stewardId, job } = await jobRun(b);
    const { tables } = b.c.log;
    const plain = tool(tools(b, stewardId, job.taskId), 'request_spend').description;
    expect(plain).toContain('this run does not spend');
    tables.jobRuns.upsert({
      ...run,
      purpose: 'follow_up',
      followUp: {
        questionId: 'q-1',
        kind: 'spend',
        amount: 20,
        currency: 'USD',
        purpose: 'the ad',
      },
    });
    const desc = tool(tools(b, stewardId, job.taskId), 'request_spend').description;
    expect(desc).toContain(
      'The spend this run was started for is already approved: never ask for it again. Use this only for any other spend, which a later run carries out once approved.',
    );
    expect(desc).not.toContain('this run does not spend');
  });

  it('report_finding opens a user-held, job-owned question with the fixed actions', async () => {
    const b = boot(() => ASKS);
    const { job, run, stewardId, tools } = await jobRun(b);
    const out = (await tool(tools, 'report_finding').handler({
      kind: 'suggestion',
      title: 'Add refunds to the FAQ',
      text: 'Three customers asked about refunds.',
    })) as { questionId: string };
    const q = b.c.log.tables.questions.get(out.questionId)!;
    expect(q).toMatchObject({
      kind: 'clarification',
      status: 'open',
      originAgentId: stewardId,
      holder: USER,
    });
    expect(isJobOwned(q)).toBe(true);
    expect(q.context.options).toEqual([...FINDING_ACTIONS.suggestion]);
    expect(q.context.finding).toMatchObject({
      jobId: job.id,
      runId: run.id,
      kind: 'suggestion',
      title: 'Add refunds to the FAQ',
    });
    // A refusal is the tool's result, never a crash.
    expect(
      await tool(tools, 'report_finding').handler({ kind: 'idea', title: 'x', text: 'y' }),
    ).toMatchObject({ error: 'invalid' });
  });

  it('report_finding no longer offers a reply: a reply is a publish approval (P11-06)', async () => {
    const b = boot(() => ASKS);
    const { job, run, stewardId, tools } = await jobRun(b);
    const finding = tool(tools, 'report_finding');
    expect(
      (finding.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind.enum,
    ).toEqual(['suggestion']);
    const refused = await finding.handler({
      kind: 'reply',
      title: 'Answer the refund review',
      text: 'A customer asks about refunds.',
      draft: 'Hi! Refunds take three days.',
    });
    expect(refused).toMatchObject({ error: 'invalid' });
    expect((refused as { message: string }).message).toContain('request_publish');
    const out = (await tool(tools, 'request_publish').handler({
      platform: 'App Store',
      account: 'My Shop',
      text: 'Hi! Refunds take three days.',
    })) as { questionId: string; note: string };
    expect(out.note).toMatch(/^Asked Cosmin\. End your turn now; a later run publishes it/);
    const q = b.c.log.tables.questions.get(out.questionId)!;
    expect(q).toMatchObject({ kind: 'publish', holder: USER, originAgentId: stewardId });
    expect(q.context.publish).toMatchObject({ jobId: job.id, runId: run.id });
    expect(q.context.options).toEqual([...PUBLISH_ACTIONS]);
  });

  it('refuses the 21st finding of a run', async () => {
    const b = boot(() => ASKS);
    const { tools } = await jobRun(b);
    const report = tool(tools, 'report_finding');
    for (let i = 1; i <= 20; i++) {
      const out = await report.handler({ kind: 'suggestion', title: `Idea ${i}`, text: 'Do it.' });
      expect(out).toHaveProperty('questionId');
    }
    const refused = await report.handler({ kind: 'suggestion', title: 'Idea 21', text: 'More.' });
    expect(refused).toMatchObject({ error: 'invalid' });
    expect((refused as { message: string }).message).toContain('at most 20 findings');
  });

  it('report_run validates and keeps the report on the run; outcome findings needs a finding', async () => {
    const b = boot(() => ASKS);
    const { run, tools } = await jobRun(b);
    const report = tool(tools, 'report_run');
    expect(await report.handler({ outcome: 'findings', summary: 'Two ideas.' })).toMatchObject({
      error: 'invalid',
    });
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`n${i}`, i]));
    expect(await report.handler({ outcome: 'quiet', summary: 's', numbers: many })).toMatchObject({
      error: 'invalid',
    });
    expect(
      await report.handler({ outcome: 'quiet', summary: 's', numbers: { ['k'.repeat(61)]: 1 } }),
    ).toMatchObject({ error: 'invalid' });
    expect(
      await report.handler({ outcome: 'quiet', summary: 's', numbers: { '': 1 } }),
    ).toMatchObject({ error: 'invalid' });
    expect(await report.handler({ outcome: 'quiet', summary: '  ' })).toMatchObject({
      error: 'invalid',
    });
    expect(
      await report.handler({ outcome: 'quiet', summary: 's', failureReason: 'no' }),
    ).toMatchObject({ error: 'invalid' });
    expect(b.c.log.tables.jobRuns.get(run.id)?.meta?.['report']).toBeUndefined();

    await tool(tools, 'report_finding').handler({ kind: 'suggestion', title: 'Idea', text: 'x' });
    const ok = await report.handler({
      outcome: 'findings',
      summary: 'One idea.',
      numbers: { 'new reviews': 4 },
    });
    expect(ok).toMatchObject({ runId: run.id, outcome: 'findings' });
    expect(b.c.log.tables.jobRuns.get(run.id)?.meta?.['report']).toEqual({
      outcome: 'findings',
      summary: 'One idea.',
      numbers: { 'new reviews': 4 },
    });
  });

  it("report_run('failed') makes the turn-end handler record the failure and pause the job", async () => {
    const b = boot(() => ({
      steps: [
        {
          kind: 'tool_call',
          toolName: 'report_run',
          input: { outcome: 'failed', summary: 'Could not read.', failureReason: 'no network' },
        },
        { kind: 'output', text: 'Stopping.' },
      ],
    }));
    const { job, run } = await jobRun(b);
    await until(() => b.c.log.tables.jobRuns.get(run.id)?.outcome !== 'running', 'the run end');
    expect(b.c.log.tables.jobRuns.get(run.id)).toMatchObject({
      outcome: 'failed',
      summary: 'Could not read.',
    });
    const after = b.c.log.tables.jobs.get(job.id)!;
    expect(after).toMatchObject({ state: 'paused', pausedReason: 'no network' });
    const failure = b.c.log.tables.questions.get(after.failureQuestionId!)!;
    expect(failure.context.jobFailure).toMatchObject({ runId: run.id, reason: 'no network' });
    expect(b.errors).toEqual([]);
  });

  it('a task Steward’s spend answer reaches it as one system message', async () => {
    const b = boot();
    const { steward, tools } = await taskSteward(b);
    await until(() => b.c.statuses.get(steward.id)?.state === 'idle', 'the Steward to idle');
    const out = (await tool(tools, 'request_spend').handler({
      amount: 20,
      purpose: 'One week of ads',
    })) as { questionId: string; note: string };
    expect(out.note).toMatch(/^Asked Cosmin\. End your turn now; /);
    const q = b.c.log.tables.questions.get(out.questionId)!;
    expect(q).toMatchObject({ kind: 'spend', holder: USER });
    expect(q.context.options).toEqual([...SPEND_ACTIONS]);

    const before = messages(b.c).length;
    await b.c.commands.answerQuestion({ questionId: q.id, answer: 'Approve', by: USER });
    const sent = messages(b.c).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      agentId: steward.id,
      sender: { type: 'system' },
      text: 'Spend approval for $20.00 (One week of ads): approved',
    });

    const second = (await tool(tools, 'request_spend').handler({
      amount: 5,
      currency: 'EUR',
      purpose: 'A stock photo',
    })) as { questionId: string };
    const mark = messages(b.c).length;
    await b.c.commands.answerQuestion({
      questionId: second.questionId,
      answer: 'Refuse',
      by: USER,
    });
    expect(
      messages(b.c)
        .slice(mark)
        .map((m) => m.text),
    ).toEqual(['Spend approval for €5.00 (A stock photo): refused']);
    expect(b.errors).toEqual([]);
  });

  it('a Steward that has ended is skipped silently (its stop also withdraws the question)', async () => {
    const b = boot();
    const { steward, tools } = await taskSteward(b);
    const out = (await tool(tools, 'request_spend').handler({ amount: 1, purpose: 'x' })) as {
      questionId: string;
    };
    // A relay that sees no living Steward sends nothing and reports no error.
    const sends: string[] = [];
    const relayErrors: unknown[] = [];
    const relay = new SpendRelay({
      log: b.c.log,
      runtime: {
        liveAgents: () => [],
        send: (_id, text) => (sends.push(text), undefined as never),
      },
      onError: (e) => relayErrors.push(e),
    });
    relay.start();
    await b.c.commands.answerQuestion({ questionId: out.questionId, answer: 'Approve', by: USER });
    relay.stop();
    expect(sends).toEqual([]);
    expect(relayErrors).toEqual([]);

    const again = (await tool(tools, 'request_spend').handler({ amount: 2, purpose: 'y' })) as {
      questionId: string;
    };
    await b.c.runtime.stop(steward.id, USER);
    expect(b.c.log.tables.questions.get(again.questionId)?.status).toBe('cancelled');
    expect(b.errors).toEqual([]);
  });

  it('a job spend’s answer sends nothing to any agent', async () => {
    const b = boot(() => ASKS);
    const { job, tools } = await jobRun(b);
    const out = (await tool(tools, 'request_spend').handler({
      amount: 20,
      purpose: 'Boost the post',
    })) as { questionId: string };
    const q = b.c.log.tables.questions.get(out.questionId)!;
    expect(q.context.spend?.jobId).toBe(job.id);
    const mark = messages(b.c).length;
    await b.c.commands.answerQuestion({ questionId: q.id, answer: 'Approve', by: USER });
    expect(messages(b.c).slice(mark)).toEqual([]);
    expect(b.c.log.tables.jobs.get(job.id)?.followUps).toHaveLength(1);
  });
});

describe('publish approvals for a task Steward (P11-06)', () => {
  it('its publish answer reaches it as one system message, and an approval arms the allowance', async () => {
    const b = boot();
    const { steward, tools } = await taskSteward(b, { publishes: true });
    await until(() => b.c.statuses.get(steward.id)?.state === 'idle', 'the Steward to idle');
    const out = (await tool(tools, 'request_publish').handler({
      platform: 'Instagram',
      account: '@myshop',
      text: 'We launched!',
    })) as { questionId: string; note: string };
    expect(out.note).toMatch(/^Asked Cosmin\. End your turn now; his answer comes to you/);
    const before = messages(b.c).length;
    await b.c.commands.answerQuestion({ questionId: out.questionId, answer: 'Approve', by: USER });
    expect(
      messages(b.c)
        .slice(before)
        .map((m) => [m.agentId, m.sender, m.text]),
    ).toEqual([[steward.id, { type: 'system' }, 'Publish approval for Instagram: approved']]);
    expect(b.c.publishAllowances.isArmed(steward.id)).toBe(true);

    const second = (await tool(tools, 'request_publish').handler({
      platform: 'X',
      account: '@myshop',
      text: 'Draft',
    })) as { questionId: string };
    const mark = messages(b.c).length;
    await b.c.commands.answerQuestion({
      questionId: second.questionId,
      answer: 'Approve',
      by: USER,
      detail: { choices: ['Approve'], text: 'Final words' },
    });
    expect(
      messages(b.c)
        .slice(mark)
        .map((m) => m.text),
    ).toEqual(['Publish approval for X: approved. Publish exactly this text:\nFinal words']);

    const third = (await tool(tools, 'request_publish').handler({
      platform: 'X',
      account: '@myshop',
      text: 'Another',
    })) as { questionId: string };
    const last = messages(b.c).length;
    await b.c.commands.answerQuestion({ questionId: third.questionId, answer: 'Refuse', by: USER });
    expect(
      messages(b.c)
        .slice(last)
        .map((m) => m.text),
    ).toEqual(['Publish approval for X: refused']);
    // Its end disarms it.
    await b.c.runtime.stop(steward.id, USER);
    expect(b.c.publishAllowances.isArmed(steward.id)).toBe(false);
    expect(b.errors).toEqual([]);
  });

  it('request_publish served to Codex and agy sessions is bound to the calling Steward', async () => {
    const codex = new FakeAdapter({ speed: 0, runtime: 'codex', canPublish: true });
    const agy = new FakeAdapter({ speed: 0, runtime: 'agy', canPublish: false });
    const b = boot(() => ECHO, [codex, agy]);
    const { c } = b;
    const project = (await c.commands.createProject({ name: 'App', workspace: '/w/app' })).value;
    const wk = c.log.runCommand((ctx) =>
      createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
    ).value;
    const spawnOn = async (runtime: 'codex' | 'agy') => {
      // A publishing step never starts on Gemini (final review I3): the agy Steward's task is not one.
      const task = c.log.runCommand((ctx) =>
        createTask(ctx, {
          projectId: project.id,
          description: 'Post it',
          ...(runtime === 'codex' ? { publishes: true } : {}),
        }),
      ).value;
      const steward = (
        await c.commands.spawnAgent({
          role: 'steward',
          runtime,
          taskId: task.id,
          projectId: project.id,
          supervisorId: wk.id,
          prompt: 'Post it.',
        })
      ).value;
      return { steward, tools: b.spawns.find((o) => o.agentId === steward.id)!.tools };
    };
    const onCodex = await spawnOn('codex');
    const onAgy = await spawnOn('agy');
    // Each session gets its own tool set (the adapters serve `SpawnOptions.tools` per session).
    expect(names(onCodex.tools)).toContain('request_publish');
    expect(names(onAgy.tools)).toContain('request_publish');
    const out = (await tool(onCodex.tools, 'request_publish').handler({
      platform: 'X',
      account: '@app',
      text: 'Hello',
    })) as { questionId: string };
    expect(c.log.tables.questions.get(out.questionId)!.originAgentId).toBe(onCodex.steward.id);
    await until(() => c.statuses.get(onCodex.steward.id) !== undefined, 'the status');
    await c.commands.answerQuestion({ questionId: out.questionId, answer: 'Approve', by: USER });
    expect(c.publishAllowances.isArmed(onCodex.steward.id)).toBe(true);
    expect(c.publishAllowances.isArmed(onAgy.steward.id)).toBe(false);
    // The agy Steward's own tool asks as itself, and is refused (Gemini cannot publish).
    expect(
      await tool(onAgy.tools, 'request_publish').handler({
        platform: 'X',
        account: '@app',
        text: 'Hello',
      }),
    ).toMatchObject({ error: 'invalid', message: 'Gemini cannot publish' });
  });

  it('a task that is not a publishing step is refused, as the tool result', async () => {
    const b = boot();
    const { tools } = await taskSteward(b);
    expect(
      await tool(tools, 'request_publish').handler({ platform: 'X', account: '@a', text: 'Hi' }),
    ).toMatchObject({
      error: 'invalid',
      message: 'this task is not a publishing step; ask your Waykeeper',
    });
  });

  it('the Steward prompt names request_publish; one without server tools never publishes', () => {
    expect(stewardEtiquette({ supervisor: 'waykeeper' }).join('\n')).toContain('request_publish');
    const cannot = stewardEtiquette({ supervisor: 'harmonizer', declares: false }).join('\n');
    expect(cannot).not.toContain('request_publish');
    expect(publishEtiquette(false).join('\n')).toContain('never publish');
  });
});

describe('the Steward prompt on money (P10-05)', () => {
  it('every Steward asks with request_spend; one without server tools never spends', () => {
    const asks = stewardEtiquette({ supervisor: 'waykeeper' }).join('\n');
    expect(asks).toContain(
      'Before anything that spends real money, call `request_spend` and end your turn; never spend without an approval.',
    );
    const cannot = stewardEtiquette({ supervisor: 'harmonizer', declares: false }).join('\n');
    expect(cannot).not.toContain('request_spend');
    expect(cannot).toContain("never spend money; report 'Not done: needs approval to spend …'");
    expect(spendEtiquette(true)).not.toEqual(spendEtiquette(false));
  });
});
