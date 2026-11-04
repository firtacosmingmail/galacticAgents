import { z } from 'zod';
import type { Project, Proposal, Question, Task } from './domain.js';
import { PermissionRule } from './domain.js';
import { RequestOrigin } from './enums.js';
import { LONG_TERM_LIMITS, PublishContext } from './long-term-questions.js';
import { Provider } from './providers.js';
import { Id, Meta, Timestamp } from './primitives.js';

/**
 * Long-term projects, area moons and recurring jobs (P10-01; SPEC decisions 142–145). A long-term
 * project lives on a planet with moons; each moon hosts one or more of its business **areas**
 * (body host `{kind: 'areas', id: projectId}`); each area holds recurring **jobs** that Mission
 * Control runs on a schedule as Stewards on the job's hidden task (`task.meta.jobId`). Findings,
 * failure notices and job spends are **job-owned questions** (`isJobOwned`).
 */

export {
  FindingContext,
  JobFailureContext,
  LONG_TERM_LIMITS,
  PublishContext,
  PublishFile,
  PUBLISH_ACTIONS,
  publishFingerprint,
  SpendContext,
} from './long-term-questions.js';

/** A planet is "big" when it has at least this many catalogued, non-reserved moons. */
export const BIG_PLANET_MIN_MOONS = 4;

/** `HH:MM`, 24-hour, in the Mac's local time zone. */
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time is HH:MM, 00:00–23:59');

/** ISO weekday: 1 = Monday … 7 = Sunday. */
const IsoWeekday = z.number().int().min(1).max(7);

/**
 * When a job runs. `weekdays` is Monday–Friday; `weekly.days` are 1–7 distinct ISO weekdays; a
 * `monthly.day` past the month's end runs on the month's last day.
 */
export const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), at: ClockTime }),
  z.object({ kind: z.literal('weekdays'), at: ClockTime }),
  z.object({
    kind: z.literal('weekly'),
    days: z
      .array(IsoWeekday)
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, 'each day once'),
    at: ClockTime,
  }),
  z.object({ kind: z.literal('monthly'), day: z.number().int().min(1).max(31), at: ClockTime }),
]);
export type Schedule = z.infer<typeof Schedule>;

/** `paused`: after a failure, until the user answers its failure question. */
export const JobState = z.enum(['active', 'paused', 'stopped']);
export type JobState = z.infer<typeof JobState>;

/**
 * An unattended rule: what a job's run Stewards may do without asking, on top of the project's
 * policy and rules — shaped like an "Allow similar" rule, scoped to the one job. Never a push,
 * never over a `deny`, never a spend. Its `label` is computed by the server from what it matches
 * (never the proposer's words), and `origin` is where the approval that granted it came from (a
 * remote one needs `autoApproveRemote`, decision 138; absent on rules granted before it was kept).
 */
export const JobRule = PermissionRule.pick({
  id: true,
  scope: true,
  tool: true,
  match: true,
  categories: true,
  label: true,
}).extend({ origin: RequestOrigin.optional() });
export type JobRule = z.infer<typeof JobRule>;

/** `running` until the run ends; `interrupted` when Mission Control stopped mid-run. */
export const JobRunOutcome = z.enum([
  'running',
  'quiet',
  'findings',
  'failed',
  'interrupted',
  'limited',
]);
export type JobRunOutcome = z.infer<typeof JobRunOutcome>;

/**
 * Why a run started: on time, late (`catch_up`: due more than two ticks before it started), after
 * a failure was fixed (`retry`), or to carry out an approved send or spend (`follow_up`).
 */
export const JobRunPurpose = z.enum(['scheduled', 'catch_up', 'retry', 'follow_up']);
export type JobRunPurpose = z.infer<typeof JobRunPurpose>;

/** An approved send or spend, queued on its job until a follow-up run carries it out. */
export const FollowUp = z.object({
  /** The finding or spend question it was approved on. */
  questionId: Id,
  kind: z.enum(['send', 'spend', 'publish']),
  /** A send's reply text (as the user edited it). */
  text: z.string().optional(),
  amount: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  purpose: z.string().optional(),
  /** A publish's approved request (P11-02). */
  publish: PublishContext.optional(),
});
export type FollowUp = z.infer<typeof FollowUp>;

