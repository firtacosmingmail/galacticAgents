import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  LIMIT_WAIT,
  PERMISSION_POLICY_PRESETS,
  type Actor,
  type Event,
  type Id,
  type JobDraft,
  type SpawnOptions,
} from '@galactic/protocol';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { brainDefinition, brainHarness, type BrainHarness } from '../brains/testing/index.js';
import { openDatabase, type Database } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { jobOf, writeJob } from '../domain/jobs.js';
import { addPermissionRule } from '../domain/project-rules.js';
import { tickingClock } from '../test/world.js';
import type { Timers } from './archival.js';
import type { CapsConfig } from './caps.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P10-04 (plan Task 8) — the job scheduler with the fake adapter and a fake clock: runs start on
 * time, a sleeping Mac catches up with exactly one run, a restart mid-run records the run
 * interrupted (its Steward not resumed) and catches up, one run per job at a time, a retry never
 * races a tick into two runs, the concurrency cap makes a run wait (never fail), and a run's end
 * is recorded without waking the Waykeeper. Schedules are in the Mac's local time, so every
 * instant here is built with local `Date` constructors.
 */

const USER: Actor = { type: 'user' };
const SYSTEM: Actor = { type: 'system' };
const CAPS = { maxWallClockMs: 60 * 60_000, maxToolCalls: 100 };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and summarise them.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};
const ECHO: FakeScenario = { steps: [{ kind: 'output', text: 'Nothing new today.' }] };
/** A run that waits on a clarification until it is answered (a stop ends it at once). */
const ASKS: FakeScenario = {
  steps: [
    { kind: 'ask', text: 'Which reviews count?' },
    { kind: 'output', text: 'Two reviews.' },
  ],
};

/** October 2026, local time. */
const oct = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);

type Clock = ReturnType<typeof tickingClock>;
/** The clock's next reading is `at`. */
function setTo(clock: Clock, at: Date): void {
  const current = Date.parse(clock());
  clock.advance(at.getTime() - current - 1000);
}

function fakeTimers() {
  const ticks: (() => void)[] = [];
  let cleared = 0;
  const timers: Timers = {
    setInterval: (fn, ms) => {
      ticks.push(fn);
      return ms;
    },
    clearInterval: () => void cleared++,
  };
  return { timers, count: () => ticks.length, cleared: () => cleared };
}

const lives: ComposedRuntime[] = [];
const harnesses: BrainHarness[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const h of harnesses.splice(0)) await h.dispose().catch(() => {});
});

interface BootOptions {
  db?: Database;
  clock?: Clock;
  caps?: CapsConfig;
  sessions?: Map<string, number>;
  /** The scenario of each spawn (default: one line of output, then the turn ends). */
  scenario?: (spawn: SpawnOptions) => FakeScenario;
  timers?: Timers;
  intervalMs?: number;
  /** Fake adapters registered as the providers' runtimes (no Steward runtime override then). */
  providers?: FakeAdapter[];
  /** The fake runtime may carry a publish (P11-06). */
  canPublish?: boolean;
}

function boot(o: BootOptions = {}) {
  const db = o.db ?? openDatabase(':memory:');
  const clock = o.clock ?? tickingClock(oct(1, 8).getTime());
  const errors: string[] = [];
  const adapter = new FakeAdapter({
    speed: 0,
    ...(o.canPublish ? { canPublish: true } : {}),
    ...(o.sessions ? { sessionStore: o.sessions } : {}),
    scenarioFor: (spawn) => ({ name: 'job', scenario: o.scenario?.(spawn) ?? ECHO }),
  });
  const c = composeRuntime(db, {
    adapters: [adapter, ...(o.providers ?? [])],
    log: { now: clock },
    flushMs: 10,
    ...(o.caps ? { caps: o.caps } : {}),
    ...(o.providers ? {} : { stewardRuntimeOverride: () => 'fake' as const }),
    jobs: {
      ...(o.timers ? { timers: o.timers } : {}),
      ...(o.intervalMs ? { intervalMs: o.intervalMs } : {}),
    },
    onError: (e, ctx) => errors.push(`${ctx}: ${(e as Error).message}`),
  });
  lives.push(c);
  return { c, db, clock, errors };
}

