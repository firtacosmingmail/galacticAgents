import { randomUUID } from 'node:crypto';
import {
  FAILURE_ACTIONS,
  FINDING_ACTIONS,
  FindingContext,
  LONG_TERM_LIMITS,
  SPEND_ACTIONS,
  SpendContext,
  answerDetailOf,
  isJobOwned,
  jobIdOfTask,
  type Agent,
  type FollowUp,
  type Id,
  type Job,
  type JobRun,
  type OpenFindingInput,
  type Question,
  type QuestionContext,
  type ReportJobRunInput,
  type RequestSpendInput,
} from '@galactic/protocol';
import type { Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { jobOf, setJobState, writeJob } from './jobs.js';
import { originOf, type QuestionRouting } from './question-service.js';
import { COMMAND_SOURCE, openQuestion } from './questions.js';
import { FINISHED_WORK } from './states.js';
import { createTask } from './tasks.js';

/**
 * Findings and spend approvals (P10-05, plan Task 7; SPEC decisions 144, 145). A job run's
 * finding (a suggested feature, a drafted reply) and a job run's spend are **job-owned questions**:
 * held by the user from the start (`meta.toUser`, decision 30), owned by the job (`meta.jobOwned`),
 * so they outlive the run's Steward and wake no brain. A task Steward's spend is held by the user
 * too, but belongs to its Steward. Answering a job-owned question carries out its action in the
 * answer's own transaction (`applyJobAnswer`, called by `answerQuestion`): a proposed ticket, the
 * one system message that wakes the Waykeeper ("Implement it"), a follow-up queued on the job, a
 * retry or a stop. An action the project's close or the job's stop made impossible is refused
 * with a clear message and the question stays open; "Drop" and "Refuse" always work.
 */

const USER = { type: 'user' } as const;

/** The exact answer that retries a failed job without a note for the retry run. */
const RETRY_NOW: string = FAILURE_ACTIONS[0];
const STOP_JOB: string = FAILURE_ACTIONS[1];

/** `job.meta.retryNote`: what the user wrote when answering the failure question. */
export const RETRY_NOTE = 'retryNote';

/** "Three reviews ask for it" from "Three reviews ask for it." — the template adds the stop. */
const sentence = (text: string): string => text.trim().replace(/[.\s]+$/, '');

function runOf(ctx: Reader, runId: Id): JobRun {
  return must(ctx.tables.jobRuns.get(runId), 'job run', runId);
}

/**
 * Whether `agent` is the Steward of `run`: the run's recorded agent, or (before the scheduler
 * records it) an agent on the job's hidden task.
 */
function isRunSteward(agent: Agent, run: JobRun, job: Job): boolean {
  return run.agentId !== undefined ? run.agentId === agent.id : agent.taskId === job.taskId;
}

/** The job, refused when it was stopped: a stopped job's run brings nothing more to the user. */
function unstoppedJob(ctx: Reader, jobId: Id, what: string): Job {
  const job = jobOf(ctx, jobId);
  if (job.state === 'stopped') {
    throw new DomainError('invalid', `job ${job.name} is stopped; ${what}`);
  }
  return job;
}

/** Where the question comes from, for its card: the asker's role, task, project and body. */
function originContext(
  ctx: CommandContext,
  agentId: Id,
  routing?: Pick<QuestionRouting, 'recentEvents'>,
): QuestionContext['origin'] {
  return originOf(ctx, agentId, routing ?? { recentEvents: () => [] });
}

/**
 * A job run's finding, brought to the user as a job-owned question with the finding's fixed
 * actions (`FINDING_ACTIONS[kind]`). Only the run's Steward reports it; a reply carries its draft
 * (which the user may edit before "Send"), a suggestion none. Refused for a stopped job.
 */
export function openFinding(
  ctx: CommandContext,
  input: OpenFindingInput,
  routing?: Pick<QuestionRouting, 'recentEvents'>,
): Question {
  const run = runOf(ctx, input.runId);
  const job = unstoppedJob(ctx, run.jobId, 'its findings are not brought to the user');
  const agent = must(ctx.tables.agents.get(input.originAgentId), 'agent', input.originAgentId);
  if (!isRunSteward(agent, run, job)) {
    throw new DomainError('invalid', `agent ${agent.id} is not the Steward of job run ${run.id}`);
  }
  const text = input.text?.trim() ?? '';
  if (!text) throw new DomainError('invalid', 'a finding needs a text');
  if (input.kind === 'reply' && !input.draft?.trim()) {
    throw new DomainError('invalid', 'a reply finding needs the drafted reply (draft)');
  }
  if (input.kind === 'suggestion' && input.draft !== undefined) {
    throw new DomainError('invalid', 'only a reply finding carries a draft');
  }
  if (findingsOf(ctx, run.id) >= LONG_TERM_LIMITS.maxFindingsPerRun) {
    throw new DomainError(
      'invalid',
      `a run reports at most ${LONG_TERM_LIMITS.maxFindingsPerRun} findings; keep the most useful ones`,
    );
  }
  const finding = FindingContext.safeParse({
    jobId: job.id,
    runId: run.id,
    kind: input.kind,
    title: input.title?.trim(),
    ...(input.kind === 'reply' ? { draft: input.draft } : {}),
  });
  if (!finding.success) {
    throw new DomainError(
      'invalid',
      `invalid finding: ${finding.error.issues[0]?.path.join('.')} ${finding.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  return openQuestion(ctx, {
    id: `q-${randomUUID()}`,
    kind: 'clarification',
    originAgentId: agent.id,
    holder: USER,
    context: {
      text,
      options: [...FINDING_ACTIONS[input.kind]],
      finding: finding.data,
      origin: originContext(ctx, agent.id, routing),
    },
    meta: { jobOwned: true, toUser: true },
  });
}

/**
 * The job run a spend belongs to: the one `runId` names (its Steward must be the asker), else the
 * running run of the job whose hidden task the asker works on — a job-run Steward's spend is
 * always job-owned. `undefined` for any other agent (a task Steward's spend).
 */
function spendRun(ctx: Reader, agent: Agent, runId: Id | undefined): JobRun | undefined {
  if (runId !== undefined) {
    const run = runOf(ctx, runId);
    if (!isRunSteward(agent, run, jobOf(ctx, run.jobId))) {
      throw new DomainError('invalid', `agent ${agent.id} is not the Steward of job run ${run.id}`);
    }
    return run;
  }
  const task = agent.taskId ? ctx.tables.tasks.get(agent.taskId) : undefined;
  const jobId = task ? jobIdOfTask(task) : undefined;
  if (!jobId) return undefined;
  const job = jobOf(ctx, jobId);
  const running = job.runningRunId ? ctx.tables.jobRuns.get(job.runningRunId) : undefined;
  if (!running || !isRunSteward(agent, running, job)) {
    throw new DomainError('invalid', `agent ${agent.id} has no run of job ${job.name} going`);
  }
  return running;
}

/** "$20.00" / "€5.00": the amount as the card shows it. */
export function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/**
 * A `spend` question (SPEC decision 145): real money is always the user's distinct, explicit
 * approval. Held by the user, whatever the asker's supervisors; answered `Approve` / `Refuse`
 * only. Job-owned (`context.spend.jobId`, `meta.jobOwned`) when the asker is a job run's Steward.
 * Refused: a non-positive or non-finite amount, a currency that is not three letters, a purpose
 * that is blank or over 500 characters, a run the asker is not the Steward of, a stopped job.
 */
export function requestSpend(
  ctx: CommandContext,
  input: RequestSpendInput,
  routing?: Pick<QuestionRouting, 'recentEvents'>,
): Question {
  const agent = must(ctx.tables.agents.get(input.originAgentId), 'agent', input.originAgentId);
  if (typeof input.amount !== 'number' || !Number.isFinite(input.amount) || input.amount <= 0) {
    throw new DomainError('invalid', 'a spend needs a positive amount');
  }
  const currency = (input.currency ?? 'USD').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new DomainError('invalid', `"${input.currency}" is not a three-letter currency code`);
  }
  const run = spendRun(ctx, agent, input.runId);
  if (run) unstoppedJob(ctx, run.jobId, 'it spends nothing more');
  const spend = SpendContext.safeParse({
    amount: input.amount,
    currency,
    purpose: input.purpose?.trim(),
    ...(run ? { jobId: run.jobId, runId: run.id } : {}),
  });
  if (!spend.success) {
    throw new DomainError(
      'invalid',
      `invalid spend: ${spend.error.issues[0]?.path.join('.')} ${spend.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  const { amount, purpose } = spend.data;
  return openQuestion(ctx, {
    id: `q-${randomUUID()}`,
    kind: 'spend',
    originAgentId: agent.id,
    holder: USER,
    context: {
      text: `Spend ${formatAmount(amount, currency)}: ${purpose}`,
      options: [...SPEND_ACTIONS],
      spend: spend.data,
      origin: originContext(ctx, agent.id, routing),
    },
    // Nobody's session waits on it: a task Steward hears the answer as a message (Task 9).
    meta: {
      source: COMMAND_SOURCE,
      toUser: true,
      ...(run ? { jobOwned: true } : {}),
    },
  });
}

/** How many findings the run reported (every one, whatever became of it). */
function findingsOf(ctx: Reader, runId: Id): number {
  return ctx.tables.questions.all().filter((q) => q.context.finding?.runId === runId).length;
}

/**
 * Keeps what the run's Steward reported (`report_run`) on its running run as `meta.report`
 * (ledger ruling R3): the scheduler's turn-end handler ends the run with it. A later report
 * replaces an earlier one. A run row is REST-only history, so this writes no event (as
 * `attachJobRunAgent`). Refused: a run that ended, an agent that is not its Steward, an outcome
 * `findings` with no finding reported, a blank or long summary, `numbers` beyond 30 keys or with a
 * key outside 1–60 characters or a value that is not a finite number, a failure reason on an
 * outcome other than `failed`.
 */
export function reportJobRun(ctx: CommandContext, input: ReportJobRunInput): JobRun {
  const run = runOf(ctx, input.runId);
  if (run.outcome !== 'running') {
    throw new DomainError('invalid_transition', `job run ${run.id} already ended (${run.outcome})`);
  }
  const agent = must(ctx.tables.agents.get(input.agentId), 'agent', input.agentId);
  if (!isRunSteward(agent, run, jobOf(ctx, run.jobId))) {
    throw new DomainError('invalid', `agent ${agent.id} is not the Steward of job run ${run.id}`);
  }
  const { outcome, numbers } = input.report;
  if (outcome !== 'quiet' && outcome !== 'findings' && outcome !== 'failed') {
    throw new DomainError('invalid', 'the outcome is quiet, findings or failed');
  }
  if (outcome === 'findings' && findingsOf(ctx, run.id) === 0) {
    throw new DomainError(
      'invalid',
      'outcome findings needs at least one finding reported with report_finding first',
    );
  }
  const summary = typeof input.report.summary === 'string' ? input.report.summary.trim() : '';
  if (!summary) throw new DomainError('invalid', 'a run report needs a summary');
  if (summary.length > LONG_TERM_LIMITS.maxRunSummary) {
    throw new DomainError(
      'invalid',
      `the summary is longer than ${LONG_TERM_LIMITS.maxRunSummary} characters`,
    );
  }
  const failureReason = input.report.failureReason?.trim();
  if (failureReason && outcome !== 'failed') {
    throw new DomainError('invalid', 'only a failed run carries a failure reason');
  }
  if (failureReason && failureReason.length > LONG_TERM_LIMITS.maxRunFailureReason) {
    throw new DomainError(
      'invalid',
      `the failure reason is longer than ${LONG_TERM_LIMITS.maxRunFailureReason} characters`,
    );
  }
  if (numbers !== undefined) {
    if (!numbers || typeof numbers !== 'object' || Array.isArray(numbers)) {
      throw new DomainError('invalid', 'numbers maps names to numbers');
    }
    const entries = Object.entries(numbers);
    if (entries.length > LONG_TERM_LIMITS.maxRunNumbers) {
      throw new DomainError(
        'invalid',
        `a run reports at most ${LONG_TERM_LIMITS.maxRunNumbers} numbers`,
      );
    }
    for (const [key, value] of entries) {
      if (key.length < 1 || key.length > LONG_TERM_LIMITS.maxRunNumberKey) {
        throw new DomainError(
          'invalid',
          `a number's name is 1–${LONG_TERM_LIMITS.maxRunNumberKey} characters ("${key.slice(0, 80)}")`,
        );
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new DomainError('invalid', `number "${key}" is not a finite number`);
      }
    }
  }
  const report = {
    outcome,
    summary,
    ...(numbers !== undefined ? { numbers: { ...numbers } } : {}),
    ...(failureReason ? { failureReason } : {}),
  };
  return ctx.tables.jobRuns.upsert({ ...run, meta: { ...(run.meta ?? {}), report } });
}

/** The project of the finding's job, refused when it was closed (completed, failed, archived). */
function openProjectOf(ctx: Reader, job: Job) {
  const project = must(ctx.tables.projects.get(job.projectId), 'project', job.projectId);
  if (FINISHED_WORK.has(project.state)) {
    throw new DomainError('invalid', 'the project is closed; the suggestion was not filed');
  }
  return project;
}

/**
 * The Waykeeper "Implement it" writes to: the project's living Waykeeper when `isLiving` knows one,
 * else its latest row (an ended brain reads the message when it is resumed or respawned).
 */
function waykeeperOf(
  ctx: Reader,
  projectId: Id,
  isLiving?: (agentId: Id) => boolean,
): Agent | undefined {
  const latest = (rows: Agent[]) =>
    rows.reduce<Agent | undefined>(
      (best, a) => (!best || a.createdAt >= best.createdAt ? a : best),
      undefined,
    );
  const rows = ctx.tables.agents
    .all()
    .filter((a) => a.role === 'waykeeper' && a.projectId === projectId);
  return latest(isLiving ? rows.filter((a) => isLiving(a.id)) : []) ?? latest(rows);
}

function queueFollowUp(ctx: CommandContext, job: Job, followUp: FollowUp): void {
  writeJob(ctx, job, { followUps: [...job.followUps, followUp] });
}

/** A finding's action: a proposed ticket, a message to the Waykeeper, a queued reply, or nothing. */
function applyFinding(ctx: CommandContext, q: Question, opts: JobAnswerOptions): void {
  const finding = q.context.finding!;
  const job = jobOf(ctx, finding.jobId);
  switch (q.answer) {
    case 'Create a ticket': {
      const project = openProjectOf(ctx, job);
      createTask(ctx, {
        projectId: project.id,
        description: finding.title,
        state: 'proposed',
        meta: { fromFinding: q.id },
      });
      return;
    }
    case 'Implement it': {
      const project = openProjectOf(ctx, job);
      const waykeeper = waykeeperOf(ctx, project.id, opts.isLiving);
      if (!waykeeper) {
        throw new DomainError(
          'invalid',
          `project ${project.name} has no Waykeeper to plan it; create a ticket instead`,
        );
      }
      ctx.emit({
        type: 'message.sent',
        messageId: `m-${randomUUID()}`,
        agentId: waykeeper.id,
        sender: { type: 'system' },
        text:
          `Cosmin wants this implemented (from ${job.name}): ${sentence(finding.title)} — ` +
          `${sentence(q.context.text)}. Plan it as a task and propose it.`,
        interrupt: false,
        fromFinding: q.id,
      });
      return;
    }
    case 'Send': {
      if (job.state === 'stopped') {
        throw new DomainError('invalid', 'the job is stopped; the reply was not sent');
      }
      const edited = answerDetailOf(q)?.text?.trim();
      const text = edited || finding.draft || '';
      queueFollowUp(ctx, job, { questionId: q.id, kind: 'send', text });
      return;
    }
    default:
      // "Drop": recorded only.
      return;
  }
}

/** A job spend's answer: "Approve" queues the follow-up that carries it out; "Refuse" nothing. */
function applySpend(ctx: CommandContext, q: Question): void {
  const spend = q.context.spend!;
  if (q.answer !== 'Approve' || !spend.jobId) return;
  const job = jobOf(ctx, spend.jobId);
  if (job.state === 'stopped') {
    throw new DomainError('invalid', 'the job is stopped; the spend was not approved');
  }
  queueFollowUp(ctx, job, {
    questionId: q.id,
    kind: 'spend',
    amount: spend.amount,
    currency: spend.currency,
    purpose: spend.purpose,
  });
}

/**
 * The failure question's answer: "Stop the job" stops it; any other answer makes the paused job
 * active and due now, the text (unless it is exactly "Fixed — retry now") kept for the retry run
 * as `job.meta.retryNote`. Runs after the answer is recorded, so reactivating finds the question
 * answered and leaves it so (never cancelled). A job no longer paused is left as it is.
 */
function applyFailure(ctx: CommandContext, q: Question): void {
  const job = jobOf(ctx, q.context.jobFailure!.jobId);
  const by = q.answeredBy ?? USER;
  if (q.answer === STOP_JOB) {
    if (job.state !== 'stopped') setJobState(ctx, { jobId: job.id, state: 'stopped', by });
    return;
  }
  if (job.state !== 'paused') return;
  const active = setJobState(ctx, { jobId: job.id, state: 'active', by });
  const note = q.answer?.trim() ?? '';
  const { [RETRY_NOTE]: previous, ...rest } = active.meta ?? {};
  const keep = note !== '' && note !== RETRY_NOW;
  if (keep ? previous === note : previous === undefined) return;
  writeJob(ctx, active, { meta: keep ? { ...rest, [RETRY_NOTE]: note } : rest });
}

/**
 * Carries out the action of a job-owned question `q` just answered, in the answer's transaction
 * (a refusal rolls the answer back with it). A task Steward's spend is not job-owned: its answer
 * is recorded only.
 */
export interface JobAnswerOptions {
  /** Whether an agent still runs (the question routing's): "Implement it" prefers a living Waykeeper. */
  isLiving?: ((agentId: Id) => boolean) | undefined;
}

export function applyJobAnswer(
  ctx: CommandContext,
  q: Question,
  opts: JobAnswerOptions = {},
): void {
  if (!isJobOwned(q) || q.status !== 'answered') return;
  if (q.context.finding) applyFinding(ctx, q, opts);
  else if (q.context.jobFailure) applyFailure(ctx, q);
  else if (q.kind === 'spend') applySpend(ctx, q);
}
