import { describe, expect, it } from 'vitest';
import {
  FAILURE_ACTIONS,
  LONG_TERM_LIMITS,
  applyEvent,
  applySnapshot,
  type Actor,
  type EventEnvelope,
  type Id,
  type JobDraft,
  type Snapshot,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { DomainError } from './errors.js';
import type { CommandContext } from './event-log.js';
import {
  JOB_TICK_MS,
  attachJobRunAgent,
  endJobRun,
  jobMemory,
  jobRuns,
  runPurpose,
  startJobRun,
} from './job-runs.js';
import { createJob, jobOf, setJobState } from './jobs.js';
import { createProject } from './projects.js';
import { endAgentQuestions, logRouting } from './question-service.js';
import { answerQuestion, cancelQuestionsOf, openQuestion } from './questions.js';

/**
 * P10-04 (plan Task 6) — job runs: a run starts (one at a time, only while the job is active),
 * ends with its outcome on the job's `lastRun`, keeps the last 200 runs, pauses its job on failure
 * with exactly one user-held failure question that outlives the run's Steward, and leaves a short
 * memory the next run reads. Every command's rows equal the protocol fold.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and summarise them.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

function setup(opts: { waykeeper?: boolean; harmonizer?: boolean } = {}) {
  const w = world();
  const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
  const recorded: EventEnvelope[] = [];
  w.log.subscribe((e) => recorded.push(e));
  const cmd = <T>(fn: (ctx: CommandContext) => T): T => w.log.runCommand(fn).value;
  const err = (fn: () => unknown): DomainError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace: '/w/shop',
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    }),
  );
  const { job } = cmd((ctx) =>
    createJob(ctx, { projectId: project.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
  );
  const agents = cmd((ctx) => {
    const hq =
      opts.harmonizer === false
        ? undefined
        : createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: CAPS });
    const wk =
      opts.waykeeper === false || !hq
        ? undefined
        : createAgent(ctx, {
            role: 'waykeeper',
            runtime: 'fake',
            caps: CAPS,
            projectId: project.id,
            supervisorId: hq.id,
          });
    return { hq, wk };
  });
  /** A run Steward on the job's task. */
  const steward = () =>
    cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        taskId: job.taskId,
        projectId: project.id,
        ...((agents.wk ?? agents.hq) ? { supervisorId: (agents.wk ?? agents.hq)!.id } : {}),
      }),
    );
  const start1 = (dueAt = '2026-10-01T09:00:00.000Z') =>
    cmd((ctx) => startJobRun(ctx, { jobId: job.id, purpose: 'scheduled', dueAt }));
  /** The protocol fold of everything logged equals the server's tables. */
  const conforms = () => {
    let folded = applySnapshot(start);
    for (const env of recorded) folded = applyEvent(folded, env);
    const snap = w.log.snapshot();
    const byId = <T extends { id: Id }>(rows: T[]) =>
      Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(folded.jobs).toEqual(byId(snap.jobs ?? []));
    expect(folded.tasks).toEqual(byId(snap.tasks));
    expect(folded.questions).toEqual(byId(snap.questions));
  };
  return { ...w, cmd, err, project, job, agents, steward, start1, conforms, recorded };
}

