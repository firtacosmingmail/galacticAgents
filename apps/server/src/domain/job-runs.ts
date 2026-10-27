import { randomUUID } from 'node:crypto';
import {
  FAILURE_ACTIONS,
  LONG_TERM_LIMITS,
  type Agent,
  type AttachJobRunAgentInput,
  type EndJobRunInput,
  type Id,
  type Job,
  type JobChanges,
  type JobRun,
  type JobRunBrief,
  type StartJobRunInput,
} from '@galactic/protocol';
import type { Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { jobOf, writeJob } from './jobs.js';
import { originOf } from './question-service.js';
import { openQuestion } from './questions.js';

/**
 * Job runs (P10-04, plan Task 6; SPEC decision 144). A run is one Steward run of a job's hidden
 * task: `startJobRun` records it (`job_run.started`, the job's `runningRunId`), `endJobRun` ends it
 * (`job_run.ended`, the job's `lastRun`) and keeps the job's last `LONG_TERM_LIMITS.runsKept` runs.
 * A failed run pauses its job and opens **one** failure question, held by the user from the start
 * and owned by the job (`meta.jobOwned`, `context.jobFailure`): it outlives the run's Steward and
 * wakes no brain. Run rows are REST-only history (`job_run.*` fold to nothing); the job row changes
 * through `job.updated` in the same command, stamped with `ctx.now`, so the fold builds the same
 * row. The scheduler (plan Task 8) decides when to call these.
 */

/** The scheduler's tick (plan Global Constraints). */
export const JOB_TICK_MS = 60_000;

/** The `lastRun.summary` limit on the job row (`JobRunBrief`). */
const BRIEF_SUMMARY_MAX = 500;
/** How many runs `jobRuns` lists by default, and how many memory lines `jobMemory` gives. */
const DEFAULT_RUNS = 20;
const DEFAULT_MEMORY = 10;

/**
 * Why a run that was due at `dueAt` and starts at `startedAt` runs: `catch_up` when it is more
 * than two ticks late (the Mac slept, Mission Control was down), else `scheduled`.
 */
export function runPurpose(dueAt: Date, startedAt: Date): 'scheduled' | 'catch_up' {
  return startedAt.getTime() - dueAt.getTime() > 2 * JOB_TICK_MS ? 'catch_up' : 'scheduled';
}

function runOf(ctx: Reader, runId: Id): JobRun {
  return must(ctx.tables.jobRuns.get(runId), 'job run', runId);
}

/** Every run of the job, newest first (by start; the later row first on a tie). */
function runsOf(ctx: Reader, jobId: Id): JobRun[] {
  return ctx.tables.jobRuns
    .all()
    .filter((r) => r.jobId === jobId)
    .reverse()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The job's runs, newest first: `limit` of them (default 20, at most 200). */
export function jobRuns(ctx: Reader, jobId: Id, limit = DEFAULT_RUNS): JobRun[] {
  const n = Math.min(Math.max(1, Math.floor(limit)), LONG_TERM_LIMITS.runsKept);
  return runsOf(ctx, jobId).slice(0, n);
}

/**
 * Starts a run of an active job: one at a time (`conflict` while one runs), none while the job is
 * paused or stopped (follow-ups wait while paused). The run covers from the previous run's start,
 * or the job's creation. A `follow_up` run carries one of the job's queued follow-ups and takes it
 * off the queue.
 */
export function startJobRun(ctx: CommandContext, input: StartJobRunInput): JobRun {
  const job = jobOf(ctx, input.jobId);
  if (job.runningRunId) {
    throw new DomainError('conflict', `job ${job.name} already has a run going`);
  }
  if (job.state !== 'active') {
    throw new DomainError(
      'invalid',
      `job ${job.name} is ${job.state}; no run starts until it is active`,
    );
  }
  const changes: JobChanges = {};
  if (input.purpose === 'follow_up') {
    const queued = input.followUp
      ? job.followUps.findIndex((f) => f.questionId === input.followUp!.questionId)
      : -1;
    if (queued < 0) {
      throw new DomainError(
        'invalid',
        `a follow-up run carries a follow-up queued on job ${job.name}`,
      );
    }
    changes.followUps = job.followUps.filter((_, i) => i !== queued);
  } else if (input.followUp) {
    throw new DomainError('invalid', 'only a follow-up run carries a follow-up');
  }
  const run: JobRun = {
    id: `jr-${randomUUID()}`,
    jobId: job.id,
    purpose: input.purpose,
    dueAt: input.dueAt,
    coversFrom: job.lastRun?.startedAt ?? job.createdAt,
    startedAt: ctx.now,
    outcome: 'running',
    ...(input.followUp ? { followUp: input.followUp } : {}),
    ...(input.note ? { note: input.note } : {}),
  };
  const inserted = ctx.tables.jobRuns.insert(run);
  ctx.emit({ type: 'job_run.started', run: inserted });
  writeJob(ctx, job, { ...changes, runningRunId: run.id });
  return inserted;
}

/**
 * Records the run's Steward once it is spawned: an agent on the job's hidden task, on a run still
 * going. A run row is REST-only history, so this writes no event (the Steward's own `agent.created`
 * names the task).
 */
export function attachJobRunAgent(ctx: CommandContext, input: AttachJobRunAgentInput): JobRun {
  const run = runOf(ctx, input.runId);
  if (run.outcome !== 'running') {
    throw new DomainError('invalid_transition', `job run ${run.id} already ended (${run.outcome})`);
  }
  if (run.agentId === input.agentId) return run;
  if (run.agentId) {
    throw new DomainError('conflict', `job run ${run.id} already has agent ${run.agentId}`);
  }
  const job = jobOf(ctx, run.jobId);
  const agent = must(ctx.tables.agents.get(input.agentId), 'agent', input.agentId);
  if (agent.taskId !== job.taskId) {
    throw new DomainError('invalid', `agent ${agent.id} does not work on job ${job.name}'s task`);
  }
  return ctx.tables.jobRuns.upsert({ ...run, agentId: agent.id });
}

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/**
 * Ends a running run with its outcome: the run row, `job_run.ended`, and the job's `lastRun`
 * (summary cut to 500 characters) with `runningRunId` cleared; then only the job's last 200 runs
 * are kept. `failed` pauses the job and opens its one failure question (`openFailure`);
 * `interrupted` (a missed run) makes the job due now. A job stopped meanwhile stays stopped.
 */
export function endJobRun(ctx: CommandContext, input: EndJobRunInput): JobRun {
  const current = runOf(ctx, input.runId);
  if (current.outcome !== 'running') {
    throw new DomainError(
      'invalid_transition',
      `job run ${current.id} already ended (${current.outcome})`,
    );
  }
  const run = ctx.tables.jobRuns.upsert({
    ...current,
    outcome: input.outcome,
    endedAt: ctx.now,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.numbers !== undefined ? { numbers: input.numbers } : {}),
  });
  ctx.emit({
    type: 'job_run.ended',
    runId: run.id,
    jobId: run.jobId,
    outcome: input.outcome,
    endedAt: ctx.now,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    ...(input.numbers !== undefined ? { numbers: input.numbers } : {}),
  });

  const job = jobOf(ctx, run.jobId);
  const lastRun: JobRunBrief = {
    runId: run.id,
    outcome: input.outcome,
    purpose: run.purpose,
    startedAt: run.startedAt,
    endedAt: ctx.now,
    ...(run.summary !== undefined ? { summary: cut(run.summary, BRIEF_SUMMARY_MAX) } : {}),
  };
  const changes: JobChanges = { lastRun };
  if (job.runningRunId === run.id) changes.runningRunId = null;
  if (job.state !== 'stopped') {
    if (input.outcome === 'interrupted') changes.nextRunAt = ctx.now;
    if (input.outcome === 'failed') Object.assign(changes, failureChanges(ctx, job, run, input));
  }
  writeJob(ctx, job, changes);
  pruneRuns(ctx, run.jobId);
  return run;
}

/** Deletes the job's runs beyond the newest `LONG_TERM_LIMITS.runsKept`. */
function pruneRuns(ctx: CommandContext, jobId: Id): void {
  for (const old of runsOf(ctx, jobId).slice(LONG_TERM_LIMITS.runsKept)) {
    ctx.tables.jobRuns.delete(old.id);
  }
}

/** "no network" from "no network." — the reason is followed by a full stop in the question. */
const reasonText = (reason: string): string => reason.trim().replace(/[.\s]+$/, '') || 'it failed';

/**
 * What a failed run changes on its job: paused with the reason, and one failure question — unless
 * one is already open, which stays the one. The question's asker (`originAgentId`, a foreign key)
 * is the run's Steward, or the project's Waykeeper when the run never got one; with neither, the
 * job still pauses and its `pausedReason` says the user could not be asked.
 */
function failureChanges(
  ctx: CommandContext,
  job: Job,
  run: JobRun,
  input: EndJobRunInput,
): JobChanges {
  const reason = reasonText(input.failureReason ?? input.summary ?? 'the run failed');
  const changes: JobChanges = { state: 'paused', pausedReason: reason };
  const open = job.failureQuestionId ? ctx.tables.questions.get(job.failureQuestionId) : undefined;
  if (open?.status === 'open') return changes;
  const asker = askerOf(ctx, job, run);
  if (!asker) {
    changes.pausedReason = `${reason} (the failure question could not be asked: the project has no Waykeeper)`;
    return changes;
  }
  const question = openQuestion(ctx, {
    id: `q-${randomUUID()}`,
    kind: 'clarification',
    originAgentId: asker.id,
    holder: { type: 'user' },
    context: {
      text: `${job.name} failed: ${reason}. Tell me when it is fixed.`,
      options: [...FAILURE_ACTIONS],
      jobFailure: { jobId: job.id, runId: run.id, reason },
      // Where it comes from (role, task, project, body); a job's notice carries no recent events.
      origin: originOf(ctx, asker.id, { recentEvents: () => [] }),
    },
    meta: { jobOwned: true },
  });
  changes.failureQuestionId = question.id;
  return changes;
}

/** The run's Steward, else the project's latest Waykeeper row, else none. */
function askerOf(ctx: Reader, job: Job, run: JobRun): Agent | undefined {
  const steward = run.agentId ? ctx.tables.agents.get(run.agentId) : undefined;
  if (steward) return steward;
  return ctx.tables.agents
    .all()
    .filter((a) => a.role === 'waykeeper' && a.projectId === job.projectId)
    .reduce<Agent | undefined>(
      (latest, a) => (!latest || a.createdAt >= latest.createdAt ? a : latest),
      undefined,
    );
}

/** "2026-10-01": a timestamp's day on the Mac's clock (schedules are local too). */
function localDay(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The short run log the next run reads (SPEC "job memory"): the job's last `limit` ended runs
 * (default 10), newest first, one line each — "<day> <outcome>: <summary> — findings: <title> →
 * <answer>; …", where a finding not answered yet reads "open" and one withdrawn "withdrawn".
 */
export function jobMemory(ctx: Reader, jobId: Id, limit = DEFAULT_MEMORY): string[] {
  const runs = runsOf(ctx, jobId)
    .filter((r) => r.outcome !== 'running')
    .slice(0, Math.max(0, Math.floor(limit)));
  if (runs.length === 0) return [];
  const findings = ctx.tables.questions.all().filter((q) => q.context.finding?.jobId === jobId);
  return runs.map((run) => {
    const head = `${localDay(run.startedAt)} ${run.outcome}`;
    const summary = run.summary?.trim();
    const line = summary ? `${head}: ${cut(summary, BRIEF_SUMMARY_MAX)}` : head;
    const answered = findings
      .filter((q) => q.context.finding!.runId === run.id)
      .map((q) => {
        const what =
          q.status === 'answered' ? (q.answer ?? '') : q.status === 'open' ? 'open' : 'withdrawn';
        return `${q.context.finding!.title} → ${what}`;
      });
    return answered.length > 0 ? `${line} — findings: ${answered.join('; ')}` : line;
  });
}
