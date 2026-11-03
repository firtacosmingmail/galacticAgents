import { describe, expect, it } from 'vitest';
import {
  BIG_PLANET_MIN_MOONS,
  FAILURE_ACTIONS,
  FINDING_ACTIONS,
  isJobOwned,
  isJobTask,
  isLongTerm,
  Job,
  JobDraft,
  JobRunOutcome,
  jobIdOfTask,
  LONG_TERM_LIMITS,
  proposalJobOf,
  proposalLongTermOf,
  Schedule,
  SPEND_ACTIONS,
  SpendContext,
} from './long-term.js';
import { Project, QuestionContext } from './domain.js';
import { JobChanges, ProjectChanges } from './events.js';
import * as d from './fixtures/domain.js';

const ok = (s: unknown) => Schedule.safeParse(s).success;

describe('Schedule', () => {
  it('accepts the four kinds', () => {
    expect(ok({ kind: 'daily', at: '09:00' })).toBe(true);
    expect(ok({ kind: 'weekdays', at: '23:59' })).toBe(true);
    expect(ok({ kind: 'weekly', days: [1, 4], at: '09:00' })).toBe(true);
    expect(ok({ kind: 'weekly', days: [1, 2, 3, 4, 5, 6, 7], at: '00:00' })).toBe(true);
    expect(ok({ kind: 'monthly', day: 31, at: '09:00' })).toBe(true);
  });

  it('refuses empty, repeated and out-of-range days and malformed times', () => {
    expect(ok({ kind: 'weekly', days: [], at: '09:00' })).toBe(false);
    expect(ok({ kind: 'weekly', days: [1, 1], at: '09:00' })).toBe(false);
    expect(ok({ kind: 'weekly', days: [8], at: '09:00' })).toBe(false);
    expect(ok({ kind: 'weekly', days: [0], at: '09:00' })).toBe(false);
    expect(ok({ kind: 'daily', at: '24:00' })).toBe(false);
    expect(ok({ kind: 'daily', at: '9:00' })).toBe(false);
    expect(ok({ kind: 'daily', at: '09:60' })).toBe(false);
    expect(ok({ kind: 'monthly', day: 32, at: '09:00' })).toBe(false);
    expect(ok({ kind: 'monthly', day: 0, at: '09:00' })).toBe(false);
    expect(ok({ kind: 'hourly', at: '09:00' })).toBe(false);
  });
});

describe('Job', () => {
  it('defaults the provider to claude and follow-ups to none', () => {
    const { provider: _provider, followUps: _followUps, ...bare } = d.job;
    const job = Job.parse(bare);
    expect(job.provider).toBe('claude');
    expect(job.followUps).toEqual([]);
  });

  it('refuses more than the rule limit', () => {
    const rule = d.job.unattendedRules[0]!;
    const rules = (n: number) => Array.from({ length: n }, (_, i) => ({ ...rule, id: `r-${i}` }));
    expect(Job.safeParse({ ...d.job, unattendedRules: rules(10) }).success).toBe(true);
    expect(Job.safeParse({ ...d.job, unattendedRules: rules(11) }).success).toBe(false);
    expect(LONG_TERM_LIMITS.maxUnattendedRules).toBe(10);
  });

  it('keeps names and instructions within the limits', () => {
    expect(Job.safeParse({ ...d.job, name: '' }).success).toBe(false);
    expect(Job.safeParse({ ...d.job, name: 'x'.repeat(81) }).success).toBe(false);
    expect(Job.safeParse({ ...d.job, instructions: 'x'.repeat(8001) }).success).toBe(false);
  });

  it('a draft lets the server assign rule ids', () => {
    const { id: _id, ...rule } = d.job.unattendedRules[0]!;
    const draft = JobDraft.parse({
      name: 'Read feedback',
      instructions: 'Read the new feedback.',
      schedule: { kind: 'daily', at: '09:00' },
      unattendedRules: [rule],
    });
    expect(draft.provider).toBe('claude');
    expect(draft.unattendedRules[0]?.id).toBeUndefined();
  });

  it('a job.updated change never fills defaults it did not carry', () => {
    expect(JobChanges.parse({ state: 'paused' })).toEqual({ state: 'paused' });
  });
});

