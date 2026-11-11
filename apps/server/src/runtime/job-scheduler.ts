import {
  LIMIT_WAIT,
  PROVIDER_LABEL,
  isJobTask,
  jobIdOfTask,
  nextOccurrence,
  type Actor,
  type Agent,
  type Event,
  type EventEnvelope,
  type Id,
  type Job,
  type JobChanges,
  type JobRun,
  type JobRunOutcome,
  type RunData,
  type PermissionAction,
} from '@galactic/protocol';
import { jobRunPrompt } from '../brains/job-prompt.js';
import type { Commands } from '../domain/commands.js';
import type { CommandContext, EventLog } from '../domain/event-log.js';
import { RETRY_NOTE } from '../domain/findings.js';
import { JOB_TICK_MS, endJobRun, jobMemory, runPurpose, startJobRun } from '../domain/job-runs.js';
import { jobOf, writeJob } from '../domain/jobs.js';
import { reaskInterruptedPublish } from '../domain/publish.js';
import { FINISHED_WORK } from '../domain/states.js';
import { storedSwitchOf, switchAppliesTo } from '../domain/usage-limits.js';
import type { AgentRuntime, TurnEnd } from './agent-runtime.js';
import type { Timers } from './archival.js';
import type { RunSourceRecorder } from './run-sources.js';
import { stewardChooser, type ChooseSteward } from './steward-choice.js';
import { stewardDeclares } from './tool-runtimes.js';

export { JOB_TICK_MS };

/**
 * The job scheduler (P10-04, plan Task 8; SPEC decision 144): every `JOB_TICK_MS` it starts the
 * runs that are due, each as a Steward on the job's hidden task in the project's workspace,
 * supervised by the project's Waykeeper row (which need not be running). Its work goes through one
 * serialised queue — the tick, `retryNow`, and the handlers of a run's end — so two runs of a job
 * never start at once.
 *
 * A tick, in order:
 *   1. **reconcile** — a run whose Steward is not live (Mission Control restarted, the Steward was
 *      stopped) is recorded `interrupted` (its job is due again at once); a run of a job that is no
 *      longer active (paused, stopped, its project closed) has its Steward stopped and is recorded
 *      `interrupted` too, which never pauses the job nor asks anything; a job whose run row is
 *      gone (an import taken mid-run) has `runningRunId` cleared and, active, is due at once;
 *   2. **due** — each active job of a live project (none of a finished one; a paused project's
 *      jobs wait) without a run, with a queued follow-up or `nextRunAt <= now`,
 *      starts one run (a follow-up first), unless the concurrency caps leave no slot (`waited`:
 *      no run row, the next tick tries again). A spawn the caps still refuse records the run
 *      `interrupted`; a spawn refused for anything else (a budget, no Waykeeper row) `failed`.
 *
 * A run ends outside the tick: the Steward's turn that ended on its own ends it with what the
 * Steward reported (`run.meta.report`, written by `report_run`) or `quiet` with its last text, and
 * the Steward is stopped; a failed Steward fails its run. Job-run Stewards report to no one and
 * wake no one (`steward-reports.ts`, `wake.ts`).
 *
 * A Steward stopped by its provider's usage limit (P11-07, decision 148) ends its run `limited`:
 * the job stays active, nothing pauses, no failure question — `limits.askForRun` opens the one
 * usage-limit question and sets `job.limitQuestionId`, in the same queue, so no run starts in
 * between. While that question is open (or answered "wait" and not yet retried) the job starts no
 * run; answered "switch", the retry of the limited run alone uses the chosen model
 * (`meta.switchTo`, `switchAppliesTo`: the next ordinary run, or the run of the same follow-up or
 * its re-asked publish), and starting it clears `limitQuestionId`; other runs keep the job's own.
 */

/** What one tick did: run ids, except `waited` (job ids: no run row was written). */
export interface JobTickReport {
  started: Id[];
  waited: Id[];
  interrupted: Id[];
  ended: Id[];
}

/** Where a run's usage limit becomes its question (`UsageLimits`, P11-07). */
export interface RunLimits {
  /** Opens the job's usage-limit question and sets `job.limitQuestionId`. */
  askForRun(failed: Extract<Event, { type: 'agent.failed' }>, run: JobRun): Promise<void>;
}

