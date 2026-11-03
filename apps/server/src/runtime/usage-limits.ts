import { randomUUID } from 'node:crypto';
import {
  LIMIT_WAIT,
  isJobTask,
  jobIdOfTask,
  limitSwitchOption,
  modelChoiceLabel,
  type Agent,
  type Event,
  type EventEnvelope,
  type Id,
  type JobRun,
  type ModelChoice,
  type ModelInfo,
  type Provider,
  type Question,
  type Task,
  type UsageLimitContext,
} from '@galactic/protocol';
import { stewardPrompt } from '../brains/steward-prompt.js';
import type { Commands } from '../domain/commands.js';
import type { CommandContext, EventLog } from '../domain/event-log.js';
import { jobOf, writeJob } from '../domain/jobs.js';
import { originOf } from '../domain/question-service.js';
import { openQuestion } from '../domain/questions.js';
import { LIMIT_META, LIMIT_RETRY_MS, storedSwitchOf } from '../domain/usage-limits.js';
import type { Timers } from './archival.js';
import type { RunLimits } from './job-scheduler.js';
import type { ProviderCatalog } from './provider-catalog.js';
import { providerOf, stewardChooser, type ChooseSteward } from './steward-choice.js';
import { stewardDeclares } from './tool-runtimes.js';

/**
 * Usage limits (P11-07, plan Task 8; SPEC decision 148; TECHNOLOGY §3.5). When a Steward's
 * provider stops it at the subscription's limit (`agent.failed{reason: 'limit', resetsAt}` from
 * any adapter), its step pauses — never fails — and the user gets ONE inbox question: switch to
 * another model that can do the step, or wait until the limit resets. Nothing switches without
 * the user's answer (Global Constraints).
 *
 *   - **The question** (`kind: 'clarification'`, held by the user from the start, `meta.toUser`,
 *     job-owned for a job run): "<label> usage limit reached — resets <time>. Switch to another
 *     model or wait?", `context.usageLimit` with the models it may switch to — from every
 *     available provider, each passing `ProviderCatalog.check` for the step's `makesImages` and
 *     `publishes`, none of a provider whose `usage()` shows a window at 0, never the model that
 *     stopped, at most 12 — and the options `Switch to <label>` per model, then `Wait until it
 *     resets`. A second limit on the same task or job while one is open opens nothing.
 *   - **Switch**: a task gets `task.updated{provider, model}` and a new Steward on the task under
 *     the stopped Steward's supervisor, its prompt the task's Steward prompt led by a handover; a
 *     job's next run alone uses the chosen model (the job scheduler reads `meta.switchTo`).
 *   - **Wait**: at `meta.retryAt` (the reset, else an hour after the answer) `tick()` resumes the
 *     stopped session where its runtime can (`resume`), else starts a Steward as for a switch on
 *     the same model; a job's `limitQuestionId` is cleared and the job is due now.
 *
 * Every choice and its progress live on the question row (`domain/usage-limits.ts`), so `tick()`
 * — every `tickMs` and once at start — carries out what a restart interrupted, never twice.
 * Brains never answer the question (`answer_question` refuses it, `checkLimitAnswer`).
 */

export interface UsageLimitsOptions {
  log: EventLog;
  commands: Pick<Commands, 'spawnAgent' | 'updateTask'>;
  catalog: Pick<ProviderCatalog, 'available' | 'models' | 'usage' | 'check' | 'defaultModel'>;
  /**
   * Reopens a Steward its limit stopped, from its saved session, with `prompt` as its next
   * message (`AgentRuntime.resumeAfterLimit`). Absent, or `ok: false`: a new Steward is started.
   */
  resume?: (agentId: Id, prompt: string) => Promise<{ ok: boolean }>;
  /** The runtime and model a new Steward runs (dev override, a fake brain); default the resolver. */
  chooseSteward?: ChooseSteward;
  /** Default: the log's clock, in ms. */
  now?: () => number;
  /** How often waits are checked (default 60 s); `0`: no timer (tests call `tick()`). */
  tickMs?: number;
  timers?: Timers;
  onError?: (error: unknown, context: string) => void;
}

/** At most this many models are offered (`UsageLimitContext.switchTo`). */
const MAX_SWITCH = 12;
const PROVIDERS: readonly Provider[] = ['claude', 'chatgpt', 'gemini'];
const DONE_TASK = new Set<Task['state']>(['completed', 'archived', 'moved', 'failed']);

/** A resumed session's first message after the reset. */
export const RESUME_AFTER_LIMIT_PROMPT =
  'Your usage limit has reset. Continue the task from where you stopped.';

const NODE_TIMERS: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.(); // never keeps the process alive
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