describe('startJobRun / endJobRun', () => {
  it('start → end quiet records the run on lastRun and clears runningRunId', () => {
    const s = setup();
    const out = s.log.runCommand((ctx) =>
      startJobRun(ctx, {
        jobId: s.job.id,
        purpose: 'scheduled',
        dueAt: '2026-10-01T09:00:00.000Z',
      }),
    );
    const run = out.value;
    expect(out.events.map((e) => e.event.type)).toEqual(['job_run.started', 'job.updated']);
    expect(run.outcome).toBe('running');
    expect(run.coversFrom).toBe(s.job.createdAt);
    expect(run.startedAt).toBe(out.events[0]!.at);
    expect(jobOf(s, s.job.id).runningRunId).toBe(run.id);
    const stew = s.steward();
    expect(
      s.cmd((ctx) => attachJobRunAgent(ctx, { runId: run.id, agentId: stew.id })).agentId,
    ).toBe(stew.id);

    const ended = s.log.runCommand((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'quiet', summary: 'Nothing new.' }),
    );
    expect(ended.events.map((e) => e.event.type)).toEqual(['job_run.ended', 'job.updated']);
    expect(ended.value).toMatchObject({ outcome: 'quiet', summary: 'Nothing new.' });
    const job = jobOf(s, s.job.id);
    expect(job.runningRunId).toBeUndefined();
    expect(job.lastRun).toEqual({
      runId: run.id,
      outcome: 'quiet',
      purpose: 'scheduled',
      startedAt: run.startedAt,
      endedAt: ended.value.endedAt,
      summary: 'Nothing new.',
    });
    expect(s.tables.jobRuns.get(run.id)).toEqual(ended.value);

    // The next run covers from the previous run's start.
    const next = s.start1('2026-10-02T09:00:00.000Z');
    expect(next.coversFrom).toBe(run.startedAt);
    s.conforms();
  });

  it('cuts the summary on lastRun to 500 characters', () => {
    const s = setup();
    const run = s.start1();
    const long = 'x'.repeat(900);
    const ended = s.cmd((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'findings', summary: long }),
    );
    expect(ended.summary).toBe(long);
    expect(jobOf(s, s.job.id).lastRun?.summary).toHaveLength(500);
    s.conforms();
  });

  it('refuses a second run while one is running, a run of a paused job, and ending twice', () => {
    const s = setup();
    const run = s.start1();
    expect(s.err(() => s.start1()).code).toBe('conflict');
    s.cmd((ctx) => endJobRun(ctx, { runId: run.id, outcome: 'quiet' }));
    expect(
      s.err(() => s.cmd((ctx) => endJobRun(ctx, { runId: run.id, outcome: 'quiet' }))).code,
    ).toBe('invalid_transition');
    s.cmd((ctx) => setJobState(ctx, { jobId: s.job.id, state: 'paused', by: USER }));
    expect(s.err(() => s.start1()).code).toBe('invalid');
  });

  it('a follow-up run takes its follow-up off the job', () => {
    const s = setup();
    const followUp = { questionId: 'q-send', kind: 'send' as const, text: 'Thanks!' };
    s.cmd((ctx) => {
      const changes = { followUps: [followUp] };
      ctx.tables.jobs.upsert({ ...jobOf(ctx, s.job.id), ...changes, updatedAt: ctx.now });
      ctx.emit({ type: 'job.updated', jobId: s.job.id, changes });
    });
    const run = s.cmd((ctx) =>
      startJobRun(ctx, {
        jobId: s.job.id,
        purpose: 'follow_up',
        dueAt: '2026-10-01T09:00:00.000Z',
        followUp,
      }),
    );
    expect(run.followUp).toEqual(followUp);
    expect(jobOf(s, s.job.id).followUps).toEqual([]);
    s.conforms();
  });

  it('interrupted changes nothing else but makes the job due now', () => {
    const s = setup();
    const run = s.start1();
    const out = s.log.runCommand((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'interrupted' }),
    );
    const job = jobOf(s, s.job.id);
    expect(job.nextRunAt).toBe(out.events[0]!.at);
    expect(job.state).toBe('active');
    expect(job.failureQuestionId).toBeUndefined();
    expect(s.tables.questions.all()).toEqual([]);
    s.conforms();
  });

  it('keeps the last 200 runs of the job', () => {
    const s = setup();
    const ids: Id[] = [];
    s.cmd((ctx) => {
      for (let i = 0; i <= LONG_TERM_LIMITS.runsKept; i++) {
        const run = startJobRun(ctx, {
          jobId: s.job.id,
          purpose: 'scheduled',
          dueAt: '2026-10-01T09:00:00.000Z',
        });
        endJobRun(ctx, { runId: run.id, outcome: 'quiet' });
        ids.push(run.id);
      }
    });
    const kept = s.tables.jobRuns.all().filter((r) => r.jobId === s.job.id);
    expect(kept).toHaveLength(200);
    expect(s.tables.jobRuns.get(ids[0]!)).toBeUndefined();
    expect(s.tables.jobRuns.get(ids.at(-1)!)).toBeDefined();
    expect(jobRuns(s, s.job.id, 500)).toHaveLength(200);
    expect(jobRuns(s, s.job.id)).toHaveLength(20);
    expect(jobRuns(s, s.job.id)[0]!.id).toBe(ids.at(-1));
    s.conforms();
  });
});