/** A long-term project with a Waykeeper row (not running) and one job. */
async function longTermJob(
  c: ComposedRuntime,
  draft: Partial<JobDraft> = {},
  project: { permissionPolicy?: typeof DEFAULT_PERMISSION_POLICY } = {},
) {
  const p = (
    await c.commands.createProject(
      {
        name: 'Shop',
        workspace: '/w/shop',
        longTerm: { purpose: 'Run the shop', goals: ['grow'] },
        ...project,
      },
      // A policy set here is the user's own, on this machine (not floored at the default).
      { origin: 'local' },
    )
  ).value;
  const wk = c.log.runCommand((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: p.id }),
  ).value;
  const { job } = (
    await c.commands.createJob({
      projectId: p.id,
      area: { name: 'Feedback' },
      draft: { ...DRAFT, ...draft },
      by: USER,
    })
  ).value;
  return { project: p, wk, job };
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
const runsOf = (c: ComposedRuntime, jobId: Id) =>
  c.log.tables.jobRuns
    .all()
    .filter((r) => r.jobId === jobId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
const stewardsOf = (c: ComposedRuntime, taskId: Id) =>
  c.log.tables.agents.all().filter((a) => a.role === 'steward' && a.taskId === taskId);
const jobNow = (c: ComposedRuntime, jobId: Id) => c.log.tables.jobs.get(jobId)!;
const ended = (c: ComposedRuntime, jobId: Id) => () => {
  const job = jobNow(c, jobId);
  return job.runningRunId === undefined && job.lastRun !== undefined;
};

describe('job scheduler (P10-04)', () => {
  it('starts a daily 09:00 job at 09:00, not a minute before: a Steward on its task, in the workspace', async () => {
    const { c, clock } = boot();
    const { job, wk } = await longTermJob(c);
    setTo(clock, oct(1, 8, 59));
    expect(await c.jobs.tick()).toEqual({ started: [], waited: [], interrupted: [], ended: [] });
    expect(runsOf(c, job.id)).toEqual([]);

    setTo(clock, oct(1, 9));
    const report = await c.jobs.tick();
    const [run] = runsOf(c, job.id);
    expect(report.started).toEqual([run!.id]);
    expect(run).toMatchObject({ purpose: 'scheduled', dueAt: oct(1, 9).toISOString() });
    const [steward] = stewardsOf(c, job.taskId);
    expect(steward).toMatchObject({ supervisorId: wk.id, runtime: 'fake' });
    expect(steward!.meta).toMatchObject({ cwd: '/w/shop' });
    expect(c.log.tables.tasks.get(job.taskId)?.worktreePath).toBeUndefined();
    expect(c.log.tables.jobRuns.get(run!.id)?.agentId).toBe(steward!.id);
    const prompt = (steward!.meta as { prompt: string }).prompt;
    expect(prompt).toContain('Read new app reviews and summarise them.');
    expect(prompt).toContain('Run the shop');
    expect(prompt).toContain('report_run');
    expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());
  });

  it('a Mac asleep through three occurrences runs once, as a catch-up, and is next due tomorrow', async () => {
    const { c, clock } = boot({ clock: tickingClock(oct(20, 8).getTime()) });
    const { job } = await longTermJob(c);
    setTo(clock, oct(20, 9));
    await c.jobs.tick();
    await until(ended(c, job.id), 'the first run to end');
    const [first] = runsOf(c, job.id);

    setTo(clock, oct(23, 12));
    const report = await c.jobs.tick();
    expect(report.started).toHaveLength(1);
    const runs = runsOf(c, job.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({
      purpose: 'catch_up',
      dueAt: oct(21, 9).toISOString(),
      coversFrom: first!.startedAt,
    });
    expect(jobNow(c, job.id).nextRunAt).toBe(oct(24, 9).toISOString());
    const prompt = (stewardsOf(c, job.taskId)[1]!.meta as { prompt: string }).prompt;
    expect(prompt).toContain(`This run covers ${first!.startedAt} to now.`);
    await until(ended(c, job.id), 'the catch-up to end');
    expect((await c.jobs.tick()).started).toEqual([]);
  });

  it('a restart mid-run: the Steward is stopped, not resumed; the run is interrupted and caught up once', async () => {
    const db = openDatabase(':memory:');
    const sessions = new Map<string, number>();
    const clock = tickingClock(oct(1, 8).getTime());
    const first = boot({ db, clock, sessions, scenario: () => ASKS });
    const { job } = await longTermJob(first.c);
    setTo(clock, oct(1, 9));
    await first.c.jobs.tick();
    const [run] = runsOf(first.c, job.id);
    const stewardId = run!.agentId!;
    await until(
      () => first.c.statuses.get(stewardId)?.state === 'waiting_for_input',
      'the question',
    );
    // The server dies (kill -9): no shutdown, the log still says the Steward works.
    lives.splice(lives.indexOf(first.c), 1);

    clock.advance(3 * 60 * 60_000);
    const second = boot({ db, clock, sessions });
    const recovery = await second.c.recover();
    expect(recovery.resumed).not.toContain(stewardId);
    expect(recovery.needAttention).not.toContain(stewardId);
    const ends = events(second.c).filter(
      (e) => e.type.startsWith('agent.') && 'agentId' in e && e.agentId === stewardId,
    );
    expect(ends.at(-1)).toEqual({ type: 'agent.stopped', agentId: stewardId, by: SYSTEM });

    const report = await second.c.jobs.tick();
    expect(report.interrupted).toEqual([run!.id]);
    expect(report.started).toHaveLength(1);
    const runs = runsOf(second.c, job.id);
    expect(runs.map((r) => r.outcome)).toEqual(['interrupted', 'running']);
    expect(runs[1]).toMatchObject({
      purpose: 'catch_up',
      dueAt: oct(1, 9).toISOString(),
      // The cut-short run was missed, not run: the catch-up covers what it was to cover.
      coversFrom: run!.coversFrom,
    });
    expect(stewardsOf(second.c, job.taskId)).toHaveLength(2);
    lives.push(first.c);
  });

  it('a graceful shutdown stops a run Steward instead of interrupting it', async () => {
    const db = openDatabase(':memory:');
    const clock = tickingClock(oct(1, 8).getTime());
    const first = boot({ db, clock, scenario: () => ASKS });
    const { job } = await longTermJob(first.c);
    setTo(clock, oct(1, 9));
    await first.c.jobs.tick();
    const stewardId = runsOf(first.c, job.id)[0]!.agentId!;
    await until(
      () => first.c.statuses.get(stewardId)?.state === 'waiting_for_input',
      'the question',
    );
    await first.c.shutdown();
    lives.splice(lives.indexOf(first.c), 1);
    expect(events(first.c)).toContainEqual({
      type: 'agent.stopped',
      agentId: stewardId,
      by: SYSTEM,
    });

    const second = boot({ db, clock });
    const recovery = await second.c.recover();
    expect([...recovery.resumed, ...recovery.needAttention]).not.toContain(stewardId);
    expect(second.c.statuses.get(stewardId)?.state).toBe('stopped');
    expect((await second.c.jobs.tick()).interrupted).toHaveLength(1);
  });

  it('a run the user stops ends without becoming due again: the schedule stays (ruling R9)', async () => {
    const { c, clock } = boot({ scenario: () => ASKS });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const stewardId = runsOf(c, job.id)[0]!.agentId!;
    await until(() => c.statuses.get(stewardId)?.state === 'waiting_for_input', 'the question');
    await c.commands.stopAgent(stewardId, USER);
    await until(ended(c, job.id), 'the run to end');
    expect(jobNow(c, job.id)).toMatchObject({
      state: 'active',
      nextRunAt: oct(2, 9).toISOString(),
      lastRun: { outcome: 'interrupted' },
    });
    clock.advance(60_000);
    expect(await c.jobs.tick()).toEqual({ started: [], waited: [], interrupted: [], ended: [] });
    expect(runsOf(c, job.id)).toHaveLength(1);
    // On its next occurrence it runs on time, as a scheduled run.
    setTo(clock, oct(2, 9));
    expect((await c.jobs.tick()).started).toHaveLength(1);
    expect(runsOf(c, job.id)[1]).toMatchObject({
      purpose: 'scheduled',
      dueAt: oct(2, 9).toISOString(),
    });
  });

  it('a catch-up cut short by a restart is caught up again, still covering from the last real run', async () => {
    const db = openDatabase(':memory:');
    const sessions = new Map<string, number>();
    const clock = tickingClock(oct(20, 8).getTime());
    let spawns = 0;
    const first = boot({ db, clock, sessions, scenario: () => (spawns++ === 0 ? ECHO : ASKS) });
    const { job } = await longTermJob(first.c);
    setTo(clock, oct(20, 9));
    await first.c.jobs.tick();
    await until(ended(first.c, job.id), 'the first run to end');
    const [real] = runsOf(first.c, job.id);
    setTo(clock, oct(23, 12));
    await first.c.jobs.tick();
    const cut = runsOf(first.c, job.id)[1]!;
    expect(cut).toMatchObject({ purpose: 'catch_up', coversFrom: real!.startedAt });
    await until(
      () => first.c.statuses.get(cut.agentId!)?.state === 'waiting_for_input',
      'the question',
    );
    lives.splice(lives.indexOf(first.c), 1); // kill -9

    clock.advance(10 * 60_000);
    const second = boot({ db, clock, sessions });
    await second.c.recover();
    const report = await second.c.jobs.tick();
    expect(report.interrupted).toEqual([cut.id]);
    const again = runsOf(second.c, job.id)[2]!;
    expect(again).toMatchObject({ purpose: 'catch_up', coversFrom: real!.startedAt });
    expect(jobNow(second.c, job.id).nextRunAt).toBe(oct(24, 9).toISOString());
    lives.push(first.c);
  });

  it('a follow-up cut short by a restart runs again; the schedule is untouched, no extra run', async () => {
    const db = openDatabase(':memory:');
    const sessions = new Map<string, number>();
    const clock = tickingClock(oct(1, 8).getTime());
    const first = boot({ db, clock, sessions, scenario: () => ASKS });
    const { job } = await longTermJob(first.c);
    const followUp = {
      questionId: 'q-reply',
      kind: 'send' as const,
      text: 'Thanks for the review!',
    };
    first.c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { followUps: [followUp] }));
    setTo(clock, oct(1, 8, 30));
    await first.c.jobs.tick();
    const cut = runsOf(first.c, job.id)[0]!;
    expect(cut).toMatchObject({ purpose: 'follow_up', followUp });
    expect(jobNow(first.c, job.id).nextRunAt).toBe(oct(1, 9).toISOString());
    await until(
      () => first.c.statuses.get(cut.agentId!)?.state === 'waiting_for_input',
      'the question',
    );
    lives.splice(lives.indexOf(first.c), 1); // kill -9

    setTo(clock, oct(1, 8, 40));
    const second = boot({ db, clock, sessions });
    await second.c.recover();
    const report = await second.c.jobs.tick();
    expect(report.interrupted).toEqual([cut.id]);
    const runs = runsOf(second.c, job.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ purpose: 'follow_up', followUp });
    expect(jobNow(second.c, job.id)).toMatchObject({
      nextRunAt: oct(1, 9).toISOString(),
      followUps: [],
    });
    setTo(clock, oct(1, 8, 41));
    expect((await second.c.jobs.tick()).started).toEqual([]);
    expect(runsOf(second.c, job.id)).toHaveLength(2);
    lives.push(first.c);
  });

  it('one run at a time: a run still going at the next due time waits, then runs after it', async () => {
    let spawns = 0;
    const { c, clock } = boot({ scenario: () => (spawns++ === 0 ? ASKS : ECHO) });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    setTo(clock, oct(2, 9));
    expect(await c.jobs.tick()).toMatchObject({ started: [], waited: [job.id] });
    expect(stewardsOf(c, job.taskId)).toHaveLength(1);

    const asked = c.log.tables.questions.all().find((q) => q.status === 'open')!;
    await c.commands.answerQuestion({ questionId: asked.id, answer: 'the new ones', by: USER });
    await until(ended(c, job.id), 'the first run to end');
    expect(jobNow(c, job.id).lastRun).toMatchObject({ outcome: 'quiet', summary: 'Two reviews.' });
    const report = await c.jobs.tick();
    expect(report.started).toHaveLength(1);
    expect(runsOf(c, job.id)[1]).toMatchObject({
      purpose: 'scheduled',
      dueAt: oct(2, 9).toISOString(),
    });
  });

  it('a retry and a tick together start one run, carrying the note, which is cleared', async () => {
    let spawns = 0;
    const { c, clock } = boot({
      scenario: () =>
        spawns++ === 0
          ? { steps: [{ kind: 'fail', error: 'the token expired', reason: 'runtime' }] }
          : ECHO,
    });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    await until(() => jobNow(c, job.id).state === 'paused', 'the job to pause');
    const paused = jobNow(c, job.id);
    expect(paused.lastRun).toMatchObject({ outcome: 'failed' });
    expect(paused.pausedReason).toBe('the token expired');

    await c.commands.answerQuestion({
      questionId: paused.failureQuestionId!,
      answer: 'I renewed the token',
      by: USER,
    });
    expect(jobNow(c, job.id)).toMatchObject({
      state: 'active',
      meta: { retryNote: 'I renewed the token' },
    });
    const [, report] = await Promise.all([c.jobs.retryNow(job.id), c.jobs.tick()]);
    expect(report.started).toEqual([]);
    expect(stewardsOf(c, job.taskId)).toHaveLength(2);
    const runs = runsOf(c, job.id);
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ purpose: 'retry', note: 'I renewed the token' });
    expect(jobNow(c, job.id).meta?.['retryNote']).toBeUndefined();
    expect((stewardsOf(c, job.taskId)[1]!.meta as { prompt: string }).prompt).toContain(
      'I renewed the token',
    );
    expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());
  });

  it('a full concurrency cap makes the run wait (no run row); a cap race interrupts it, never fails it', async () => {
    const { c, clock } = boot({
      caps: { maxConcurrentAgents: 1 },
      scenario: (spawn) => (spawn.prompt === 'blocker' ? ASKS : ECHO),
    });
    const { job } = await longTermJob(c);
    const blocker = async () => {
      const spawned = await c.runtime.spawn({
        role: 'steward',
        runtime: 'fake',
        prompt: 'blocker',
        cwd: '/w/other',
      });
      if (!spawned.ok) throw new Error(spawned.reason);
      return spawned.agent.id;
    };

    const first = await blocker();
    setTo(clock, oct(1, 9));
    expect(await c.jobs.tick()).toMatchObject({ started: [], waited: [job.id] });
    expect(runsOf(c, job.id)).toEqual([]);
    await c.runtime.stop(first, USER);
    clock.advance(60_000);
    expect((await c.jobs.tick()).started).toHaveLength(1);
    await until(ended(c, job.id), 'the run to end');
    expect(runsOf(c, job.id)[0]).toMatchObject({ purpose: 'scheduled', outcome: 'quiet' });

    // The race: the slot looked free, then the spawn met the cap.
    const second = await blocker();
    const caps = c.runtime.caps;
    const real = caps.canSpawn.bind(caps);
    let checks = 0;
    caps.canSpawn = (check) => (++checks === 1 ? { ok: true } : real(check));
    setTo(clock, oct(2, 9));
    const raced = await c.jobs.tick();
    caps.canSpawn = real;
    const racedRun = runsOf(c, job.id)[1]!;
    expect(raced).toMatchObject({ started: [racedRun.id], interrupted: [racedRun.id], ended: [] });
    expect(racedRun.outcome).toBe('interrupted');
    expect(jobNow(c, job.id).state).toBe('active');
    expect(c.log.tables.questions.all().filter((q) => q.context.jobFailure)).toEqual([]);

    await c.runtime.stop(second, USER);
    expect((await c.jobs.tick()).started).toHaveLength(1);
    expect(runsOf(c, job.id)[2]).toMatchObject({
      purpose: 'scheduled',
      dueAt: oct(2, 9).toISOString(),
    });
  });

  it('runs a job asking for Gemini on the Steward runtime; a budget refusal fails the run once', async () => {
    const { c, clock } = boot();
    const { job, project, wk } = await longTermJob(c, { provider: 'gemini' });
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    expect(stewardsOf(c, job.taskId)[0]?.runtime).toBe('fake');
    await until(ended(c, job.id), 'the run to end');

    await c.commands.setBudget({ kind: 'project', id: project.id }, 1, USER);
    c.log.tables.spend.put({
      agentId: wk.id,
      usd: 5,
      reported: true,
      session: 's',
      sessions: { s: 5 },
    });
    setTo(clock, oct(2, 9));
    const report = await c.jobs.tick();
    const refused = runsOf(c, job.id)[1]!;
    expect(report).toMatchObject({ started: [refused.id], ended: [refused.id] });
    expect(refused.outcome).toBe('failed');
    expect(stewardsOf(c, job.taskId)).toHaveLength(1);
    const paused = jobNow(c, job.id);
    expect(paused.state).toBe('paused');
    expect(paused.pausedReason).toMatch(/^budget exceeded/);
    const failures = c.log.tables.questions
      .all()
      .filter((q) => q.context.jobFailure?.jobId === job.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ status: 'open', holder: { type: 'user' } });
    // Paused: no run starts, however late.
    setTo(clock, oct(3, 9));
    expect((await c.jobs.tick()).started).toEqual([]);
  });

  it('a run whose project closes stops its Steward and is interrupted, without pausing or asking', async () => {
    const { c, clock } = boot({ scenario: () => ASKS });
    const { job, project } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const stewardId = runsOf(c, job.id)[0]!.agentId!;
    await until(() => c.statuses.get(stewardId)?.state === 'waiting_for_input', 'the question');
    await c.commands.control({ kind: 'project', id: project.id }, { action: 'close' }, USER);
    await until(ended(c, job.id), 'the run to end');
    expect(jobNow(c, job.id)).toMatchObject({
      state: 'stopped',
      lastRun: { outcome: 'interrupted' },
    });
    expect(c.statuses.get(stewardId)?.state).toBe('stopped');
    expect(c.log.tables.questions.all().filter((q) => q.context.jobFailure)).toEqual([]);
  });

  it('a paused project starts no run of its active job: it waits; resumed, the run starts (I1)', async () => {
    const { c, clock } = boot();
    const { job, project } = await longTermJob(c);
    await c.commands.control({ kind: 'project', id: project.id }, { action: 'pause' }, USER);
    expect(jobNow(c, job.id).state).toBe('active');
    setTo(clock, oct(1, 9));
    const report = await c.jobs.tick();
    expect(report).toMatchObject({ started: [], waited: [job.id] });
    expect(runsOf(c, job.id)).toEqual([]);
    await c.commands.control({ kind: 'project', id: project.id }, { action: 'resume' }, USER);
    expect((await c.jobs.tick()).started).toHaveLength(1);
  });

  it('a finished project starts no run, even of a job left active (I1)', async () => {
    const { c, clock } = boot();
    const { job, project } = await longTermJob(c);
    // As a cancel used to leave it: the project failed, its job still active.
    c.log.runCommand((ctx) => {
      ctx.tables.projects.upsert({ ...ctx.tables.projects.get(project.id)!, state: 'failed' });
      ctx.emit({
        type: 'project.state_changed',
        projectId: project.id,
        from: 'approved',
        to: 'failed',
        by: USER,
      });
    });
    expect(jobNow(c, job.id).state).toBe('active');
    setTo(clock, oct(1, 9));
    expect((await c.jobs.tick()).started).toEqual([]);
    expect(runsOf(c, job.id)).toEqual([]);
  });

  it('cancelling the project stops its job and its running run (I1)', async () => {
    const { c, clock } = boot({ scenario: () => ASKS });
    const { job, project } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const stewardId = runsOf(c, job.id)[0]!.agentId!;
    await until(() => c.statuses.get(stewardId)?.state === 'waiting_for_input', 'the question');
    await c.commands.control({ kind: 'project', id: project.id }, { action: 'cancel' }, USER);
    await c.jobs.tick();
    await until(ended(c, job.id), 'the run to end');
    expect(jobNow(c, job.id).state).toBe('stopped');
    setTo(clock, oct(2, 9));
    expect((await c.jobs.tick()).started).toEqual([]);
  });

  it('a job imported mid-run (its run row missing) is cleared and due at once, not stuck (I5)', async () => {
    const { c, clock } = boot();
    const { job } = await longTermJob(c);
    // An export carries the job's runningRunId but not its job_runs.
    c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { runningRunId: 'jr-gone' }));
    setTo(clock, oct(1, 8, 30));
    const report = await c.jobs.tick();
    const runs = runsOf(c, job.id);
    expect(runs).toHaveLength(1);
    expect(report.started).toEqual([runs[0]!.id]);
    expect(report.waited).toEqual([]);
    expect(jobNow(c, job.id).runningRunId).toBe(runs[0]!.id);
    expect(
      events(c).some(
        (e) => e.type === 'job.updated' && e.jobId === job.id && e.changes.runningRunId === null,
      ),
    ).toBe(true);
  });

  it('a cap stop while a permission question waited fails the run with what it needed', async () => {
    const { c, clock } = boot({
      scenario: () => ({
        steps: [{ kind: 'tool_call', toolName: 'Bash', input: { command: 'curl api.myapp.com' } }],
      }),
    });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const stewardId = runsOf(c, job.id)[0]!.agentId!;
    await until(
      () => c.statuses.get(stewardId)?.state === 'waiting_for_input',
      'the permission question',
    );
    await c.runtime.onCapHit(stewardId, 'wall-clock cap: 2 h');
    await until(() => jobNow(c, job.id).state === 'paused', 'the job to pause');
    expect(jobNow(c, job.id).pausedReason).toBe(
      'it needed permission to use the network and nobody answered',
    );
  });

  it("a job's unattended rule allows its run Steward's call; a task Steward of the project is asked", async () => {
    const curl = {
      kind: 'tool_call',
      toolName: 'Bash',
      input: { command: 'curl api.myapp.com' },
    } as const;
    const { c, clock } = boot({ scenario: () => ({ steps: [curl, ...ASKS.steps] }) });
    const { job, project, wk } = await longTermJob(c, {
      unattendedRules: [
        {
          scope: 'prefix',
          tool: 'Bash',
          match: { kind: 'words', words: ['curl', 'api.myapp.com'] },
          categories: ['network'],
          label: 'curl api.myapp.com …',
        },
      ],
    });
    const ruleId = job.unattendedRules[0]!.id;
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const jobSteward = runsOf(c, job.id)[0]!.agentId!;
    const task = (
      await c.commands.createTask({ description: 'call the API', projectId: project.id })
    ).value;
    const taskSteward = (
      await c.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: wk.id,
        prompt: 'call it',
      })
    ).value.id;
    await until(
      () => c.statuses.get(taskSteward)?.state === 'waiting_for_input',
      'the task Steward to be asked',
    );
    expect(events(c)).toContainEqual(
      expect.objectContaining({
        type: 'permission.decided',
        agentId: jobSteward,
        decision: 'allow',
        // P14-03: every covering rule, and `ruleId` is the first of them.
        ruleId,
        ruleIds: [ruleId],
      }),
    );
    const asked = c.log.tables.questions
      .all()
      .filter((q) => q.kind === 'permission' && q.status === 'open');
    expect(asked.map((q) => q.originAgentId)).toEqual([taskSteward]);
  });

  it("a job's unattended rule never turns the project's deny into an allow", async () => {
    const { c, clock } = boot({
      scenario: () => ({
        steps: [{ kind: 'tool_call', toolName: 'Bash', input: { command: 'curl api.myapp.com' } }],
      }),
    });
    const policy = {
      ...DEFAULT_PERMISSION_POLICY,
      rules: { ...DEFAULT_PERMISSION_POLICY.rules, network: 'deny' as const },
    };
    const { job } = await longTermJob(
      c,
      {
        unattendedRules: [
          {
            scope: 'prefix',
            tool: 'Bash',
            match: { kind: 'words', words: ['curl', 'api.myapp.com'] },
            categories: ['network'],
            label: 'curl api.myapp.com …',
          },
        ],
      },
      { permissionPolicy: policy },
    );
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const stewardId = runsOf(c, job.id)[0]!.agentId!;
    await until(
      () => events(c).some((e) => e.type === 'permission.decided' && e.agentId === stewardId),
      'the decision',
    );
    const decided = events(c).find(
      (e): e is Extract<Event, { type: 'permission.decided' }> =>
        e.type === 'permission.decided' && e.agentId === stewardId,
    );
    expect(decided).toMatchObject({ decision: 'deny' });
    expect(decided?.ruleId).toBeUndefined();
  });

  it('publish follow-up runs on the follow-up provider without unattended rules', async () => {
    // The call carries the approved text, so the allowance lets it through once (R15).
    const curl = {
      kind: 'tool_call',
      toolName: 'Bash',
      input: { command: 'curl api.myapp.com -d "status=We launched!"' },
    } as const;
    const spawned: SpawnOptions[] = [];
    const codex = new FakeAdapter({
      speed: 0,
      runtime: 'codex',
      canPublish: true,
      scenarioFor: (spawn) => {
        spawned.push(spawn);
        return { name: 'publish', scenario: { steps: [curl, curl, ...ASKS.steps] } };
      },
    });
    const agy = new FakeAdapter({ speed: 0, runtime: 'agy', canPublish: false });
    const { c, clock } = boot({ providers: [codex, agy] });
    const { job } = await longTermJob(c, {
      provider: 'gemini',
      unattendedRules: [
        {
          scope: 'prefix',
          tool: 'Bash',
          match: { kind: 'words', words: ['curl', 'api.myapp.com'] },
          categories: ['network'],
          label: 'curl api.myapp.com …',
        },
      ],
    });
    const base = { platform: 'X', account: '@shop', text: 'We launched!', files: [] };
    const followUp = {
      questionId: 'q-publish',
      kind: 'publish' as const,
      publish: { ...base, fingerprint: 'a'.repeat(64), jobId: job.id },
    };
    // The job's follow-up provider (the job card sets it; written here directly).
    c.log.runCommand((ctx) =>
      writeJob(ctx, jobOf(ctx, job.id), { followUps: [followUp], followUpProvider: 'chatgpt' }),
    );
    setTo(clock, oct(1, 8, 30));
    await c.jobs.tick();
    const run = runsOf(c, job.id)[0]!;
    expect(run).toMatchObject({ purpose: 'follow_up', followUp });
    expect(stewardsOf(c, job.taskId)[0]?.runtime).toBe('codex');
    expect(spawned).toHaveLength(1);
    const stewardId = run.agentId!;
    // The approved publish lets one network call through; the next one asks: the job's
    // unattended rule (which would allow every such call) is not applied to a publishing run.
    await until(
      () =>
        c.log.tables.questions
          .all()
          .some((q) => q.kind === 'permission' && q.originAgentId === stewardId),
      'the second call to ask',
    );
    const decided = events(c).filter(
      (e): e is Extract<Event, { type: 'permission.decided' }> =>
        e.type === 'permission.decided' && e.agentId === stewardId,
    );
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ decision: 'allow' });
    expect(decided[0]!.ruleId).toBeUndefined();
  });

  describe('a publishing run asks for every network call (ruling R26)', () => {
    const TEXT = 'We launched!';
    const curl = (text: string) =>
      ({
        kind: 'tool_call',
        toolName: 'Bash',
        input: { command: `curl api.myapp.com -d "status=${text}"` },
      }) as const;

    /** A publish follow-up of a job whose Steward makes `calls`, then asks a clarification. */
    async function publishRun(
      calls: ReturnType<typeof curl>[],
      o: { policy?: typeof DEFAULT_PERMISSION_POLICY; projectRule?: boolean } = {},
    ) {
      const codex = new FakeAdapter({
        speed: 0,
        runtime: 'codex',
        canPublish: true,
        scenarioFor: () => ({ name: 'publish', scenario: { steps: [...calls, ...ASKS.steps] } }),
      });
      const { c, clock } = boot({ providers: [codex] });
      const { job, project } = await longTermJob(
        c,
        { provider: 'chatgpt' },
        o.policy ? { permissionPolicy: o.policy } : {},
      );
      if (o.projectRule) {
        // An earlier "Allow similar" on the network for `curl api.myapp.com …`.
        c.log.runCommand((ctx) =>
          addPermissionRule(
            ctx,
            project.id,
            {
              scope: 'prefix',
              tool: 'Bash',
              match: { kind: 'words', words: ['curl', 'api.myapp.com'] },
              categories: ['network'],
              label: 'curl api.myapp.com …',
              preview: 'curl api.myapp.com …',
            },
            { by: USER, origin: 'local' },
          ),
        );
      }
      const base = { platform: 'X', account: '@shop', text: TEXT, files: [] };
      const followUp = {
        questionId: 'q-publish',
        kind: 'publish' as const,
        publish: { ...base, fingerprint: 'a'.repeat(64), jobId: job.id },
      };
      c.log.runCommand((ctx) =>
        writeJob(ctx, jobOf(ctx, job.id), { followUps: [followUp], followUpProvider: 'chatgpt' }),
      );
      setTo(clock, oct(1, 8, 30));
      await c.jobs.tick();
      const stewardId = runsOf(c, job.id)[0]!.agentId!;
      await until(
        () =>
          c.log.tables.questions
            .all()
            .some((q) => q.kind === 'permission' && q.originAgentId === stewardId),
        'a network call to ask',
      );
      const decided = events(c).filter(
        (e): e is Extract<Event, { type: 'permission.decided' }> =>
          e.type === 'permission.decided' && e.agentId === stewardId,
      );
      return { decided };
    }

    it('in a trusted project a network call carrying other content asks', async () => {
      const { decided } = await publishRun([curl('Something else')], {
        policy: PERMISSION_POLICY_PRESETS.trusted,
      });
      expect(decided).toEqual([]);
    });

    it('in a trusted project the approved call is allowed once, the next one asks', async () => {
      const { decided } = await publishRun([curl(TEXT), curl(TEXT)], {
        policy: PERMISSION_POLICY_PRESETS.trusted,
      });
      expect(decided).toHaveLength(1);
      expect(decided[0]).toMatchObject({ decision: 'allow' });
      expect(decided[0]!.ruleId).toBeUndefined();
    });

    it("the project's Allow-similar network rule is ignored", async () => {
      const { decided } = await publishRun([curl('Something else')], { projectRule: true });
      expect(decided).toEqual([]);
    });
  });

  it('an interrupted publish follow-up is never run again on its approval: it asks again (R13)', async () => {
    const db = openDatabase(':memory:');
    const sessions = new Map<string, number>();
    const clock = tickingClock(oct(1, 8).getTime());
    const first = boot({ db, clock, sessions, canPublish: true, scenario: () => ASKS });
    const { job } = await longTermJob(first.c);
    const base = { platform: 'X', account: '@shop', text: 'We launched!', files: [] };
    const publish = { ...base, fingerprint: 'a'.repeat(64), jobId: job.id };
    const followUp = { questionId: 'q-publish', kind: 'publish' as const, publish };
    first.c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { followUps: [followUp] }));
    setTo(clock, oct(1, 8, 30));
    await first.c.jobs.tick();
    const cut = runsOf(first.c, job.id)[0]!;
    expect(cut).toMatchObject({ purpose: 'follow_up', followUp });
    await until(
      () => first.c.statuses.get(cut.agentId!)?.state === 'waiting_for_input',
      'the question',
    );
    lives.splice(lives.indexOf(first.c), 1); // kill -9

    setTo(clock, oct(1, 8, 40));
    const second = boot({ db, clock, sessions, canPublish: true });
    await second.c.recover();
    const report = await second.c.jobs.tick();
    expect(report.interrupted).toEqual([cut.id]);
    // No second run on the old approval: the queue is empty and a fresh card asks.
    expect(runsOf(second.c, job.id)).toHaveLength(1);
    expect(jobNow(second.c, job.id).followUps).toEqual([]);
    const again = second.c.log.tables.questions
      .all()
      .filter((q) => q.kind === 'publish' && q.status === 'open');
    expect(again).toHaveLength(1);
    expect(again[0]!.context.publish).toEqual(publish);
    expect(again[0]!.context.text).toBe(
      'Publish to X (@shop): the earlier attempt was interrupted and may already have posted. Publish again?',
    );
    expect(again[0]).toMatchObject({ holder: USER, meta: { jobOwned: true } });
    setTo(clock, oct(1, 8, 41));
    expect((await second.c.jobs.tick()).started).toEqual([]);
    // Approving it queues a new follow-up, which runs.
    await second.c.commands.answerQuestion({
      questionId: again[0]!.id,
      answer: 'Approve',
      by: USER,
    });
    expect(jobNow(second.c, job.id).followUps).toEqual([
      { questionId: again[0]!.id, kind: 'publish', publish },
    ]);
    lives.push(first.c);
  });

  it('a publish follow-up that meets a cap race before any spawn goes back on the queue, no re-ask', async () => {
    const { c, clock } = boot({
      canPublish: true,
      caps: { maxConcurrentAgents: 1 },
      scenario: (spawn) => (spawn.prompt === 'blocker' ? ASKS : ECHO),
    });
    const { job } = await longTermJob(c);
    const base = { platform: 'X', account: '@shop', text: 'We launched!', files: [] };
    const followUp = {
      questionId: 'q-publish',
      kind: 'publish' as const,
      publish: { ...base, fingerprint: 'a'.repeat(64), jobId: job.id },
    };
    c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { followUps: [followUp] }));
    const blocker = await c.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'blocker',
      cwd: '/w/other',
    });
    if (!blocker.ok) throw new Error(blocker.reason);
    const caps = c.runtime.caps;
    const real = caps.canSpawn.bind(caps);
    let checks = 0;
    caps.canSpawn = (check) => (++checks === 1 ? { ok: true } : real(check));
    setTo(clock, oct(1, 8, 30));
    const raced = await c.jobs.tick();
    caps.canSpawn = real;
    const run = runsOf(c, job.id)[0]!;
    expect(raced).toMatchObject({ started: [run.id], interrupted: [run.id] });
    expect(stewardsOf(c, job.taskId)).toEqual([]);
    expect(jobNow(c, job.id).followUps).toEqual([followUp]);
    expect(c.log.tables.questions.all().filter((q) => q.kind === 'publish')).toEqual([]);
  });

  it('a limited run does not pause the job', async () => {
    const resetsAt = oct(1, 14).toISOString();
    let spawns = 0;
    const { c, clock } = boot({
      // The first run hits the subscription's limit; later runs go through.
      scenario: () =>
        spawns++ === 0
          ? {
              steps: [
                { kind: 'fail', error: 'Claude usage limit reached', reason: 'limit', resetsAt },
              ],
            }
          : ECHO,
    });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    await until(ended(c, job.id), 'the limited run');
    await until(() => jobNow(c, job.id).limitQuestionId !== undefined, 'the limit question');
    const [run] = runsOf(c, job.id);
    expect(run).toMatchObject({ outcome: 'limited' });
    const limitedJob = jobNow(c, job.id);
    expect(limitedJob.state).toBe('active');
    expect(limitedJob.pausedReason).toBeUndefined();
    expect(limitedJob.lastRun).toMatchObject({ outcome: 'limited' });
    expect(c.log.tables.questions.all().filter((q) => q.context.jobFailure)).toEqual([]);
    const question = c.log.tables.questions.get(limitedJob.limitQuestionId!)!;
    expect(question).toMatchObject({
      status: 'open',
      holder: { type: 'user' },
      meta: { toUser: true, jobOwned: true },
      context: {
        usageLimit: { provider: 'claude', jobId: job.id, runId: run!.id, resetsAt, switchTo: [] },
        options: [LIMIT_WAIT],
      },
    });

    // No new run while the question is open, even when the next one is due.
    setTo(clock, oct(2, 9));
    expect((await c.jobs.tick()).started).toEqual([]);
    expect(runsOf(c, job.id)).toHaveLength(1);

    // Waiting: the reset is already past, so the wait is over at once and the job due now.
    await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
    await c.usageLimits.settled();
    expect(jobNow(c, job.id).limitQuestionId).toBeUndefined();
    expect(jobNow(c, job.id).nextRunAt! <= c.log.clock()).toBe(true);
    const report = await c.jobs.tick();
    expect(report.started).toHaveLength(1);
    await until(() => runsOf(c, job.id).at(-1)?.outcome === 'quiet', 'the run after the wait');
    expect(jobNow(c, job.id).state).toBe('active');
  });

  it('a switched job run uses the chosen model once; the job keeps its provider', async () => {
    let spawns = 0;
    const limitedFirst = () =>
      spawns++ === 0
        ? {
            name: 'limited',
            scenario: {
              steps: [
                {
                  kind: 'fail' as const,
                  error: 'Gemini usage limit reached',
                  reason: 'limit' as const,
                },
              ],
            },
          }
        : { name: 'echo', scenario: ECHO };
    const agy = new FakeAdapter({
      speed: 0,
      runtime: 'agy',
      models: [
        {
          id: 'gemini-3-flash',
          label: 'Gemini 3 Flash',
          family: 'gemini',
          isDefault: false,
          capabilities: ['text'],
        },
      ],
      scenarioFor: limitedFirst,
    });
    const codex = new FakeAdapter({
      speed: 0,
      runtime: 'codex',
      models: [
        {
          id: 'gpt-5.6',
          label: 'GPT-5.6',
          family: 'gpt',
          isDefault: false,
          capabilities: ['text'],
        },
      ],
      scenarioFor: limitedFirst,
    });
    const { c, clock } = boot({ providers: [agy, codex] });
    const { job } = await longTermJob(c, { provider: 'gemini' });
    // The job's exact model (the job card sets it; written here directly).
    c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { model: 'gemini-3-flash' }));
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    await until(() => jobNow(c, job.id).limitQuestionId !== undefined, 'the limit question');
    const question = c.log.tables.questions.get(jobNow(c, job.id).limitQuestionId!)!;
    expect(question.context.options).toEqual(['Switch to ChatGPT · GPT-5.6', LIMIT_WAIT]);

    await c.commands.answerQuestion({
      questionId: question.id,
      answer: 'Switch to ChatGPT · GPT-5.6',
      by: USER,
    });
    const report = await c.jobs.tick();
    expect(report.started).toHaveLength(1);
    const switched = c.log.tables.agents.get(runsOf(c, job.id).at(-1)!.agentId!)!;
    expect(switched.runtime).toBe('codex');
    expect(switched.meta).toMatchObject({ model: 'gpt-5.6' });
    expect(jobNow(c, job.id)).toMatchObject({ provider: 'gemini', model: 'gemini-3-flash' });
    expect(jobNow(c, job.id).limitQuestionId).toBeUndefined();
    await until(ended(c, job.id), 'the switched run');

    // The next run is the job's own provider again.
    setTo(clock, oct(2, 9));
    await c.jobs.tick();
    const next = c.log.tables.agents.get(runsOf(c, job.id).at(-1)!.agentId!)!;
    expect(next.runtime).toBe('agy');
    expect(next.meta).toMatchObject({ model: 'gemini-3-flash' });
  });

  it('publish follow-up refused on Gemini', async () => {
    const agy = new FakeAdapter({ speed: 0, runtime: 'agy', canPublish: false });
    const { c, clock } = boot({ providers: [agy] });
    const { job } = await longTermJob(c, { provider: 'gemini' });
    const base = { platform: 'X', account: '@shop', text: 'We launched!', files: [] };
    const followUp = {
      questionId: 'q-publish',
      kind: 'publish' as const,
      publish: { ...base, fingerprint: 'a'.repeat(64), jobId: job.id },
    };
    c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { followUps: [followUp] }));
    setTo(clock, oct(1, 8, 30));
    const report = await c.jobs.tick();
    const run = runsOf(c, job.id)[0]!;
    expect(report).toMatchObject({ started: [run.id], ended: [run.id] });
    expect(run).toMatchObject({ outcome: 'failed', purpose: 'follow_up' });
    expect(stewardsOf(c, job.taskId)).toEqual([]);
    const paused = jobNow(c, job.id);
    expect(paused.state).toBe('paused');
    expect(paused.pausedReason).toBe('Gemini cannot publish');
    const failures = c.log.tables.questions
      .all()
      .filter((q) => q.context.jobFailure?.jobId === job.id);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.context.jobFailure!.reason).toBe('Gemini cannot publish');
    // The approved publish waits on the job for the retry, on a provider that can publish.
    expect(paused.followUps).toEqual([followUp]);
  });

  describe('usage limits: the deferred cases (P11-13)', () => {
    const RESETS_AT = oct(1, 14).toISOString();
    const LIMIT: FakeScenario = {
      steps: [{ kind: 'fail', error: 'usage limit reached', reason: 'limit', resetsAt: RESETS_AT }],
    };
    const PUBLISH_BASE = { platform: 'X', account: '@shop', text: 'We launched!', files: [] };

    /** Queues an approved publish follow-up and runs it (limited); returns the limit question. */
    async function limitedPublish(c: ComposedRuntime, clock: Clock, jobId: Id) {
      const followUp = {
        questionId: 'q-publish',
        kind: 'publish' as const,
        publish: { ...PUBLISH_BASE, fingerprint: 'a'.repeat(64), jobId },
      };
      c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, jobId), { followUps: [followUp] }));
      setTo(clock, oct(1, 10, 30));
      await c.jobs.tick();
      await until(() => jobNow(c, jobId).limitQuestionId !== undefined, 'the limit question');
      const question = c.log.tables.questions.get(jobNow(c, jobId).limitQuestionId!)!;
      // The run may have posted: its publish is asked again (ruling R13).
      const reasked = c.log.tables.questions
        .all()
        .filter((q) => q.kind === 'publish' && q.meta?.['reaskOf'] === 'q-publish');
      expect(reasked).toHaveLength(1);
      return { question, reasked: reasked[0]! };
    }

    it('stopping a job withdraws its open limit question; pausing keeps it', async () => {
      const { c, clock } = boot({ scenario: () => LIMIT });
      const { job } = await longTermJob(c);
      setTo(clock, oct(1, 9));
      await c.jobs.tick();
      await until(() => jobNow(c, job.id).limitQuestionId !== undefined, 'the limit question');
      const questionId = jobNow(c, job.id).limitQuestionId!;
      await c.commands.setJobState({ jobId: job.id, state: 'paused', by: USER });
      expect(c.log.tables.questions.get(questionId)?.status).toBe('open');
      expect(jobNow(c, job.id).limitQuestionId).toBe(questionId);

      await c.commands.setJobState({ jobId: job.id, state: 'stopped', by: USER });
      expect(c.log.tables.questions.get(questionId)?.status).toBe('cancelled');
      expect(jobNow(c, job.id).limitQuestionId).toBeUndefined();
      expect(
        events(c).filter((e) => e.type === 'question.cancelled' && e.questionId === questionId),
      ).toEqual([expect.objectContaining({ reason: 'the job was stopped' })]);
      await expect(
        c.commands.answerQuestion({ questionId, answer: LIMIT_WAIT, by: USER }),
      ).rejects.toThrow();
    });

    it('a job stopped while the catalogue answers gets no limit question (M1)', async () => {
      const agy = new FakeAdapter({
        speed: 0,
        runtime: 'agy',
        scenarioFor: () => ({ name: 'limited', scenario: LIMIT }),
      });
      const { c, clock } = boot({ providers: [agy] });
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let asked = false;
      // `usage` is asked only by the limit question (spawns ask `models` and `check`).
      const usage = c.catalog.usage.bind(c.catalog);
      c.catalog.usage = async (p) => {
        asked = true;
        await held;
        return usage(p);
      };
      const { job } = await longTermJob(c, { provider: 'gemini' });
      setTo(clock, oct(1, 9));
      await c.jobs.tick();
      await until(() => asked, 'the catalogue asked');
      await c.commands.setJobState({ jobId: job.id, state: 'stopped', by: USER });
      release();
      // The limit is asked in the scheduler's queue: a tick queued after it waits for it.
      await c.jobs.tick();
      await c.usageLimits.settled();
      expect(runsOf(c, job.id)).toMatchObject([{ outcome: 'limited' }]);
      expect(
        c.log.tables.questions
          .all()
          .filter((q) => q.status === 'open' && q.context.usageLimit?.jobId === job.id),
      ).toEqual([]);
      expect(jobNow(c, job.id).limitQuestionId).toBeUndefined();
    });

    it('Wait on a limited publish follow-up leaves the ordinary schedule alone (M3)', async () => {
      let spawns = 0;
      const { c, clock } = boot({
        clock: tickingClock(oct(1, 10).getTime()),
        canPublish: true,
        scenario: () => (spawns++ === 0 ? LIMIT : ECHO),
      });
      const { job } = await longTermJob(c);
      expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());
      const { question, reasked } = await limitedPublish(c, clock, job.id);
      await c.commands.answerQuestion({ questionId: question.id, answer: LIMIT_WAIT, by: USER });
      expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());

      // Past the reset: the wait is over, the ordinary run is still tomorrow's.
      setTo(clock, oct(1, 14, 1));
      await c.usageLimits.tick();
      expect(jobNow(c, job.id).limitQuestionId).toBeUndefined();
      expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());
      expect((await c.jobs.tick()).started).toEqual([]);

      // The re-asked publish approved: the follow-up runs, the schedule stays.
      await c.commands.answerQuestion({ questionId: reasked.id, answer: 'Approve', by: USER });
      expect((await c.jobs.tick()).started).toHaveLength(1);
      expect(runsOf(c, job.id).at(-1)).toMatchObject({ purpose: 'follow_up' });
      expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());
    });

    it('a switch on a limited publish follow-up goes to its re-asked publish, not the next ordinary run (M4)', async () => {
      const textModel = (id: string, label: string, family: 'claude' | 'gpt' | 'gemini') => ({
        id,
        label,
        family,
        isDefault: false,
        capabilities: ['text' as const],
      });
      const codex = new FakeAdapter({
        speed: 0,
        runtime: 'codex',
        canPublish: true,
        models: [textModel('gpt-5.6', 'GPT-5.6', 'gpt')],
        scenarioFor: () => ({ name: 'limited', scenario: LIMIT }),
      });
      const claude = new FakeAdapter({
        speed: 0,
        runtime: 'claude-sdk',
        canPublish: true,
        models: [textModel('sonnet', 'Sonnet', 'claude')],
        scenarioFor: () => ({ name: 'echo', scenario: ECHO }),
      });
      const agy = new FakeAdapter({
        speed: 0,
        runtime: 'agy',
        canPublish: false,
        models: [textModel('gemini-3-flash', 'Gemini 3 Flash', 'gemini')],
        scenarioFor: () => ({ name: 'echo', scenario: ECHO }),
      });
      const { c, clock } = boot({
        clock: tickingClock(oct(1, 10).getTime()),
        providers: [codex, claude, agy],
        // The Waykeeper row runs on `fake`, so its Claude Stewards do too (the dev rule).
        canPublish: true,
      });
      const { job } = await longTermJob(c, { provider: 'gemini' });
      c.log.runCommand((ctx) => writeJob(ctx, jobOf(ctx, job.id), { followUpProvider: 'chatgpt' }));
      const { question, reasked } = await limitedPublish(c, clock, job.id);
      expect(c.log.tables.agents.get(runsOf(c, job.id)[0]!.agentId!)?.runtime).toBe('codex');
      // Computed for a publishing step: Claude, never Gemini (it cannot publish).
      expect(question.context.options).toEqual(['Switch to Claude · Sonnet', LIMIT_WAIT]);
      await c.commands.answerQuestion({
        questionId: question.id,
        answer: 'Switch to Claude · Sonnet',
        by: USER,
      });
      // No ordinary run is made due by the switch.
      expect(jobNow(c, job.id).nextRunAt).toBe(oct(2, 9).toISOString());
      setTo(clock, oct(1, 10, 40));
      expect((await c.jobs.tick()).started).toEqual([]);

      // An ordinary run that comes first keeps the job's own provider, and the switch waits.
      setTo(clock, oct(2, 9));
      await c.jobs.tick();
      const ordinary = runsOf(c, job.id).at(-1)!;
      expect(ordinary.purpose).not.toBe('follow_up');
      expect(c.log.tables.agents.get(ordinary.agentId!)?.runtime).toBe('agy');
      expect(jobNow(c, job.id).limitQuestionId).toBe(question.id);
      await until(ended(c, job.id), 'the ordinary run');

      // The re-asked publish approved: its run is the one the switch was for.
      await c.commands.answerQuestion({ questionId: reasked.id, answer: 'Approve', by: USER });
      setTo(clock, oct(2, 9, 30));
      await c.jobs.tick();
      const retried = runsOf(c, job.id).at(-1)!;
      expect(retried).toMatchObject({ purpose: 'follow_up' });
      // Claude's Sonnet (on `fake`, the dev rule for a fake Waykeeper), not the job's ChatGPT.
      expect(c.log.tables.agents.get(retried.agentId!)).toMatchObject({ runtime: 'fake' });
      expect(c.log.tables.agents.get(retried.agentId!)?.meta).toMatchObject({ model: 'sonnet' });
      expect(jobNow(c, job.id).limitQuestionId).toBeUndefined();
      expect(jobNow(c, job.id)).toMatchObject({ provider: 'gemini', followUpProvider: 'chatgpt' });
    });
  });

  it('dispose() stops the timer', async () => {
    const fake = fakeTimers();
    const { c } = boot({ timers: fake.timers, intervalMs: 1000 });
    expect(c.jobs.running).toBe(true);
    expect(fake.count()).toBe(1);
    await c.dispose();
    lives.splice(lives.indexOf(c), 1);
    expect(c.jobs.running).toBe(false);
    expect(fake.cleared()).toBe(1);
  });
});