export interface JobSchedulerOptions {
  log: EventLog;
  commands: Commands;
  runtime: AgentRuntime;
  /** The usage-limit questions (P11-07); absent: a limited run asks nothing (tests). */
  limits?: RunLimits;
  /**
   * The provider, runtime and model of a job-run Steward (P11-03): a follow-up's own provider
   * first, then the job's (`resolveStewardChoice`). Default: the resolver without Settings.
   */
  chooseSteward?: ChooseSteward;
  /** Default: the log's clock. */
  now?: () => Date;
  /** What each run used (P15-02), noted by the runtime; absent: runs end with no `sources`. */
  runSources?: RunSourceRecorder;
  timers?: Timers;
  onError: (e: unknown) => void;
}

/** What `report_run` leaves on the run row (ledger ruling R3). */
interface RunReport {
  outcome?: unknown;
  summary?: unknown;
  numbers?: unknown;
  /** The run's tables, lists, calendars, statuses, texts and source problems (P15-02). */
  data?: unknown;
  failureReason?: unknown;
}

const SYSTEM: Actor = { type: 'system' };
/** A run's summary from its last text is cut like `lastRun.summary`. */
const SUMMARY_MAX = 500;
/** The caps' refusals (`CapsEnforcer.canSpawn`): a slot frees later, so the run is tried again. */
const CAP_REFUSAL = /^(concurrency|spawn-rate|Stewards-per-Waykeeper) cap:/;

const ACTION_TEXT: Record<PermissionAction, string> = {
  read_workspace: 'read its workspace',
  edit_workspace: 'edit its workspace',
  run_workspace: 'run a command in its workspace',
  destructive: 'run a destructive command',
  outside_workspace: 'work outside its workspace',
  network: 'use the network',
  push: 'push',
};

const NODE_TIMERS: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.(); // the scheduler never keeps the process alive
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const cut = (text: string | undefined): string | undefined => {
  const t = text?.trim();
  if (!t) return undefined;
  return t.length > SUMMARY_MAX ? t.slice(0, SUMMARY_MAX) : t;
};

const emptyReport = (): JobTickReport => ({ started: [], waited: [], interrupted: [], ended: [] });

export class JobScheduler {
  private readonly timers: Timers;
  private readonly now: () => Date;
  private handle: unknown;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly unsubscribe: (() => void)[] = [];
  /** Job-run Stewards a user's `control.stop` named (the adapter's own stop may say `system`). */
  private readonly userStopped = new Set<Id>();

