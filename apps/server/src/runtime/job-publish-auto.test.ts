import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLISH_ACTIONS,
  type Actor,
  type Event,
  type EventOfType,
  type JobDraft,
  type SpawnOptions,
  type ToolDefinition,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { setWaykeeperApprovals } from '../domain/waykeeper-approvals.js';
import { tickingClock } from '../test/world.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P13-32 (SPEC decision 165): a job approved on its card to publish publishes in Auto without a
 * publish card each time. Its run's `request_publish` opens the job's publish question and the
 * Waykeeper answers it Approve at once (the user's Approve path: a `publish` follow-up is queued
 * on the job), logged as `permission.decided{allow}` with the decision-165 reason. A job without
 * `publishes`, Auto off, or a stopped job: today's card (or refusal).
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 60 * 60_000, maxToolCalls: 100 };
const DRAFT: JobDraft = {
  name: 'Post the daily tip',
  instructions: 'Write one tip about the app and post it.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};
const TEXT = 'Tip of the day: swipe left to archive.';
const REASON = 'allowed: the job was approved to publish (decision 165)';
/** Holds the run's turn on a clarification, so its tools can be called while it runs. */
const ASKS: FakeScenario = {
  steps: [
    { kind: 'ask', text: 'Which tip?' },
    { kind: 'output', text: 'Posted.' },
  ],
};

const oct = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

/** A long-term project (Auto or not), its Waykeeper row, one job and the job's first run. */
async function jobRun(opts: { auto: boolean; publishes: boolean }) {
  const clock = tickingClock(oct(1, 8).getTime());
  const spawns: SpawnOptions[] = [];
  const adapter = new FakeAdapter({
    speed: 0,
    scenarioFor: () => ({ name: 'job', scenario: ASKS }),
  });
  const spawn = adapter.spawn.bind(adapter);
  adapter.spawn = (o) => {
    spawns.push(o);
    return spawn(o);
  };
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    log: { now: clock },
    flushMs: 10,
    stewardRuntimeOverride: () => 'fake',
  });
  lives.push(c);
  const project = (
    await c.commands.createProject({
      name: 'Shop',
      workspace: '/w/shop',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    })
  ).value;
  c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER, opts.auto));
  const waykeeper = c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  ).value;
  const { job } = (
    await c.commands.createJob({
      projectId: project.id,
      area: { name: 'Social' },
      draft: { ...DRAFT, ...(opts.publishes ? { publishes: true } : {}) },
      by: USER,
    })
  ).value;
  clock.advance(oct(1, 9).getTime() - Date.parse(clock()) - 1000);
  await c.jobs.tick();
  const run = c.log.tables.jobRuns.get(c.log.tables.jobs.get(job.id)!.runningRunId!)!;
  const tools = spawns.find((s) => s.agentId === run.agentId)!.tools;
  const publishTool = tools?.find((t: ToolDefinition) => t.name === 'request_publish');
  if (!publishTool) throw new Error('no request_publish tool');
  const publish = () =>
    publishTool.handler({ platform: 'Instagram', account: '@shop', text: TEXT }) as Promise<
      Record<string, unknown>
    >;
  const events = (): Event[] => c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const decisions = () =>
    events().filter(
      (e): e is EventOfType<'permission.decided'> =>
        e.type === 'permission.decided' && e.agentId === run.agentId,
    );
  return { c, project, waykeeper, job, run, stewardId: run.agentId!, publish, decisions };
}

describe('a job approved to publish, in Auto (P13-32, decision 165)', () => {
  it('its run’s publish opens no card: the Waykeeper approves it, a follow-up is queued, it is logged', async () => {
    const h = await jobRun({ auto: true, publishes: true });
    const out = await h.publish();
    expect(out).toMatchObject({ status: 'approved' });
    expect(out['note']).toMatch(/approved this job to publish/);
    expect(out['note']).toMatch(/a later run publishes it/i);
    const [q] = h.c.log.tables.questions.all().filter((x) => x.kind === 'publish');
    expect(q).toMatchObject({
      status: 'answered',
      answer: PUBLISH_ACTIONS[0],
      answeredBy: { type: 'agent', id: h.waykeeper.id },
      originAgentId: h.stewardId,
    });
    expect(q!.context.publish).toMatchObject({ jobId: h.job.id, runId: h.run.id, text: TEXT });
    expect(h.c.log.tables.jobs.get(h.job.id)?.followUps).toEqual([
      { questionId: q!.id, kind: 'publish', publish: q!.context.publish },
    ]);
    expect(h.decisions()).toEqual([
      expect.objectContaining({
        decision: 'allow',
        questionId: q!.id,
        decidedBy: { type: 'agent', id: h.waykeeper.id },
        waykeeperApproval: true,
        allowedBy: 'auto',
        reason: REASON,
        toolCall: {
          toolName: 'request_publish',
          input: { platform: 'Instagram', account: '@shop', text: TEXT, files: [] },
        },
      }),
    ]);
    // The run itself publishes nothing: no allowance for it.
    expect(h.c.publishAllowances.isArmed(h.stewardId)).toBe(false);
  });

  it('Auto off: the publish card opens as today', async () => {
    const h = await jobRun({ auto: false, publishes: true });
    const out = await h.publish();
    const q = h.c.log.tables.questions.get(out['questionId'] as string);
    expect(q).toMatchObject({ kind: 'publish', status: 'open', holder: USER });
    expect(q?.answer).toBeUndefined();
    expect(h.c.log.tables.jobs.get(h.job.id)?.followUps).toEqual([]);
    expect(h.decisions()).toEqual([]);
  });

  it('in Auto, a job without publishes: the publish card opens as today', async () => {
    const h = await jobRun({ auto: true, publishes: false });
    const out = await h.publish();
    const q = h.c.log.tables.questions.get(out['questionId'] as string);
    expect(q).toMatchObject({ kind: 'publish', status: 'open', holder: USER });
    expect(h.c.log.tables.jobs.get(h.job.id)?.followUps).toEqual([]);
    expect(h.decisions()).toEqual([]);
  });

  it('in Auto, a stopped job with publishes: nothing is approved (the stopped-job refusal)', async () => {
    const h = await jobRun({ auto: true, publishes: true });
    const { tables } = h.c.log;
    tables.jobs.upsert({ ...tables.jobs.get(h.job.id)!, state: 'stopped' });
    const out = await h.publish();
    expect(out).toMatchObject({ error: 'invalid' });
    expect(String(out['message'])).toMatch(/stopped/);
    expect(tables.questions.all().filter((x) => x.kind === 'publish')).toEqual([]);
    expect(tables.jobs.get(h.job.id)?.followUps).toEqual([]);
    expect(h.decisions()).toEqual([]);
  });
});