describe('what a run used (P15-02)', () => {
  it('a run that ends holds the deduplicated sources its allowed calls used', async () => {
    const { c, clock } = boot({
      scenario: () => ({
        steps: [
          { kind: 'tool_call', toolName: 'WebFetch', input: { url: 'https://api.posthog.com/a' } },
          { kind: 'tool_call', toolName: 'WebFetch', input: { url: 'https://api.posthog.com/b' } },
          { kind: 'tool_call', toolName: 'Read', input: { file_path: '/data/notes/a.md' } },
          { kind: 'tool_call', toolName: 'Bash', input: { command: 'git status' } },
          {
            kind: 'tool_call',
            toolName: 'report_run',
            input: {
              outcome: 'quiet',
              summary: 'Done.',
              texts: { note: 'hi' },
              sourceProblems: [{ sourceId: 'crm', problem: 'down' }],
            },
          },
          { kind: 'output', text: 'Done.' },
        ],
      }),
    });
    const { job } = await longTermJob(
      c,
      {},
      { permissionPolicy: PERMISSION_POLICY_PRESETS.trusted },
    );
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    await until(ended(c, job.id), 'the run to end');
    const run = runsOf(c, job.id)[0]!;
    expect(run.outcome).toBe('quiet');
    expect(run.data).toEqual({
      texts: { note: 'hi' },
      sourceProblems: [{ sourceId: 'crm', problem: 'down' }],
    });
    expect(run.sources).toEqual(
      expect.arrayContaining([
        { kind: 'site', target: 'api.posthog.com' },
        { kind: 'files', target: '/data/notes' },
      ]),
    );
    expect(run.sources).toHaveLength(2);
  });

  it('a call the gate asks about is not noted', async () => {
    const { c, clock } = boot({
      scenario: () => ({
        steps: [
          { kind: 'tool_call', toolName: 'WebFetch', input: { url: 'https://asked.example.com/' } },
        ],
      }),
    });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    const stewardId = runsOf(c, job.id)[0]!.agentId!;
    await until(() => c.statuses.get(stewardId)?.state === 'waiting_for_input', 'the question');
    expect(c.runSources.take(stewardId)).toEqual([]);
  });
});

