import type { Actor, ModelChoice, Question } from '@galactic/protocol';
import { DomainError } from './errors.js';
import type { CommandContext } from './event-log.js';
import { writeJob } from './jobs.js';

/**
 * The domain side of a usage-limit question (P11-07, SPEC decision 148): its answer's checks and
 * what the answer records in the answer's own transaction, so a restart finds it. The question is
 * opened and carried out by `runtime/usage-limits.ts` (and the job scheduler for a job run).
 *
 * The question's `meta` keeps the choice and its progress:
 *   - `switchTo` — the model the user chose (`Switch to …`): a task's new Steward runs it, a job's
 *     next run alone uses it (`JobScheduler.startIfDue`);
 *   - `retryAt` — when a wait retries (`Wait until it resets`): the reported reset time, else an
 *     hour after the answer;
 *   - `switchedAt` / `retriedAt` — when the switch or the retry was carried out (once only).
 */

/** How long a wait waits when the CLI reported no reset time. */
export const LIMIT_RETRY_MS = 60 * 60_000;

export const LIMIT_META = {
  switchTo: 'switchTo',
  retryAt: 'retryAt',
  switchedAt: 'switchedAt',
  retriedAt: 'retriedAt',
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
    throw new DomainError(
      'invalid',
      `answer the usage limit with one of: ${options.join(', ')} — not "${answer}"`,
    );
  }
}

/**
 * In the answer's transaction: a switch records `meta.switchTo` and makes a job due now (its next
 * run starts on the chosen model); a wait records `meta.retryAt`.
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
  const job = ctx.tables.jobs.get(limit.jobId);
  if (job?.state === 'active' && job.limitQuestionId === q.id) {
    writeJob(ctx, job, { nextRunAt: ctx.now });
  }
}