describe('a failed run', () => {
  it('pauses the job and opens exactly one failure question held by the user', () => {
    const s = setup();
    const run = s.start1();
    const stew = s.steward();
    s.cmd((ctx) => attachJobRunAgent(ctx, { runId: run.id, agentId: stew.id }));
    s.cmd((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'failed', failureReason: 'no network' }),
    );
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('paused');
    expect(job.pausedReason).toBe('no network');
    const open = s.tables.questions.all().filter((q) => q.status === 'open');
    expect(open).toHaveLength(1);
    const q = open[0]!;
    expect(job.failureQuestionId).toBe(q.id);
    expect(q).toMatchObject({
      kind: 'clarification',
      holder: USER,
      originAgentId: stew.id,
      meta: { jobOwned: true, toUser: true },
    });
    expect(q.context.text).toBe('Read the feedback failed: no network. Tell me when it is fixed.');
    expect(q.context.options).toEqual([...FAILURE_ACTIONS]);
    expect(q.context.jobFailure).toEqual({ jobId: s.job.id, runId: run.id, reason: 'no network' });
    s.conforms();
  });

  it('failing again while the failure question is open opens no other', () => {
    const s = setup();
    const first = s.start1();
    s.cmd((ctx) => endJobRun(ctx, { runId: first.id, outcome: 'failed', failureReason: 'down' }));
    const questionId = jobOf(s, s.job.id).failureQuestionId;
    // Forced: the job active again with its failure question still open.
    s.cmd((ctx) => {
      const changes = { state: 'active' as const };
      ctx.tables.jobs.upsert({ ...jobOf(ctx, s.job.id), ...changes, updatedAt: ctx.now });
      ctx.emit({ type: 'job.updated', jobId: s.job.id, changes });
    });
    const second = s.start1('2026-10-02T09:00:00.000Z');
    s.cmd((ctx) =>
      endJobRun(ctx, { runId: second.id, outcome: 'failed', failureReason: 'still down' }),
    );
    expect(s.tables.questions.all()).toHaveLength(1);
    const job = jobOf(s, s.job.id);
    expect(job.failureQuestionId).toBe(questionId);
    expect(job.state).toBe('paused');
    s.conforms();
  });

  it('the failure question survives its Steward’s end', () => {
    const s = setup();
    const run = s.start1();
    const stew = s.steward();
    s.cmd((ctx) => attachJobRunAgent(ctx, { runId: run.id, agentId: stew.id }));
    s.cmd((ctx) => endJobRun(ctx, { runId: run.id, outcome: 'failed', failureReason: 'x' }));
    const questionId = jobOf(s, s.job.id).failureQuestionId!;
    expect(s.cmd((ctx) => cancelQuestionsOf(ctx, stew.id, 'agent finished'))).toEqual([]);
    s.cmd((ctx) => endAgentQuestions(ctx, stew.id, 'finished', logRouting(s.log)));
    const q = s.tables.questions.get(questionId)!;
    expect(q.status).toBe('open');
    expect(q.holder).toEqual(USER);
    s.conforms();
  });

  it('a run that never got an agent asks through the project’s Waykeeper', () => {
    const s = setup();
    const run = s.start1();
    s.cmd((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'failed', failureReason: 'over budget' }),
    );
    const q = s.tables.questions.get(jobOf(s, s.job.id).failureQuestionId!)!;
    expect(q.originAgentId).toBe(s.agents.wk!.id);
    expect(q.holder).toEqual(USER);
  });

  it('without a Waykeeper, asks through the Harmonizer', () => {
    const s = setup({ waykeeper: false });
    const run = s.start1();
    s.cmd((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'failed', failureReason: 'no Waykeeper' }),
    );
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('paused');
    expect(job.pausedReason).toBe('no Waykeeper');
    const q = s.tables.questions.get(job.failureQuestionId!)!;
    expect(q.originAgentId).toBe(s.agents.hq!.id);
    expect(q.holder).toEqual(USER);
    expect(q.meta).toEqual({ jobOwned: true, toUser: true });
    s.conforms();
  });

  it('without any agent row at all, still pauses and says so', () => {
    const s = setup({ harmonizer: false });
    const run = s.start1();
    s.cmd((ctx) =>
      endJobRun(ctx, { runId: run.id, outcome: 'failed', failureReason: 'no Waykeeper' }),
    );
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('paused');
    expect(job.failureQuestionId).toBeUndefined();
    expect(job.pausedReason).toMatch(/^no Waykeeper/);
    expect(job.pausedReason).toMatch(/could not be asked/);
    expect(s.tables.questions.all()).toEqual([]);
    s.conforms();
  });

  it('a failure of a job stopped meanwhile leaves it stopped, with no question', () => {
    const s = setup();
    const run = s.start1();
    s.cmd((ctx) => setJobState(ctx, { jobId: s.job.id, state: 'stopped', by: USER }));
    s.cmd((ctx) => endJobRun(ctx, { runId: run.id, outcome: 'failed', failureReason: 'x' }));
    expect(jobOf(s, s.job.id).state).toBe('stopped');
    expect(s.tables.questions.all()).toEqual([]);
    s.conforms();
  });
});

