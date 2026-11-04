import type { Actor, FollowUp, Id, JobRun, ModelChoice, Question } from '@galactic/protocol';
import { DomainError } from './errors.js';
import type { CommandContext } from './event-log.js';
import { writeJob } from './jobs.js';
import { cancelQuestion } from './questions.js';

/**
 * The domain side of a usage-limit question (P11-07, SPEC decision 148): its answer's checks and
 * what the answer records in the answer's own transaction, so a restart finds it. The question is
 * opened and carried out by `runtime/usage-limits.ts` (and the job scheduler for a job run).
 *
 * The question's `meta` keeps the choice and its progress:
 *   - `switchTo` — the model the user chose (`Switch to …`): a task's new Steward runs it, a job's
 *     retry of the limited run alone uses it (`switchAppliesTo`, `JobScheduler.startIfDue`);
 *   - `retryAt` — when a wait retries (`Wait until it resets`): the reported reset time, else an
 *     hour after the answer;
 *   - `switchedAt` / `retriedAt` — when the switch or the retry was carried out (once only);
 *   - `limitRestartFailed` — why no Steward could be restarted (the task failed, ruling R18).
 */

/** How long a wait waits when the CLI reported no reset time. */
export const LIMIT_RETRY_MS = 60 * 60_000;

export const LIMIT_META = {
  switchTo: 'switchTo',
  retryAt: 'retryAt',
  switchedAt: 'switchedAt',
  retriedAt: 'retriedAt',
  /** Why the Steward could not be restarted (on the question and the task, ruling R18). */
  restartFailed: 'limitRestartFailed',
} as const;

/** The model a `Switch to …` answer chose: the option's position in `switchTo`. */
export function limitSwitchOf(
  q: Pick<Question, 'context'>,
  answer: string | undefined,
): ModelChoice | undefined {
  const limit = q.context.usageLimit;
  if (!limit || answer === undefined) return undefined;
  const i = (q.context.options ?? []).indexOf(answer);
  return i >= 0 && i < limit.switchTo.length ? limit.switchTo[i] : undefined;
}

/** The choice stored on an answered question (`meta.switchTo`), if it was a switch. */
export function storedSwitchOf(q: Pick<Question, 'meta'>): ModelChoice | undefined {
  const stored = q.meta?.[LIMIT_META.switchTo] as ModelChoice | undefined;
  return stored && typeof stored === 'object' && typeof stored.provider === 'string'
    ? stored
    : undefined;
}

/**
 * Nothing switches without the user (Global Constraints): a usage-limit question is answered by
 * the user alone, with one of its options — never by an agent, a supervisor or the system.
 */
export function checkLimitAnswer(question: Question, answer: string, by: Actor): void {
  if (!question.context.usageLimit) return;
  if (by.type !== 'user') {
    throw new DomainError(
      'invalid',
      `question ${question.id} is a usage limit: the user chooses whether to switch or wait`,
    );
  }
  const options = question.context.options ?? [];
  if (!options.includes(answer)) {
    throw new DomainError('invalid', `Answer with one of: ${options.join(', ')} — not "${answer}"`);
  }
}

/**
 * In the answer's transaction: a switch records `meta.switchTo` and makes a job due now (its next
 * run starts on the chosen model); a wait records `meta.retryAt`. A limited follow-up run (M3,
 * M4) leaves the job's schedule alone: its switch waits for that follow-up to run again
 * (`switchAppliesTo`), and an ordinary run never starts early because of it.
 */
export function applyLimitAnswer(ctx: CommandContext, q: Question): void {
  const limit = q.context.usageLimit;
  if (!limit || q.status !== 'answered') return;
  const choice = limitSwitchOf(q, q.answer);
  const retryAt = limit.resetsAt ?? new Date(Date.parse(ctx.now) + LIMIT_RETRY_MS).toISOString();
  ctx.tables.questions.upsert({
    ...q,
    meta: {
      ...q.meta,
      ...(choice ? { [LIMIT_META.switchTo]: choice } : { [LIMIT_META.retryAt]: retryAt }),
    },
  });
  if (!choice || !limit.jobId) return;
  if (limitedFollowUpOf(ctx.tables, q)) return;
  const job = ctx.tables.jobs.get(limit.jobId);
  if (job?.state === 'active' && job.limitQuestionId === q.id) {
    writeJob(ctx, job, { nextRunAt: ctx.now });
  }
}

interface LimitTables {
  jobRuns: { get(id: Id): JobRun | undefined };
  questions: { get(id: Id): Question | undefined };
}

/** The follow-up the limited job run carried (undefined: an ordinary run, or no run recorded). */
export function limitedFollowUpOf(tables: LimitTables, q: Question): FollowUp | undefined {
  const runId = q.context.usageLimit?.runId;
  return runId ? tables.jobRuns.get(runId)?.followUp : undefined;
}

/**
 * Whether a job run about to start (carrying `next`, or none: an ordinary run) is the one the
 * limit's switch was chosen for (M4): the retry of the limited run. A limited ordinary run's
 * switch goes to the next ordinary run; a limited follow-up's to the run of that same follow-up —
 * the same question, or for a publish the fresh question that re-asked it (ruling R13,
 * `meta.reaskOf`). A question without a recorded run applies to the next run, as before.
 */
export function switchAppliesTo(
  tables: LimitTables,
  q: Question,
  next: FollowUp | undefined,
): boolean {
  const runId = q.context.usageLimit?.runId;
  const run = runId ? tables.jobRuns.get(runId) : undefined;
  if (!run) return true;
  const limited = run.followUp;
  if (!limited) return next === undefined;
  if (!next) return false;
  if (next.questionId === limited.questionId) return true;
  return tables.questions.get(next.questionId)?.meta?.['reaskOf'] === limited.questionId;
}

/**
 * Withdraws the open usage-limit questions of a task that finished (closed, archived, failed,
 * moved) or of a job that stopped, in the caller's transaction: `question.cancelled` with the
 * reason, so a late answer is refused like any withdrawn question's. A paused task or job keeps
 * its question.
 */
export function withdrawLimitQuestions(
  ctx: CommandContext,
  of: { taskId: Id } | { jobId: Id },
  reason: string,
): void {
  for (const q of ctx.tables.questions.all()) {
    const limit = q.context.usageLimit;
    if (q.status !== 'open' || !limit) continue;
    const match = 'taskId' in of ? limit.taskId === of.taskId : limit.jobId === of.jobId;
    if (match) cancelQuestion(ctx, q.id, reason);
  }
}