describe("a run's end wakes no one (P10-04)", () => {
  it("the Steward's final turn ends the run quiet with its last text; the Waykeeper hears nothing", async () => {
    const clock = tickingClock(oct(1, 8).getTime());
    const h = brainHarness({
      compose: { log: { now: clock }, stewardRuntimeOverride: () => 'fake' },
    });
    harnesses.push(h);
    const hq = await h.startHarmonizer();
    const project = (
      await h.commands.createProject({
        name: 'Shop',
        workspace: '/w/shop',
        longTerm: { purpose: 'Run the shop', goals: [] },
      })
    ).value;
    const wk = await h.startBrain(
      brainDefinition('waykeeper'),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      { scriptOptions: { strict: false } },
    );
    const { job } = (
      await h.commands.createJob({
        projectId: project.id,
        area: { name: 'Feedback' },
        draft: DRAFT,
        by: USER,
      })
    ).value;
    await h.settle();
    const turnsBefore = wk.prompts().length;

    setTo(clock, oct(1, 9));
    await h.composed.jobs.tick();
    const stewardId = h.log.tables.jobRuns.all()[0]!.agentId!;
    await h.until(() => h.log.tables.jobs.get(job.id)?.lastRun !== undefined, {
      what: 'the run to end',
    });
    await h.until(() => h.statuses.get(stewardId)?.state === 'stopped', { what: 'the stop' });
    await h.settle();

    expect(h.log.tables.jobs.get(job.id)?.lastRun).toMatchObject({
      outcome: 'quiet',
      summary: 'hello from the fake agent',
    });
    const all = h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
    expect(
      all.filter(
        (e) => e.type === 'message.sent' && e.sender.type === 'agent' && e.sender.id === stewardId,
      ),
    ).toEqual([]);
    expect(h.composed.reports.sent).toEqual([]);
    expect(wk.prompts().slice(turnsBefore).join('\n')).not.toContain(stewardId);
    expect(wk.prompts()).toHaveLength(turnsBefore);
  });
});