describe('jobMemory', () => {
  it('lists ended runs newest first with what was done with their findings', () => {
    const s = setup();
    const stew = s.steward();
    const first = s.start1();
    s.cmd((ctx) => {
      openQuestion(ctx, {
        id: 'q-f1',
        kind: 'clarification',
        originAgentId: stew.id,
        context: {
          text: 'Add dark mode?',
          finding: { jobId: s.job.id, runId: first.id, kind: 'suggestion', title: 'Dark mode' },
        },
      });
      openQuestion(ctx, {
        id: 'q-f2',
        kind: 'clarification',
        originAgentId: stew.id,
        context: {
          text: 'Reply to Ann?',
          finding: { jobId: s.job.id, runId: first.id, kind: 'reply', title: 'Reply to Ann' },
        },
      });
      endJobRun(ctx, { runId: first.id, outcome: 'findings', summary: 'Two reviews.' });
      answerQuestion(ctx, { questionId: 'q-f1', answer: 'Create a ticket', answeredBy: USER });
    });
    const second = s.start1('2026-10-02T09:00:00.000Z');
    s.cmd((ctx) => endJobRun(ctx, { runId: second.id, outcome: 'quiet', summary: 'Nothing.' }));
    s.start1('2026-10-03T09:00:00.000Z'); // running: not memory yet

    const memory = jobMemory(s, s.job.id);
    expect(memory).toHaveLength(2);
    expect(memory[0]).toMatch(/^\d{4}-\d{2}-\d{2} quiet: Nothing\.$/);
    expect(memory[1]).toMatch(
      /^\d{4}-\d{2}-\d{2} findings: Two reviews\. — findings: Dark mode → Create a ticket; Reply to Ann → open$/,
    );
    expect(jobMemory(s, s.job.id, 1)).toEqual([memory[0]]);
  });
});

describe('runPurpose', () => {
  it('is catch_up when due more than two ticks before it starts', () => {
    const due = new Date('2026-10-01T09:00:00.000Z');
    const at = (ms: number) => new Date(due.getTime() + ms);
    expect(JOB_TICK_MS).toBe(60_000);
    expect(runPurpose(due, at(3 * 60_000))).toBe('catch_up');
    expect(runPurpose(due, at(60_000))).toBe('scheduled');
    expect(runPurpose(due, at(2 * JOB_TICK_MS))).toBe('scheduled');
  });
});