  constructor(private readonly opts: JobSchedulerOptions) {
    this.timers = opts.timers ?? NODE_TIMERS;
    this.now = opts.now ?? (() => new Date(opts.log.clock()));
    this.unsubscribe.push(
      opts.runtime.onTurnEnded((turn) => this.onTurnEnded(turn)),
      opts.log.subscribe((envelope) => this.onEvent(envelope)),
    );
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  /** Starts the timer; with `immediate` (the default) it ticks once first. */
  start(
    intervalMs: number = JOB_TICK_MS,
    { immediate = true }: { immediate?: boolean } = {},
  ): void {
    if (this.handle !== undefined || this.disposed) return;
    const tick = () => void this.tick().catch((error: unknown) => this.opts.onError(error));
    this.handle = this.timers.setInterval(tick, intervalMs);
    if (immediate) tick();
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }

  /** Stops the timer and every listener; queued work is dropped (the runtime is going away). */
  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /** One tick: reconcile, then start what is due. Serialised: a tick never overlaps another. */
  tick(): Promise<JobTickReport> {
    return this.enqueue(async () => {
      const report = emptyReport();
      await this.reconcile(report);
      for (const job of this.opts.log.tables.jobs.all()) {
        await this.startIfDue(job.id, report);
      }
      return report;
    }, emptyReport);
  }

  /**
   * Starts the job's run now if it is due — after the user answered its failure question, which
   * made it active and due. Through the same queue as the tick, so the two never start two runs.
   */
  retryNow(jobId: Id): Promise<void> {
    return this.enqueue(
      async () => {
        await this.startIfDue(jobId, emptyReport());
      },
      () => undefined,
    );
  }

  private enqueue<T>(fn: () => Promise<T>, idle: () => T): Promise<T> {
    const next = this.chain.then(() => (this.disposed ? idle() : fn()));
    this.chain = next.catch((error: unknown) => this.opts.onError(error));
    return next;
  }

  // -- the tick ----------------------------------------------------------------------------------

  private async reconcile(report: JobTickReport): Promise<void> {
    const { tables } = this.opts.log;
    const live = new Set(this.opts.runtime.liveAgents().map((a) => a.id));
    for (const job of tables.jobs.all()) {
      if (!job.runningRunId) continue;
      const run = tables.jobRuns.get(job.runningRunId);
      if (!run || run.outcome !== 'running') {
        this.clearDangling(job, run === undefined);
        continue;
      }
      const steward = run.agentId && live.has(run.agentId) ? run.agentId : undefined;
      if (steward && job.state === 'active') continue;
      if (steward) await this.opts.runtime.stop(steward, SYSTEM);
      // A Steward the user stopped ends its run without making the job due again (ruling R9).
      const byUser = !steward && run.agentId !== undefined && this.stoppedByUser(run.agentId);
      if (this.interrupt(run.id, { byUser })) report.interrupted.push(run.id);
    }
  }

  /**
   * A job pointing at a run that is gone (an import taken mid-run: exports carry no `job_runs`)
   * or already ended: `runningRunId` is cleared, else the job would wait on it for ever. A missing
   * run counts as cut short — an active job is due at once, like any interrupted run.
   */
  private clearDangling(job: Job, missing: boolean): void {
    this.opts.log.runCommand((ctx) => {
      const current = jobOf(ctx, job.id);
      const changes: JobChanges = { runningRunId: null };
      if (missing && current.state === 'active') changes.nextRunAt = ctx.now;
      writeJob(ctx, current, changes);
    });
  }

  /** The time the job's next run is for, or `undefined` when none is planned. */
  private dueOf(job: Job): Date | undefined {
    if (!job.nextRunAt) return undefined;
    let due = new Date(job.nextRunAt);
    // A run cut short is run again for the occurrence it was for (its lateness makes it a
    // catch-up run), not for the moment it was found cut short.
    const last = job.lastRun;
    if (last?.outcome === 'interrupted' && last.purpose !== 'follow_up') {
      const cutShort = this.opts.log.tables.jobRuns.get(last.runId);
      // A run the user stopped kept its schedule (ruling R9): nothing to run again.
      const kept = cutShort?.meta?.['keptSchedule'] === true;
      if (cutShort && !kept && Date.parse(cutShort.dueAt) < due.getTime()) {
        due = new Date(cutShort.dueAt);
      }
    }
    return due;
  }

  /** The project's Waykeeper row, latest first, whatever its state (`checkPlacement` takes it). */
  private waykeeperOf(projectId: Id): Agent | undefined {
    return this.opts.log.tables.agents
      .all()
      .filter((a) => a.role === 'waykeeper' && a.projectId === projectId)
      .reduce<Agent | undefined>(
        (best, a) => (!best || a.createdAt >= best.createdAt ? a : best),
        undefined,
      );
  }

  private async startIfDue(jobId: Id, report: JobTickReport): Promise<void> {
    const { log, commands, runtime } = this.opts;
    const { tables } = log;
    const job = tables.jobs.get(jobId);
    if (!job || job.state !== 'active') return;
    // A usage limit waits for the user's answer, and a "wait" for its reset (P11-07).
    const limit = job.limitQuestionId ? tables.questions.get(job.limitQuestionId) : undefined;
    if (limit && (limit.status === 'open' || limit.answer === LIMIT_WAIT)) return;
    const answered = limit?.status === 'answered' ? storedSwitchOf(limit) : undefined;
    const now = this.now();
    const followUp = job.followUps[0];
    // The switch is for the retry of the limited run alone (M4): another run keeps the job's own.
    const switchTo =
      answered && limit && switchAppliesTo(tables, limit, followUp) ? answered : undefined;
    const due = followUp ? now : this.dueOf(job);
    if (!due || due.getTime() > now.getTime()) return;
    // A finished project (closed, cancelled, archived) runs nothing; a paused one waits, like a
    // full cap: no run row, the next tick after its resume starts the run.
    const owner = tables.projects.get(job.projectId);
    if (!owner || FINISHED_WORK.has(owner.state)) return;
    if (owner.state === 'paused') {
      report.waited.push(job.id);
      return;
    }
    // One run per job at a time: a due run waits while one runs.
    if (job.runningRunId) {
      report.waited.push(job.id);
      return;
    }

    const supervisor = this.waykeeperOf(job.projectId);
    const slot = runtime.caps.canSpawn({
      role: 'steward',
      ...(supervisor ? { supervisorId: supervisor.id, supervisorRole: 'waykeeper' as const } : {}),
    });
    if (!slot.ok) {
      report.waited.push(job.id);
      return;
    }

    const note =
      typeof job.meta?.[RETRY_NOTE] === 'string' ? (job.meta[RETRY_NOTE] as string) : undefined;
    const purpose = followUp
      ? 'follow_up'
      : note !== undefined || job.lastRun?.outcome === 'failed'
        ? 'retry'
        : runPurpose(due, now);
    const run = log.runCommand((ctx) => {
      const started = startJobRun(ctx, {
        jobId: job.id,
        purpose,
        dueAt: due.toISOString(),
        ...(followUp ? { followUp } : {}),
        ...(note !== undefined && !followUp ? { note } : {}),
      });
      const current = jobOf(ctx, job.id);
      const changes: JobChanges = {};
      // The limit question is used up: its switch applies to this run only (P11-07). A switch
      // chosen for another run (a limited follow-up not back yet) waits for that run (M4).
      if (current.limitQuestionId && (switchTo || !answered)) changes.limitQuestionId = null;
      if (purpose !== 'follow_up') {
        // The next occurrence after now: several missed ones make one run (plan constraints).
        changes.nextRunAt = nextOccurrence(current.schedule, now).toISOString();
        if (note !== undefined) {
          const { [RETRY_NOTE]: _used, ...rest } = current.meta ?? {};
          changes.meta = rest;
        }
      }
      if (Object.keys(changes).length > 0) writeJob(ctx, current, changes);
      return started;
    }).value;
    report.started.push(run.id);

    if (!supervisor) {
      this.fail(run.id, 'the project has no Waykeeper to supervise its runs');
      report.ended.push(run.id);
      return;
    }
    const project = tables.projects.get(job.projectId);
    const area = tables.areas.get(job.areaId);
    const choice = (this.opts.chooseSteward ?? stewardChooser())({
      // A switch after a usage limit: this run on the chosen model, the job's own unchanged.
      job: switchTo
        ? { provider: switchTo.provider, ...(switchTo.model ? { model: switchTo.model } : {}) }
        : job,
      ...(followUp && !switchTo ? { followUp: true } : {}),
      ...(project ? { project } : {}),
      supervisorRuntime: supervisor.runtime,
    });
    // A follow-up that publishes runs only where every action can be held back (P11-06): the
    // run fails (the job pauses with one failure question) and the approved publish waits on
    // the job for the retry, once a provider that can publish is set.
    if (followUp?.kind === 'publish' && runtime.adapter(choice.runtime)?.canPublish !== true) {
      this.failPublish(run.id, `${PROVIDER_LABEL[choice.provider]} cannot publish`);
      report.ended.push(run.id);
      return;
    }
    let agent: Agent;
    try {
      if (!project || !area) throw new Error(`job ${job.name} has no project or area any more`);
      agent = (
        await commands.spawnAgent({
          role: 'steward',
          runtime: choice.runtime,
          ...(choice.model ? { model: choice.model } : {}),
          taskId: job.taskId,
          projectId: job.projectId,
          supervisorId: supervisor.id,
          prompt: jobRunPrompt({
            project,
            job,
            area,
            run,
            memory: jobMemory(log, job.id),
            ...(followUp ? { followUp } : {}),
            ...(run.note ? { note: run.note } : {}),
            declares: stewardDeclares(choice.runtime),
          }),
        })
      ).value;
    } catch (error) {
      const reason = (error as Error).message;
      if (CAP_REFUSAL.test(reason)) {
        // Nothing was spawned: even a publish goes back on the queue as it is (no re-ask).
        if (this.interrupt(run.id, { spawned: false })) report.interrupted.push(run.id);
      } else {
        this.fail(run.id, reason);
        report.ended.push(run.id);
      }
      return;
    }
    try {
      await commands.attachJobRunAgent({ runId: run.id, agentId: agent.id });
    } catch (error) {
      // No orphan: a Steward its run does not know about is stopped, the run tried again.
      this.opts.onError(error);
      await runtime.stop(agent.id, SYSTEM);
      if (this.interrupt(run.id)) report.interrupted.push(run.id);
    }
  }

  /** The user stopped this Steward (its own stop, or its task's), not the system. */
  private stoppedByUser(agentId: Id): boolean {
    if (this.userStopped.has(agentId)) return true;
    const [stopped] = this.opts.log.latestOf('agent.stopped', agentId, 1);
    return stopped?.event.type === 'agent.stopped' && stopped.event.by.type === 'user';
  }

  // -- a run's end -------------------------------------------------------------------------------

  /** The running run of a job-run Steward, if `agentId` is one and its run is still going. */
  private runOf(agentId: Id): JobRun | undefined {
    const { tables } = this.opts.log;
    const agent = tables.agents.get(agentId);
    if (agent?.role !== 'steward' || !agent.taskId) return undefined;
    const task = tables.tasks.get(agent.taskId);
    const jobId = task ? jobIdOfTask(task) : undefined;
    const job = jobId ? tables.jobs.get(jobId) : undefined;
    const run = job?.runningRunId ? tables.jobRuns.get(job.runningRunId) : undefined;
    if (!run || run.outcome !== 'running') return undefined;
    return run.agentId === undefined || run.agentId === agentId ? run : undefined;
  }

  /** The Steward of the run going on for the job whose hidden task this is. */
  private runningAgentOfTask(taskId: Id): Id | undefined {
    const { tables } = this.opts.log;
    const task = tables.tasks.get(taskId);
    const jobId = task ? jobIdOfTask(task) : undefined;
    const job = jobId ? tables.jobs.get(jobId) : undefined;
    return job?.runningRunId ? tables.jobRuns.get(job.runningRunId)?.agentId : undefined;
  }

  private isJobSteward(agent: Agent): boolean {
    if (agent.role !== 'steward' || !agent.taskId) return false;
    const task = this.opts.log.tables.tasks.get(agent.taskId);
    return task !== undefined && isJobTask(task);
  }

  private onTurnEnded(turn: TurnEnd): void {
    if (turn.interrupted || turn.queued > 0 || !this.isJobSteward(turn.agent)) return;
    const agentId = turn.agent.id;
    void this.enqueue(
      async () => {
        if (!this.endWithReport(agentId, turn.text)) return;
        if (this.opts.runtime.liveAgents().some((a) => a.id === agentId)) {
          await this.opts.runtime.stop(agentId, SYSTEM);
        }
      },
      () => undefined,
    );
  }

  private onEvent({ seq, event }: EventEnvelope): void {
    if (this.disposed) return;
    switch (event.type) {
      case 'agent.finished': {
        const agentId = event.agentId;
        if (!this.runOf(agentId)) return;
        void this.enqueue(
          async () => {
            this.endWithReport(agentId, event.result);
          },
          () => undefined,
        );
        return;
      }
      case 'agent.failed': {
        const { agentId, error, reason } = event;
        if (!this.runOf(agentId)) return;
        void this.enqueue(
          async () => {
            const run = this.runOf(agentId);
            if (!run) return;
            if (reason === 'limit') {
              // Not a failure: the run ends `limited` and the user is asked (P11-07).
              this.limited(run.id);
              await this.opts.limits?.askForRun(event, run);
              return;
            }
            const unanswered =
              reason === 'cap' ? this.unansweredPermission(agentId, seq) : undefined;
            this.fail(
              run.id,
              unanswered ? `it needed permission to ${unanswered} and nobody answered` : error,
            );
          },
          () => undefined,
        );
        return;
      }
      case 'control.stop': {
        if (event.by.type !== 'user') return;
        const { target } = event;
        const runAgent =
          target.kind === 'agent'
            ? target.id
            : target.kind === 'task'
              ? this.runningAgentOfTask(target.id)
              : undefined;
        if (runAgent && this.runOf(runAgent)) this.userStopped.add(runAgent);
        return;
      }
      case 'agent.stopped': {
        // The user stopped a run: it ends now and keeps the job's schedule (ruling R9).
        const agentId = event.agentId;
        if (!this.runOf(agentId)) return;
        if (event.by.type !== 'user' && !this.userStopped.has(agentId)) return;
        void this.enqueue(
          async () => {
            const run = this.runOf(agentId);
            if (run) this.interrupt(run.id, { byUser: true });
            this.userStopped.delete(agentId);
          },
          () => undefined,
        );
        return;
      }
      case 'job.updated': {
        // Paused, stopped, its project closed: a run going on stops (never a failure).
        const state = event.changes.state;
        if (state === undefined || state === 'active') return;
        const jobId = event.jobId;
        void this.enqueue(
          async () => {
            const job = this.opts.log.tables.jobs.get(jobId);
            const run = job?.runningRunId
              ? this.opts.log.tables.jobRuns.get(job.runningRunId)
              : undefined;
            if (!job || job.state === 'active' || !run || run.outcome !== 'running') return;
            if (run.agentId && this.opts.runtime.liveAgents().some((a) => a.id === run.agentId)) {
              await this.opts.runtime.stop(run.agentId, SYSTEM);
            }
            this.interrupt(run.id);
          },
          () => undefined,
        );
        return;
      }
      case 'question.answered': {
        // A failure answer made the job active and due, and so did a usage limit's switch
        // (P11-07): run it now (only while the timer runs).
        if (this.handle === undefined) return;
        const q = this.opts.log.tables.questions.get(event.questionId);
        const jobId =
          q?.context.jobFailure?.jobId ??
          (q && storedSwitchOf(q) ? q.context.usageLimit?.jobId : undefined);
        if (jobId) void this.retryNow(jobId);
        return;
      }
      default:
        return;
    }
  }

  /**
   * Ends the Steward's run with what it reported through `report_run` (`run.meta.report`), else
   * `quiet` with its last text. Returns whether a run was ended.
   */
  private endWithReport(agentId: Id, text: string | undefined): boolean {
    const run = this.runOf(agentId);
    if (!run) return false;
    const reported = (run.meta?.['report'] ?? undefined) as RunReport | undefined;
    const outcome: Exclude<JobRunOutcome, 'running'> =
      reported?.outcome === 'findings'
        ? 'findings'
        : reported?.outcome === 'failed'
          ? 'failed'
          : 'quiet';
    const summary = typeof reported?.summary === 'string' ? reported.summary : cut(text);
    const numbers =
      reported?.numbers && typeof reported.numbers === 'object'
        ? (reported.numbers as Record<string, number>)
        : undefined;
    const failureReason =
      typeof reported?.failureReason === 'string' ? reported.failureReason : undefined;
    const data =
      reported?.data && typeof reported.data === 'object' ? (reported.data as RunData) : undefined;
    const sources = this.opts.runSources?.take(agentId) ?? [];
    this.opts.log.runCommand((ctx) =>
      endJobRun(ctx, {
        runId: run.id,
        outcome,
        ...(summary !== undefined ? { summary } : {}),
        ...(numbers ? { numbers } : {}),
        ...(data ? { data } : {}),
        ...(sources.length > 0 ? { sources } : {}),
        ...(outcome === 'failed' && failureReason ? { failureReason } : {}),
      }),
    );
    return true;
  }

  /** The action of a permission question the Steward's cap stop cancelled unanswered. */
  private unansweredPermission(agentId: Id, failedSeq: number): string | undefined {
    const { log } = this.opts;
    for (const { event } of log.eventsSince(failedSeq, 200)) {
      if (event.type !== 'question.cancelled' || event.agentId !== agentId) continue;
      const q = log.tables.questions.get(event.questionId);
      if (q?.kind !== 'permission') continue;
      const action = q.context.permissionAction;
      if (action) return ACTION_TEXT[action];
      return q.context.toolCall ? `use ${q.context.toolCall.toolName}` : 'go on';
    }
    return undefined;
  }

  /** A run that ends without a report keeps no sources: what the runtime noted is dropped. */
  private forgetSources(runId: Id): void {
    const agentId = this.opts.log.tables.jobRuns.get(runId)?.agentId;
    if (agentId) this.opts.runSources?.take(agentId);
  }

  private fail(runId: Id, reason: string): void {
    this.forgetSources(runId);
    this.opts.log.runCommand((ctx) =>
      endJobRun(ctx, { runId, outcome: 'failed', failureReason: reason }),
    );
  }

  /** Fails a publish follow-up run that could not start, putting its follow-up back on the job. */
  private failPublish(runId: Id, reason: string): void {
    this.forgetSources(runId);
    this.opts.log.runCommand((ctx) => {
      const run = endJobRun(ctx, { runId, outcome: 'failed', failureReason: reason });
      const job = jobOf(ctx, run.jobId);
      const followUp = run.followUp;
      if (!followUp || job.state === 'stopped') return;
      if (job.followUps.some((f) => f.questionId === followUp.questionId)) return;
      writeJob(ctx, job, { followUps: [followUp, ...job.followUps] });
    });
  }

  /**
   * Records the run `interrupted`. A missed run (a restart, a cap race, a stop by the system)
   * makes its job due again at once — a follow-up run leaves the schedule alone — and a follow-up
   * it carried goes back on the job's queue and a retry note back on the job, so the next run does
   * them — except a publish whose Steward was spawned, which may already have gone out: a fresh
   * publish question asks again instead (ruling R13; a cap refusal before any spawn, `spawned:
   * false`, re-queues it as it is). A run the user stopped (`byUser`, ruling R9) keeps the job's
   * schedule and is not done again. Returns whether the run was still going.
   */
  private interrupt(
    runId: Id,
    { byUser = false, spawned = true }: { byUser?: boolean; spawned?: boolean } = {},
  ): boolean {
    const run = this.opts.log.tables.jobRuns.get(runId);
    if (!run || run.outcome !== 'running') return false;
    this.forgetSources(runId);
    this.opts.log.runCommand((ctx) => {
      endJobRun(ctx, { runId, outcome: 'interrupted', ...(byUser ? { keepSchedule: true } : {}) });
      if (!byUser) this.carryOver(ctx, run, spawned);
    });
    return true;
  }

  /**
   * Records the run `limited` (P11-07): its job stays active and is not due again — the limit
   * question decides when the next run starts — and what the run carried goes back on the job,
   * as for an interrupted run.
   */
  private limited(runId: Id): void {
    const run = this.opts.log.tables.jobRuns.get(runId);
    if (!run || run.outcome !== 'running') return;
    this.forgetSources(runId);
    this.opts.log.runCommand((ctx) => {
      endJobRun(ctx, { runId, outcome: 'limited' });
      this.carryOver(ctx, run, true);
    });
  }

  /**
   * A run cut short gives back what it carried: its follow-up to the front of the job's queue —
   * except a publish whose Steward was spawned, which may already have gone out, so a fresh
   * publish question asks again (ruling R13) — and its retry note to the job.
   */
  private carryOver(ctx: CommandContext, run: JobRun, spawned: boolean): void {
    const job = jobOf(ctx, run.jobId);
    if (job.state === 'stopped') return;
    const changes: JobChanges = {};
    const followUp = run.followUp;
    if (followUp?.kind === 'publish' && spawned) {
      // Never re-run on the old approval: it may already have posted (ruling R13).
      reaskInterruptedPublish(ctx, followUp, run.agentId);
    } else if (followUp && !job.followUps.some((f) => f.questionId === followUp.questionId)) {
      changes.followUps = [followUp, ...job.followUps];
    }
    if (run.note && job.meta?.[RETRY_NOTE] === undefined) {
      changes.meta = { ...(job.meta ?? {}), [RETRY_NOTE]: run.note };
    }
    writeJob(ctx, job, changes);
  }
}