describe('refresh: a run now (P15-04)', () => {
  it('pressed twice gives one run: the second returns its id; the end leaves nextRunAt and the window alone (Review Focus 2)', async () => {
    let spawns = 0;
    const { c, clock, errors } = boot({ scenario: () => (spawns++ === 0 ? ASKS : ECHO) });
    const { job } = await longTermJob(c);
    const nextRunAt = jobNow(c, job.id).nextRunAt;
    expect(nextRunAt).toBe(oct(1, 9).toISOString());
    setTo(clock, oct(1, 8, 10));

    const first = await c.jobs.runNow(job.id, USER);
    expect(first.started).toBe(true);
    expect(c.log.tables.jobRuns.get(first.runId)).toMatchObject({
      purpose: 'refresh',
      coversFrom: job.createdAt,
    });
    expect(stewardsOf(c, job.taskId)).toHaveLength(1);
    expect(await c.jobs.runNow(job.id, USER)).toEqual({ runId: first.runId, started: false });
    expect(stewardsOf(c, job.taskId)).toHaveLength(1);

    const asked = c.log.tables.questions.all().find((q) => q.status === 'open')!;
    await c.commands.answerQuestion({ questionId: asked.id, answer: 'the new ones', by: USER });
    await until(ended(c, job.id), 'the refresh run to end');
    expect(jobNow(c, job.id)).toMatchObject({
      nextRunAt,
      lastRun: { runId: first.runId, purpose: 'refresh', outcome: 'quiet' },
    });

    // The scheduled run is still for 09:00 and covers from where it did before the refresh.
    setTo(clock, oct(1, 9));
    expect((await c.jobs.tick()).started).toHaveLength(1);
    expect(runsOf(c, job.id)[1]).toMatchObject({ purpose: 'scheduled', coversFrom: job.createdAt });
    expect(errors).toEqual([]);
  });

  it('a refresh cut short does not make the job due', async () => {
    const { c, clock } = boot({ scenario: () => ASKS });
    const { job } = await longTermJob(c);
    const nextRunAt = jobNow(c, job.id).nextRunAt;
    setTo(clock, oct(1, 8, 10));
    const { runId } = await c.jobs.runNow(job.id, USER);
    const steward = c.log.tables.jobRuns.get(runId)!.agentId!;
    await c.runtime.stop(steward, SYSTEM);
    clock.advance(60_000);
    const report = await c.jobs.tick();
    expect(report).toMatchObject({ started: [], interrupted: [runId] });
    expect(jobNow(c, job.id).nextRunAt).toBe(nextRunAt);
    clock.advance(60_000);
    expect((await c.jobs.tick()).started).toEqual([]);
  });

  it('is refused while the job is paused or stopped, or its project paused', async () => {
    const { c, errors } = boot();
    const { job, project } = await longTermJob(c);
    await c.commands.control({ kind: 'project', id: project.id }, { action: 'pause' }, USER);
    await expect(c.jobs.runNow(job.id, USER)).rejects.toMatchObject({ code: 'invalid' });
    await c.commands.control({ kind: 'project', id: project.id }, { action: 'resume' }, USER);

    await c.commands.setJobState({ jobId: job.id, state: 'paused', by: USER });
    await expect(c.jobs.runNow(job.id, USER)).rejects.toMatchObject({ code: 'invalid' });
    await c.commands.setJobState({ jobId: job.id, state: 'stopped', by: USER });
    await expect(c.jobs.runNow(job.id, USER)).rejects.toMatchObject({ code: 'invalid' });
    await expect(c.jobs.runNow('j-nope', USER)).rejects.toMatchObject({ code: 'not_found' });
    expect(runsOf(c, job.id)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('is refused for an agent: a refresh is the user’s', async () => {
    const { c, errors } = boot();
    const { job, wk } = await longTermJob(c);
    await expect(c.jobs.runNow(job.id, { type: 'agent', id: wk.id })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(runsOf(c, job.id)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('is refused while the job waits on its usage-limit question', async () => {
    const LIMITED: FakeScenario = {
      steps: [
        {
          kind: 'fail',
          error: 'usage limit reached',
          reason: 'limit',
          resetsAt: oct(1, 14).toISOString(),
        },
      ],
    };
    const { c, clock, errors } = boot({ scenario: () => LIMITED });
    const { job } = await longTermJob(c);
    setTo(clock, oct(1, 9));
    await c.jobs.tick();
    await until(() => jobNow(c, job.id).limitQuestionId !== undefined, 'the limit question');
    expect(jobNow(c, job.id).state).toBe('active');
    await expect(c.jobs.runNow(job.id, USER)).rejects.toMatchObject({ code: 'invalid' });
    expect(runsOf(c, job.id)).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('is refused with `limit` when the caps leave no slot; no run row is written', async () => {
    const { c } = boot({
      caps: { maxConcurrentAgents: 1 },
      scenario: (spawn) => (spawn.prompt === 'blocker' ? ASKS : ECHO),
    });
    const { job } = await longTermJob(c);
    const spawned = await c.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'blocker',
      cwd: '/w/other',
    });
    expect(spawned.ok).toBe(true);
    await expect(c.jobs.runNow(job.id, USER)).rejects.toMatchObject({ code: 'limit' });
    expect(runsOf(c, job.id)).toEqual([]);
  });
});