type AgentFailedEvent = Extract<Event, { type: 'agent.failed' }>;

const sameChoice = (a: ModelChoice, b: ModelChoice) =>
  a.provider === b.provider && a.model === b.model;

export class UsageLimits implements RunLimits {
  private readonly now: () => number;
  private readonly choose: ChooseSteward;
  private readonly unsubscribe: () => void;
  private readonly handle: unknown;
  private readonly timers: Timers;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly opts: UsageLimitsOptions) {
    this.now = opts.now ?? (() => Date.parse(opts.log.clock()));
    this.choose = opts.chooseSteward ?? stewardChooser();
    this.timers = opts.timers ?? NODE_TIMERS;
    this.unsubscribe = opts.log.subscribe((envelope: EventEnvelope) =>
      this.onEvent(envelope.event),
    );
    const tickMs = opts.tickMs ?? 60_000;
    this.handle =
      tickMs > 0
        ? this.timers.setInterval(() => void this.tick().catch(this.report('tick')), tickMs)
        : undefined;
    // Once at start: a wait whose reset passed while Mission Control was down is retried now.
    void this.tick().catch(this.report('tick'));
  }

  /** A Steward's limit (a task's: a job run's goes through the scheduler) or a limit's answer. */
  onEvent(event: Event): void {
    if (this.disposed) return;
    if (event.type === 'agent.failed' && event.reason === 'limit') {
      const agent = this.opts.log.tables.agents.get(event.agentId);
      const task = agent?.taskId ? this.opts.log.tables.tasks.get(agent.taskId) : undefined;
      // A job run's limit is asked by the scheduler, in its queue (`askForRun`).
      if (agent?.role !== 'steward' || !task || isJobTask(task)) return;
      void this.enqueue(() => this.ask(agent, task, event));
      return;
    }
    if (event.type === 'question.answered') {
      const q = this.opts.log.tables.questions.get(event.questionId);
      if (q?.context.usageLimit) void this.enqueue(() => this.carryOut(q.id));
    }
  }

  /** The scheduler's hook: a job run stopped by its limit asks the user (and blocks the job). */
  async askForRun(failed: AgentFailedEvent, run: JobRun): Promise<void> {
    const agent = this.opts.log.tables.agents.get(failed.agentId);
    const task = agent?.taskId ? this.opts.log.tables.tasks.get(agent.taskId) : undefined;
    if (!agent || !task) return;
    await this.ask(agent, task, failed, run).catch(this.report(`limit of run ${run.id}`));
  }

  /** Carries out every answered limit question that is due and not done yet. */
  tick(): Promise<void> {
    return this.enqueue(async () => {
      const due = this.opts.log.tables.questions
        .all()
        .filter((q) => q.context.usageLimit && q.status === 'answered');
      for (const q of due) await this.carryOut(q.id);
    });
  }

  /** Resolves once everything queued so far is done (tests). */
  settled(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.handle !== undefined) this.timers.clearInterval(this.handle);
    this.unsubscribe();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(() => (this.disposed ? undefined : fn()));
    this.chain = next.catch(this.report('usage limits'));
    return next;
  }

  private report(context: string): (error: unknown) => void {
    return (error) => this.opts.onError?.(error, context);
  }

  // -- the question ------------------------------------------------------------------------------

  private async ask(
    agent: Agent,
    task: Task,
    failed: AgentFailedEvent,
    run?: JobRun,
  ): Promise<void> {
    const { tables } = this.opts.log;
    const jobId = jobIdOfTask(task);
    const job = jobId ? tables.jobs.get(jobId) : undefined;
    if (this.openFor(task.id, job?.limitQuestionId)) return;
    const meta = (agent.meta ?? {}) as { provider?: unknown; model?: unknown };
    const provider =
      (typeof meta.provider === 'string' ? (meta.provider as Provider) : undefined) ??
      providerOf(agent.runtime) ??
      job?.provider ??
      task.provider ??
      'claude';
    const model =
      typeof meta.model === 'string' && meta.model
        ? meta.model
        : (job?.model ?? task.model ?? (await this.opts.catalog.defaultModel(provider)));
    const stopped: ModelChoice = { provider, ...(model ? { model } : {}) };
    const lists = new Map<Provider, ModelInfo[]>();
    const modelsOf = async (p: Provider) => {
      if (!lists.has(p)) lists.set(p, await this.opts.catalog.models(p));
      return lists.get(p)!;
    };
    const switchTo = await this.eligible(
      stopped,
      {
        images: task.makesImages === true,
        publishes: task.publishes === true || run?.followUp?.kind === 'publish',
      },
      modelsOf,
    );
    const label = modelChoiceLabel(stopped, await modelsOf(provider));
    const options = [
      ...(await Promise.all(
        switchTo.map(async (c) => limitSwitchOption(c, await modelsOf(c.provider))),
      )),
      LIMIT_WAIT,
    ];
    const usageLimit: UsageLimitContext = {
      provider,
      ...(model ? { model } : {}),
      ...(failed.resetsAt ? { resetsAt: failed.resetsAt } : {}),
      taskId: task.id,
      ...(job ? { jobId: job.id } : {}),
      ...(run ? { runId: run.id } : {}),
      switchTo,
    };
    this.opts.log.runCommand((ctx) => {
      // Asked meanwhile (the catalogue took a while): still one question.
      const current = job ? jobOf(ctx, job.id) : undefined;
      if (this.openFor(task.id, current?.limitQuestionId)) return;
      const question = openQuestion(ctx, {
        id: `q-${randomUUID()}`,
        kind: 'clarification',
        originAgentId: agent.id,
        holder: { type: 'user' },
        context: {
          text: `${label} usage limit reached${failed.resetsAt ? ` — resets ${failed.resetsAt}` : ''}. Switch to another model or wait?`,
          options,
          usageLimit,
          origin: originOf(ctx, agent.id, { recentEvents: () => [] }),
        },
        meta: { toUser: true, jobOwned: job !== undefined },
      });
      if (current && current.state !== 'stopped') {
        writeJob(ctx, current, { limitQuestionId: question.id });
      }
    });
  }

  /** Whether a limit question of this task (or the job's) is still open. */
  private openFor(taskId: Id, jobQuestionId: Id | undefined): boolean {
    const { questions } = this.opts.log.tables;
    if (jobQuestionId && questions.get(jobQuestionId)?.status === 'open') return true;
    return questions
      .all()
      .some((q) => q.status === 'open' && q.context.usageLimit?.taskId === taskId);
  }

  /**
   * The models the step may switch to: each listed model of every available provider (the
   * provider's default when it lists none) that passes the catalogue's check for the step, from
   * no provider out of limit, never the stopped one; at most `MAX_SWITCH`.
   */
  private async eligible(
    stopped: ModelChoice,
    need: { images: boolean; publishes: boolean },
    modelsOf: (p: Provider) => Promise<ModelInfo[]>,
  ): Promise<ModelChoice[]> {
    const out: ModelChoice[] = [];
    for (const provider of PROVIDERS) {
      if (out.length >= MAX_SWITCH) break;
      if (!this.opts.catalog.available(provider)) continue;
      const usage = await this.opts.catalog.usage(provider);
      if (usage?.windows.some((w) => w.remainingFraction <= 0)) continue;
      const models = await modelsOf(provider);
      const candidates: ModelChoice[] =
        models.length > 0 ? models.map((m) => ({ provider, model: m.id })) : [{ provider }];
      for (const candidate of candidates) {
        if (out.length >= MAX_SWITCH) break;
        if (sameChoice(candidate, stopped)) continue;
        const checked = await this.opts.catalog.check(candidate, need);
        if (checked.ok && !out.some((c) => sameChoice(c, checked.choice))) out.push(checked.choice);
      }
    }
    return out;
  }

  // -- the answer --------------------------------------------------------------------------------

  private async carryOut(questionId: Id): Promise<void> {
    const { tables } = this.opts.log;
    const q = tables.questions.get(questionId);
    const limit = q?.context.usageLimit;
    if (!q || !limit || q.status !== 'answered') return;
    const switchTo = storedSwitchOf(q);
    if (switchTo) {
      // A job's switch is read by the scheduler when it starts the next run.
      if (limit.jobId || q.meta?.[LIMIT_META.switchedAt] !== undefined) return;
      await this.restart(q, switchTo, true);
      return;
    }
    if (q.answer !== LIMIT_WAIT || q.meta?.[LIMIT_META.retriedAt] !== undefined) return;
    const stored = q.meta?.[LIMIT_META.retryAt];
    const retryAt =
      typeof stored === 'string'
        ? Date.parse(stored)
        : Date.parse(limit.resetsAt ?? q.updatedAt) + (limit.resetsAt ? 0 : LIMIT_RETRY_MS);
    if (retryAt > this.now()) return;
    if (limit.jobId) {
      const jobId = limit.jobId;
      this.opts.log.runCommand((ctx) => {
        this.mark(ctx.tables.questions.get(questionId) ?? q, LIMIT_META.retriedAt, ctx.now, ctx);
        const job = ctx.tables.jobs.get(jobId);
        if (!job || job.limitQuestionId !== questionId) return;
        writeJob(ctx, job, {
          limitQuestionId: null,
          ...(job.state === 'active' ? { nextRunAt: ctx.now } : {}),
        });
      });
      return;
    }
    const resumed = await this.opts.resume?.(q.originAgentId, RESUME_AFTER_LIMIT_PROMPT);
    if (resumed?.ok) {
      this.markDone(questionId, LIMIT_META.retriedAt);
      return;
    }
    await this.restart(
      q,
      { provider: limit.provider, ...(limit.model ? { model: limit.model } : {}) },
      false,
    );
  }

  /**
   * A new Steward on the task, on `choice`, under the stopped Steward's supervisor, with the
   * task's Steward prompt led by the handover. A switch first records the task's new provider.
   * Marked done once spawned; a refusal (a cap, a budget) is tried again at the next tick.
   */
  private async restart(q: Question, choice: ModelChoice, switched: boolean): Promise<void> {
    const { tables } = this.opts.log;
    const limit = q.context.usageLimit!;
    const doneKey = switched ? LIMIT_META.switchedAt : LIMIT_META.retriedAt;
    const task = limit.taskId ? tables.tasks.get(limit.taskId) : undefined;
    const previous = tables.agents.get(q.originAgentId);
    if (!task || !previous || DONE_TASK.has(task.state)) {
      this.markDone(q.id, doneKey);
      return;
    }
    if (switched) {
      await this.opts.commands.updateTask(task.id, {
        provider: choice.provider,
        model: choice.model ?? null,
      });
    }
    const project = task.projectId ? tables.projects.get(task.projectId) : undefined;
    const supervisor = previous.supervisorId ? tables.agents.get(previous.supervisorId) : undefined;
    const steward = this.choose({
      task: { provider: choice.provider, ...(choice.model ? { model: choice.model } : {}) },
      ...(project ? { project } : {}),
      supervisorRuntime: supervisor?.runtime,
    });
    const cwd = (previous.meta as { cwd?: unknown } | undefined)?.cwd;
    const where =
      task.worktreePath ?? project?.workspace ?? (typeof cwd === 'string' ? cwd : undefined);
    if (!where) {
      this.markDone(q.id, doneKey);
      return;
    }
    const stoppedLabel = modelChoiceLabel(
      { provider: limit.provider, ...(limit.model ? { model: limit.model } : {}) },
      await this.opts.catalog.models(limit.provider),
    );
    const [progress] = this.opts.log.latestOf('agent.progress', previous.id, 1);
    const lastReport = progress?.event.type === 'agent.progress' ? progress.event.summary : 'none';
    const instructions = task.meta?.['stewardInstructions'];
    const prompt = stewardPrompt({
      task,
      ...(project ? { project } : {}),
      supervisor: supervisor?.role === 'harmonizer' ? 'harmonizer' : 'waykeeper',
      cwd: where,
      ...(task.branch ? { branch: task.branch } : {}),
      serialised: project !== undefined && task.worktreePath === undefined,
      lead: `An earlier attempt on ${stoppedLabel} stopped at its usage limit. Its work so far is in this folder; its last report: ${lastReport}. Continue from there.`,
      ...(typeof instructions === 'string' ? { instructions } : {}),
      ...(project ? { related: tables.tasks.all().filter((t) => t.projectId === project.id) } : {}),
      declares: stewardDeclares(steward.runtime),
    });
    try {
      await this.opts.commands.spawnAgent({
        role: 'steward',
        runtime: steward.runtime,
        ...(steward.model ? { model: steward.model } : {}),
        taskId: task.id,
        ...(previous.supervisorId ? { supervisorId: previous.supervisorId } : {}),
        // Only a standalone task outside a worktree names its folder (`spawnAgent`).
        ...(!project && !task.worktreePath && typeof cwd === 'string' ? { cwd } : {}),
        prompt,
      });
    } catch (error) {
      // Someone already put a Steward back on the task (its Waykeeper, the user): nothing to do.
      if (/already has a running Steward/.test((error as Error).message)) {
        this.markDone(q.id, doneKey);
        return;
      }
      this.report(`steward after the limit of ${task.id}`)(error);
      return;
    }
    this.markDone(q.id, doneKey);
  }

  private markDone(questionId: Id, key: string): void {
    this.opts.log.runCommand((ctx) => {
      const q = ctx.tables.questions.get(questionId);
      if (q) this.mark(q, key, ctx.now, ctx);
    });
  }

  /** Records on the question that its switch or retry was carried out (no event: meta only). */
  private mark(q: Question, key: string, at: string, ctx: CommandContext): void {
    ctx.tables.questions.upsert({ ...q, meta: { ...q.meta, [key]: at } });
  }
}
