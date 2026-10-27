import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessJobRunBody,
  type Actor,
  type JobDraft,
  type SpawnOptions,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { tickingClock } from '../test/world.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';
import { HarnessJobScripts, harnessJobs } from './harness-jobs.js';

/**
 * The scene harness's job hooks (P10-08, development only): a job's run starts now through the
 * real scheduler, its fake-runtime Steward following the script (findings, a spend, the report),
 * and the run ends as a scheduled one does; a script is used once, by that job's Steward only.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 60 * 60_000, maxToolCalls: 100 };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and draft replies.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function boot() {
  const scripts = new HarnessJobScripts();
  const adapter = new FakeAdapter({
    speed: 0,
    scenarioFor: (spawn: SpawnOptions) => scripts.scenarioFor(spawn),
  });
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    log: { now: tickingClock(new Date(2026, 9, 1, 8).getTime()) },
    flushMs: 10,
    jobs: { stewardRuntime: () => 'fake' },
  });
  lives.push(c);
  scripts.attach(c.log.tables);
  return { c, scripts, jobs: harnessJobs({ log: c.log, scheduler: c.jobs, scripts }) };
}

async function longTermJob(c: ComposedRuntime) {
  const p = (
    await c.commands.createProject({
      name: 'Shop',
      workspace: '/w/shop',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    })
  ).value;
  c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: p.id }),
  );
  const { job } = (
    await c.commands.createJob({
      projectId: p.id,
      area: { name: 'Feedback' },
      draft: DRAFT,
      by: USER,
    })
  ).value;
  return job;
}

async function until(check: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('harness jobs (P10-08)', () => {
  it('runs a job now: the Steward reports a reply, asks for a spend and ends the run with findings', async () => {
    const { c, jobs } = boot();
    const job = await longTermJob(c);
    const script = HarnessJobRunBody.parse({
      findings: [
        { kind: 'reply', title: 'Dark mode', text: 'A user asks for dark mode.', draft: 'Soon!' },
      ],
      spend: { amount: 20, currency: 'USD', purpose: 'Promote the post' },
      summary: 'Read 3 messages.',
    });
    const { runId } = await jobs.run(job.id, script);
    await until(() => c.log.tables.jobRuns.get(runId)?.outcome !== 'running', 'the run to end');

    expect(c.log.tables.jobRuns.get(runId)).toMatchObject({
      outcome: 'findings',
      summary: 'Read 3 messages.',
    });
    const questions = c.log.tables.questions.all();
    const finding = questions.find((q) => q.context.finding);
    expect(finding?.context.finding).toMatchObject({
      jobId: job.id,
      kind: 'reply',
      draft: 'Soon!',
    });
    expect(finding?.status).toBe('open');
    const spend = questions.find((q) => q.kind === 'spend');
    expect(spend?.context.spend).toMatchObject({ jobId: job.id, amount: 20 });
    expect(spend?.holder).toEqual({ type: 'user' });
    // The run took its occurrence: the next one is tomorrow's.
    expect(Date.parse(c.log.tables.jobs.get(job.id)!.nextRunAt!)).toBeGreaterThan(
      Date.parse(c.log.tables.jobRuns.get(runId)!.startedAt),
    );
  });

  it('uses a script once: the next run echoes and ends quiet', async () => {
    const { c, jobs } = boot();
    const job = await longTermJob(c);
    const first = await jobs.run(job.id, HarnessJobRunBody.parse({ summary: 'Scripted.' }));
    await until(() => c.log.tables.jobRuns.get(first.runId)?.outcome !== 'running', 'run 1');
    expect(c.log.tables.jobRuns.get(first.runId)).toMatchObject({
      outcome: 'quiet',
      summary: 'Scripted.',
    });
    const second = await jobs.run(job.id, HarnessJobRunBody.parse({}));
    expect(second.runId).not.toBe(first.runId);
    await until(() => c.log.tables.jobRuns.get(second.runId)?.outcome !== 'running', 'run 2');
    expect(c.log.tables.jobRuns.get(second.runId)?.outcome).toBe('quiet');
  });

  it('refuses a job that does not run, and a job with a run going on', async () => {
    const { c, jobs, scripts } = boot();
    const job = await longTermJob(c);
    await jobs.run(job.id, HarnessJobRunBody.parse({}));
    await expect(jobs.run(job.id, HarnessJobRunBody.parse({}))).rejects.toMatchObject({
      code: 'conflict',
    });
    await c.commands.setJobState({ jobId: job.id, state: 'paused', by: USER });
    await expect(jobs.run(job.id, HarnessJobRunBody.parse({}))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(jobs.run('j-nobody', HarnessJobRunBody.parse({}))).rejects.toMatchObject({
      code: 'not_found',
    });
    // No script waits for a spawn that never came.
    expect(scripts.scenarioFor({ agentId: 'a-x', role: 'steward' } as SpawnOptions)).toBe(
      undefined,
    );
  });

  it('gives a script only to a Steward of that job’s task; a tick reports what it did', async () => {
    const { c, jobs, scripts } = boot();
    const job = await longTermJob(c);
    scripts.set(job.taskId, { steps: [] });
    const wk = c.log.tables.agents.all().find((a) => a.role === 'waykeeper')!;
    expect(scripts.scenarioFor({ agentId: wk.id, role: 'waykeeper' } as SpawnOptions)).toBe(
      undefined,
    );
    scripts.delete(job.taskId);
    const tick = await jobs.tick();
    expect(tick).toMatchObject({ started: [], waited: [], interrupted: [], ended: [] });
    expect(tick.seq).toBe(c.log.currentSeq());
  });
});