/** A job's latest run, kept on the job row (its `summary` cut to 500 characters). */
export const JobRunBrief = z.object({
  runId: Id,
  outcome: JobRunOutcome,
  purpose: JobRunPurpose,
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  summary: z.string().max(500).optional(),
});
export type JobRunBrief = z.infer<typeof JobRunBrief>;

/** A business area of a long-term project, living on a moon of its planet (`bodyId`). */
export const Area = z.object({
  id: Id,
  projectId: Id,
  name: z.string().min(1).max(LONG_TERM_LIMITS.maxAreaName),
  bodyId: Id,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Area = z.infer<typeof Area>;

/** A recurring job of an area. Every run is a Steward on its hidden task (`taskId`). */
export const Job = z.object({
  id: Id,
  projectId: Id,
  areaId: Id,
  /** The job's hidden task (`task.meta.jobId`), on its area's moon. */
  taskId: Id,
  name: z.string().min(1).max(LONG_TERM_LIMITS.maxJobName),
  instructions: z.string().min(1).max(LONG_TERM_LIMITS.maxInstructions),
  schedule: Schedule,
  /** The AI provider the job's runs use. */
  provider: Provider.default('claude'),
  /** The exact model asked for; absent: the provider's default model. */
  model: z.string().optional(),
  /** The provider for approved follow-up runs (sends, spends, publishes); absent: `provider`. */
  followUpProvider: Provider.optional(),
  followUpModel: z.string().optional(),
  /** The open usage-limit question of a job whose run hit its limit. */
  limitQuestionId: Id.optional(),
  unattendedRules: z.array(JobRule).max(LONG_TERM_LIMITS.maxUnattendedRules),
  state: JobState,
  pausedReason: z.string().optional(),
  /** The open failure question of a paused job. */
  failureQuestionId: Id.optional(),
  /** Absent for a stopped job. */
  nextRunAt: Timestamp.optional(),
  lastRun: JobRunBrief.optional(),
  /** The run going on now; one run per job at a time. */
  runningRunId: Id.optional(),
  /** Approved sends and spends waiting for a follow-up run, oldest first. */
  followUps: z.array(FollowUp).default([]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Job = z.infer<typeof Job>;

/** One run of a job. Kept per job: the last `LONG_TERM_LIMITS.runsKept`. */
export const JobRun = z.object({
  id: Id,
  jobId: Id,
  /** The run's Steward, once spawned. */
  agentId: Id.optional(),
  purpose: JobRunPurpose,
  dueAt: Timestamp,
  /** A catch-up run covers from the previous run's start (or the job's creation) to now. */
  coversFrom: Timestamp.optional(),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  outcome: JobRunOutcome,
  summary: z.string().optional(),
  /** Named numbers the run reported (kept for the dashboard, project 3). */
  numbers: z.record(z.string(), z.number()).optional(),
  followUp: FollowUp.optional(),
  /** What the user wrote when answering the failure question (a retry run). */
  note: z.string().optional(),
  meta: Meta.optional(),
});
export type JobRun = z.infer<typeof JobRun>;

/**
 * What a job card proposes and `createJob` / `updateJob` take. The rules' `id`s are assigned on
 * approval, so a draft's rules may come without one; a rule's `label` is the server's (a given one
 * is replaced) and its `origin` is never taken from a draft.
 */
export const JobDraft = Job.pick({
  name: true,
  instructions: true,
  schedule: true,
  provider: true,
  model: true,
  followUpProvider: true,
  followUpModel: true,
  limitQuestionId: true,
}).extend({
  unattendedRules: z
    .array(
      JobRule.omit({ origin: true }).extend({ id: Id.optional(), label: z.string().optional() }),
    )
    .max(LONG_TERM_LIMITS.maxUnattendedRules)
    .default([]),
});
export type JobDraft = z.infer<typeof JobDraft>;

/** The fixed answers of a finding question, by finding kind. */
export const FINDING_ACTIONS = {
  suggestion: ['Create a ticket', 'Implement it', 'Drop'],
  reply: ['Send', 'Drop'],
} as const;
/** The fixed answers of a job's failure question. */
export const FAILURE_ACTIONS = ['Fixed — retry now', 'Stop the job'] as const;
/** The fixed answers of a `spend` question. */
export const SPEND_ACTIONS = ['Approve', 'Refuse'] as const;

/**
 * Whether a question belongs to a job rather than to the agent that asked it: a finding, a failure
 * notice, or a spend a job's run asked for. Job-owned questions outlive their run's Steward and
 * never wake a brain.
 */
export function isJobOwned(q: Pick<Question, 'kind' | 'context'>): boolean {
  if (q.context.finding || q.context.jobFailure) return true;
  if (q.context.usageLimit?.jobId !== undefined) return true;
  if (q.kind === 'publish' && q.context.publish?.jobId) return true;
  return q.kind === 'spend' && q.context.spend?.jobId !== undefined;
}

/** The job whose hidden task this is (`meta.jobId`), if any. */
export function jobIdOfTask(t: Pick<Task, 'meta'>): Id | undefined {
  const jobId = t.meta?.['jobId'];
  return typeof jobId === 'string' ? jobId : undefined;
}

/** Whether a task is a job's hidden task. */
export function isJobTask(t: Pick<Task, 'meta'>): boolean {
  return jobIdOfTask(t) !== undefined;
}

export function isLongTerm(p: Pick<Project, 'longTerm'>): boolean {
  return p.longTerm === true;
}

/**
 * A Waykeeper's job card (`Proposal.meta.job`): create a job (in an existing area by id, or a new
 * one by name), change one, or stop one.
 */
export const ProposalJob = z.object({
  projectId: Id,
  /** The Waykeeper that proposed; it owns the card like a plan card. */
  waykeeperId: Id,
  action: z.enum(['create', 'change', 'stop']),
  /** The job a change or stop is about. */
  jobId: Id.optional(),
  /** A new job (`create`), or the job as the change leaves it (`change`). */
  draft: JobDraft.optional(),
  /** `create`: the area it goes to; `change`: the area it moves to, when it moves. */
  area: z.union([z.object({ areaId: Id }), z.object({ name: z.string().min(1) })]).optional(),
  /**
   * The moon (body id) the job lives on once the card is carried out: an existing area's moon, or
   * — for a new area — the moon one would take when the card was made (a preview: the approval
   * chooses again and may differ if the planet's moons changed meanwhile).
   */
  moonId: Id.optional(),
  /** `change` and `stop`: the job as it was when proposed, so the card shows before → after. */
  before: z.object({ draft: JobDraft, areaId: Id }).optional(),
});
export type ProposalJob = z.infer<typeof ProposalJob>;

/** The job card a proposal carries, when it is one. */
export function proposalJobOf(
  proposal: Pick<Proposal, 'meta'> | undefined,
): ProposalJob | undefined {
  const parsed = ProposalJob.safeParse(proposal?.meta?.['job']);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A long-term card (`Proposal.meta.longTerm`): a new long-term project (no `projectId`), or an
 * existing project made long-term.
 */
export const ProposalLongTerm = z.object({
  projectId: Id.optional(),
  purpose: z.string().min(1).max(LONG_TERM_LIMITS.maxPurpose),
  goals: z.array(z.string().min(1).max(LONG_TERM_LIMITS.maxGoal)).max(LONG_TERM_LIMITS.maxGoals),
});
export type ProposalLongTerm = z.infer<typeof ProposalLongTerm>;

/** The long-term card a proposal carries, when it is one. */
export function proposalLongTermOf(
  proposal: Pick<Proposal, 'meta'> | undefined,
): ProposalLongTerm | undefined {
  const parsed = ProposalLongTerm.safeParse(proposal?.meta?.['longTerm']);
  return parsed.success ? parsed.data : undefined;
}