describe('job-owned questions', () => {
  const clarification = { kind: 'clarification' as const, context: { text: 'Which?' } };
  it('owns findings, failure notices and job spends', () => {
    expect(
      isJobOwned({
        kind: 'clarification',
        context: {
          text: 'A finding',
          finding: { jobId: 'j-1', runId: 'jr-1', kind: 'suggestion', title: 'Dark mode' },
        },
      }),
    ).toBe(true);
    expect(
      isJobOwned({
        kind: 'clarification',
        context: { text: 'Failed', jobFailure: { jobId: 'j-1', runId: 'jr-1', reason: 'x' } },
      }),
    ).toBe(true);
    const spend = SpendContext.parse({ amount: 20, purpose: 'an ad', jobId: 'j-1' });
    expect(isJobOwned({ kind: 'spend', context: { text: 'Spend?', spend } })).toBe(true);
  });

  it('owns a job publish, a job usage-limit question, and parses the limited outcome', () => {
    const publish = {
      platform: 'LinkedIn',
      account: '@app',
      text: 'Hi',
      files: [],
      fingerprint: 'a'.repeat(64),
      jobId: 'j-1',
    };
    expect(isJobOwned({ kind: 'publish', context: { text: 'Publish?', publish } })).toBe(true);
    expect(
      isJobOwned({
        kind: 'publish',
        context: { text: 'Publish?', publish: { ...publish, jobId: undefined } },
      }),
    ).toBe(false);
    expect(
      isJobOwned({
        kind: 'clarification',
        context: {
          text: 'Limit',
          usageLimit: { provider: 'claude', jobId: 'j-1', switchTo: [{ provider: 'chatgpt' }] },
        },
      }),
    ).toBe(true);
    expect(JobRunOutcome.parse('limited')).toBe('limited');
  });

  it('does not own a task spend or a plain clarification', () => {
    const spend = SpendContext.parse({ amount: 20, purpose: 'an ad' });
    expect(spend.currency).toBe('USD');
    expect(isJobOwned({ kind: 'spend', context: { text: 'Spend?', spend } })).toBe(false);
    expect(isJobOwned(clarification)).toBe(false);
  });

  it('question contexts carry the new parts', () => {
    const context = {
      text: 'Spend?',
      spend: { amount: 1250, currency: 'EUR', purpose: 'ads', jobId: 'j-1', runId: 'jr-1' },
    };
    expect(QuestionContext.parse(context)).toEqual(context);
    expect(
      QuestionContext.safeParse({ text: 'x', spend: { amount: 0, purpose: 'x' } }).success,
    ).toBe(false);
  });

  it('fixes the action texts', () => {
    expect(FINDING_ACTIONS.suggestion).toEqual(['Create a ticket', 'Implement it', 'Drop']);
    expect(FINDING_ACTIONS.reply).toEqual(['Send', 'Drop']);
    expect(FAILURE_ACTIONS).toEqual(['Fixed — retry now', 'Stop the job']);
    expect(SPEND_ACTIONS).toEqual(['Approve', 'Refuse']);
  });
});

describe('job tasks and long-term projects', () => {
  it('reads a job task from its meta', () => {
    expect(isJobTask({ meta: { jobId: 'j-1' } })).toBe(true);
    expect(isJobTask({})).toBe(false);
    expect(isJobTask({ meta: { jobId: 7 } })).toBe(false);
    expect(jobIdOfTask({ meta: { jobId: 'j-1' } })).toBe('j-1');
    expect(jobIdOfTask({})).toBeUndefined();
  });

  it('a project is long-term only when it says so', () => {
    expect(isLongTerm({ longTerm: true })).toBe(true);
    expect(isLongTerm({})).toBe(false);
    const project = {
      ...d.project,
      longTerm: true,
      purpose: 'Look after the app',
      goals: ['1k users'],
    };
    expect(Project.parse(project)).toEqual(project);
    expect(Project.safeParse({ ...project, goals: Array(11).fill('g') }).success).toBe(false);
    expect(Project.safeParse({ ...project, purpose: '' }).success).toBe(false);
    expect(ProjectChanges.parse({ longTerm: true, purpose: 'p', goals: [] })).toEqual({
      longTerm: true,
      purpose: 'p',
      goals: [],
    });
  });

  it('names the big-planet threshold', () => {
    expect(BIG_PLANET_MIN_MOONS).toBe(4);
  });
});

describe('proposal meta readers', () => {
  it('reads a job card', () => {
    const job = {
      projectId: 'p-1',
      waykeeperId: 'a-wk',
      action: 'create',
      draft: {
        name: 'Read feedback',
        instructions: 'Read it.',
        schedule: { kind: 'daily', at: '09:00' },
        provider: 'claude',
        unattendedRules: [],
      },
      area: { name: 'Feedback' },
    };
    expect(proposalJobOf({ meta: { job } })).toEqual(job);
    expect(proposalJobOf({ meta: { job: { ...job, action: 'pause' } } })).toBeUndefined();
    expect(proposalJobOf({ meta: {} })).toBeUndefined();
    expect(proposalJobOf(undefined)).toBeUndefined();
  });

  it('reads a long-term card, with or without a project', () => {
    const longTerm = { purpose: 'Look after it', goals: ['grow'] };
    expect(proposalLongTermOf({ meta: { longTerm } })).toEqual(longTerm);
    expect(proposalLongTermOf({ meta: { longTerm: { ...longTerm, projectId: 'p-1' } } })).toEqual({
      ...longTerm,
      projectId: 'p-1',
    });
    expect(proposalLongTermOf({ meta: { longTerm: { goals: [] } } })).toBeUndefined();
  });
});
