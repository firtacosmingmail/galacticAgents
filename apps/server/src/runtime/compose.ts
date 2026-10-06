import {
  ENDED_STATES,
  isHarnessMeta,
  wallClockCapApplies,
  type Agent,
  type AgentAdapter,
  type AgentRuntime as RuntimeName,
  type Id,
} from '@galactic/protocol';
import type { Database } from '../db/database.js';
import { Commands } from '../domain/commands.js';
import { EventLog, type EventLogOptions } from '../domain/event-log.js';
import { livingFromStatuses, logRouting } from '../domain/question-service.js';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import {
  BrainRunner,
  createBrainQueries,
  type BrainDefinition,
  type BrainPlacement,
  type BrainQueries,
  type BrainRunnerOptions,
} from '../brains/index.js';
import { AgentRuntime, type RecoveryReport } from './agent-runtime.js';
import { Archival, type Timers } from './archival.js';
import { BudgetWatcher } from './budgets.js';
import { DEFAULT_CAPS, type CapsConfig } from './caps.js';
import { StatusStore } from './status-store.js';
import { StewardProcesses, type StewardProcessesOptions } from './steward-processes.js';
import { stewardReports, type StewardReports } from './steward-reports.js';
import { TranscriptPipeline } from './transcripts.js';
import { TranscriptRetention, type RetentionPolicy } from './transcript-retention.js';
import { WorkStateDeriver } from './work-state-deriver.js';
import { Workspaces, type WorkspacesOptions } from '../workspace/workspaces.js';

/**
 * The runtime composition root: log, status store, transcript pipeline, adapters and the agent
 * runtime wired the one way they fit together (TECHNOLOGY §3.4, §4, §6.2). `index.ts` and the
 * conformance suite both build from here so the wiring is tested, not repeated.
 */

/** Silence after which a working agent is reported `stalled`, per runtime (corner case 2). */
export const STALL_THRESHOLDS_MS: Record<RuntimeName, number> = {
  fake: 5_000,
  // Long test suites and builds are legitimate silence; the SDK streams tokens in between.
  'claude-sdk': 5 * 60_000,
  acp: 5 * 60_000,
  pty: 2 * 60_000,
};

export interface ComposeOptions {
  /** Adapters to register; default: the fake adapter only (dev mode without Claude). */
  adapters?: AgentAdapter[];
  log?: EventLogOptions;
  /** Hard caps (P1-02) and the hierarchy's spawn caps (P2-17); `index.ts` passes `config.caps`. */
  caps?: CapsConfig;
  stallThresholdMs?: (runtime: RuntimeName | undefined) => number;
  /** How often stalls are checked and wall clocks refreshed. */
  tickMs?: number;
  /** Retention of ended status records (P1-16). */
  retainEndedMs?: number;
  maxEnded?: number;
  flushMs?: number;
  /** Delivered messages kept per inbox for inspection. */
  inboxHistory?: number;
  now?: () => string;
  onError?: (error: unknown, context: string) => void;
  /** `config.autoApproveRemote`: no policy write is floored (P2-21). */
  autoApproveRemote?: boolean;
  /**
   * The workspace service's paths (P2-05/P2-10): with them the composition builds `Workspaces`
   * over its own commands and tables, and every brain's tools get it. `index.ts` passes the
   * configured `projectsRoot` and `dataDir`.
   */
  workspaces?: Omit<WorkspacesOptions, 'commands' | 'tables'>;
  /**
   * The archival job (P2-13): `retentionMs` is decision 4's period (`config.retentionMs`, default
   * 7 days); the timer runs only with an `intervalMs` (`index.ts` passes one; tests leave it off
   * and call `archival.sweep()` under an injected clock).
   */
  archival?: { retentionMs?: number; intervalMs?: number; timers?: Timers };
  /**
   * Transcript retention (P8-02): `policy` from the settings (default
   * `DEFAULT_TRANSCRIPT_RETENTION`); the timer runs only with an `intervalMs`, like archival
   * (tests call `transcriptRetention.run()`).
   */
  transcriptRetention?: {
    policy?: RetentionPolicy;
    intervalMs?: number;
    timers?: Timers;
    pause?: () => Promise<void>;
  };
  /**
   * Steward process cleanup (P4-14): `index.ts` passes the supervisor as `groups`. With it, brains
   * get the process tools' service and a Steward's leftovers are swept when it ends or its task
   * closes; without it there are no sweeps and the tools refuse.
   */
  processes?: Omit<StewardProcessesOptions, 'log' | 'statuses' | 'onError'>;
  /** Dollar budgets (P8-01): the warning threshold (`config.budgets`, default 80 %). */
  budgets?: { warnAtPercent?: number };
}

export interface ComposedRuntime {
  log: EventLog;
  statuses: StatusStore;
  /** Task and project states derived from agents and questions (P2-15). */
  workStates: WorkStateDeriver;
  transcripts: TranscriptPipeline;
  runtime: AgentRuntime;
  /** The `DomainCommands` surface over this log and runtime (P2-01). */
  commands: Commands;
  /** Stewards' done reports to their supervisors (P2-11). */
  reports: StewardReports;
  /** Read-only views brains seed their turns from (P2-06). */
  queries: BrainQueries;
  /** Workspaces and worktrees, when composed with `workspaces` paths (P2-10). */
  workspaces?: Workspaces;
  /** The retention / archival job (P2-13); its timer runs when composed with an interval. */
  archival: Archival;
  /** Transcript retention and compaction (P8-02); its timer runs when composed with an interval. */
  transcriptRetention: TranscriptRetention;
  /** A Steward's processes: list, stop, sweep (P4-14), when composed with `processes`. */
  processes?: StewardProcesses;
  /** Budget notices and the Harmonizer's chat lines about them (P8-01). */
  budgets: BudgetWatcher;
  /** Spawns a brain through the runtime and drives its mailbox and turns (P2-06). */
  startBrain(
    definition: BrainDefinition,
    placement: BrainPlacement,
    opts?: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'>,
  ): Promise<BrainRunner>;
  /**
   * The brains recovery brings back as brains (P2-16): a definition per role, built for the agent
   * row being resumed. Startup recovery and `POST /api/agents/:id/recover` reopen a Harmonizer or
   * Waykeeper through `BrainRunner.resume` with it; a role without one is resumed as a plain
   * agent. Call before `recover()`.
   */
  defineBrains(
    definitions: BrainDefinitions,
    opts?: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'>,
  ): void;
  /** The runner driving a brain, while it runs (started or resumed here). */
  runnerOf(agentId: Id): BrainRunner | undefined;
  /**
   * The recovery report to the user (SPEC §5, decision 8): a line for the running Harmonizer's
   * next turn, "recovered: N resumed, M need attention", which it relays in its chat. Returns
   * whether a Harmonizer got it (none runs, or nothing was recovered: false).
   */
  announceRecovery(report: RecoveryReport): boolean;
  /**
   * Keeps a Harmonizer running (P2-16, decision 32): once armed (after the boot-time start), when
   * a Harmonizer ends — failed, finished, stopped by anyone but the user, or left interrupted —
   * and no other one runs or is on its way back, `start` is called (it must start one only if
   * none runs: `startHarmonizer`). At most `maxRestarts` within `windowMs` (default 3 in 10 min).
   * Returns the disarm function; shutdown and dispose disarm it too.
   */
  keepHarmonizer(
    start: () => Promise<unknown>,
    opts?: { maxRestarts?: number; windowMs?: number },
  ): () => void;
  /** Startup recovery (P1-14): marks lost agents interrupted and resumes what can be resumed. */
  recover(): Promise<RecoveryReport>;
  /**
   * Graceful shutdown (P1-14): agents are marked `agent.interrupted` and stopped so the next
   * start resumes them; then transcripts and status are flushed and timers released.
   */
  shutdown(): Promise<void>;
  /** Like `shutdown`, but agents end as stopped (tests, a server that is going away for good). */
  dispose(): Promise<void>;
}

/** A brain definition per role, for the agent row being resumed (P2-16). */
export type BrainDefinitions = Partial<
  Record<BrainDefinition['role'], (agent: Agent) => BrainDefinition>
>;

/** Where a resumed brain runs: its row's runtime, project, supervisor and working directory. */
function placementOf(agent: Agent): BrainPlacement {
  const cwd = (agent.meta as { cwd?: unknown } | undefined)?.cwd;
  return {
    runtime: agent.runtime,
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
    ...(agent.supervisorId ? { supervisorId: agent.supervisorId } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  };
}

/** The recovery report as the Harmonizer reads it (P2-16). */
export function recoveryNote(report: RecoveryReport, describe: (agentId: Id) => string): string {
  const n = report.resumed.length;
  const m = report.needAttention.length;
  const attention =
    m > 0 ? ` Need attention: ${report.needAttention.map((id) => describe(id)).join('; ')}.` : '';
  return (
    `the server restarted — recovered: ${n} agent${n === 1 ? '' : 's'} resumed, ${m} ` +
    `need${m === 1 ? 's' : ''} attention.${attention} Tell the user in one line ("recovered: ` +
    `${n} resumed, ${m} need attention"), naming what needs attention; an interrupted agent can ` +
    'be resumed from the panel.'
  );
}

export function composeRuntime(db: Database, opts: ComposeOptions = {}): ComposedRuntime {
  const log = new EventLog(db, opts.log ?? {});
  const defaultCaps = opts.caps?.defaults ?? DEFAULT_CAPS;
  const stallThreshold =
    opts.stallThresholdMs ?? ((runtime) => (runtime ? STALL_THRESHOLDS_MS[runtime] : 60_000));
  const statuses = new StatusStore({
    capsOf: (id) => log.tables.agents.get(id)?.caps,
    defaultCaps,
    // A brain shows its time without a limit (SPEC decision 103).
    wallClockCapped: (id) => {
      const agent = log.tables.agents.get(id);
      return !agent || wallClockCapApplies(agent);
    },
    // The scene harness's fake agents (P4-06) have no process to fall silent: they stall only
    // when the harness says so.
    stallThresholdMs: (runtime, agentId) =>
      isHarnessMeta(log.tables.agents.get(agentId)?.meta)
        ? Number.POSITIVE_INFINITY
        : stallThreshold(runtime),
    // A stall the ticker saw is logged (P8-04): the supervisor is woken, the history shows it.
    onStalled: (agentId, silentForMs) => runtime.noteStalled(agentId, silentForMs),
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
    ...(opts.retainEndedMs !== undefined ? { retainEndedMs: opts.retainEndedMs } : {}),
    ...(opts.maxEnded !== undefined ? { maxEnded: opts.maxEnded } : {}),
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'status store') } : {}),
  });
  // Rebuild from the log, then fold every later commit in seq order.
  statuses.rebuild(log.eventsSince(0, Number.MAX_SAFE_INTEGER));
  log.subscribe((envelope) => statuses.fold(envelope));
  statuses.start();

  // Task and project states (P2-15): rebuilt from the log without writing, then folded after the
  // status store on every commit; `reconcile` repairs what a crash between a commit and its
  // derivation left stale (a no-op when the rows agree).
  const workStates = new WorkStateDeriver(log, {
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'work states') } : {}),
  });
  workStates.rebuild(log.eventsSince(0, Number.MAX_SAFE_INTEGER));
  log.subscribe((envelope) => workStates.fold(envelope));
  workStates.reconcile();

  const transcripts = new TranscriptPipeline(db, {
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'transcripts') } : {}),
  });

  // One question routing for the runtime and the command surface (P2-03).
  // An agent on its way back (recovery is about to reopen it, or a lost resume is being replaced
  // by a fresh session, P2-16) still holds what is routed to it.
  const living = livingFromStatuses(statuses);
  const questions = logRouting(log, (id) => living(id) || runtime.isReserved(id));
  const runtime: AgentRuntime = new AgentRuntime({
    log,
    questions,
    adapters: opts.adapters ?? [new FakeAdapter()],
    transcripts,
    statuses,
    caps: { ...(opts.caps ?? {}), defaults: defaultCaps },
    ...(opts.inboxHistory !== undefined ? { inboxHistory: opts.inboxHistory } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  // Decision 10's "is its Waykeeper running", for the commands and for every body-freeing path
  // (archival, the marker sweep): they un-park cards the way an approval chooses (P2-09).
  const isRunning = (id: string): boolean => {
    const status = statuses.get(id);
    return status !== undefined && !ENDED_STATES.has(status.state);
  };
  log.choose = { isRunning };

  // A Steward that ends its turn reports to its supervisor's mailbox (P2-11); a report missed while
  // the supervisor was down is sent again when it comes back (P2-16).
  const reports = stewardReports(runtime, log.tables, opts.onError, {
    eventsSince: (seq, limit) => log.eventsSince(seq, limit),
    stateOf: (id) => statuses.get(id)?.state,
    lastText: (id) => {
      const from = Math.max(0, transcripts.lastSeq(id) - 200);
      return transcripts
        .read(id, from, 200)
        .filter((c) => c.kind === 'text' && c.text.trim() !== '')
        .at(-1)?.text;
    },
  });

  const commands = new Commands({
    log,
    agents: runtime,
    questions,
    ...(opts.autoApproveRemote ? { autoApproveRemote: true } : {}),
    // A card's workspace is checked as the workspace service checks it (P2-09, decision 27).
    ...(opts.workspaces
      ? { checkWorkspace: (path: string): string => workspaces!.checkPath(path) }
      : {}),
    isRunning,
  });
  const queries = createBrainQueries({
    tables: log.tables,
    status: (id) => {
      const status = statuses.get(id);
      // An interrupted agent startup recovery is about to reopen is on its way back (P2-16): a
      // brain resumed before its Stewards sees it starting, and its spawn guards do not replace it.
      return status?.state === 'interrupted' && runtime.isReserved(id)
        ? { ...status, state: 'starting' }
        : status;
    },
  });
  const workspaces: Workspaces | undefined = opts.workspaces
    ? new Workspaces({ ...opts.workspaces, commands, tables: log.tables })
    : undefined;
  const archival = new Archival({
    log,
    ...(opts.archival?.retentionMs !== undefined ? { retentionMs: opts.archival.retentionMs } : {}),
    ...(opts.archival?.timers ? { timers: opts.archival.timers } : {}),
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'archival') } : {}),
  });
  if (opts.archival?.intervalMs) archival.start(opts.archival.intervalMs);
  const tr = opts.transcriptRetention;
  const transcriptRetention = new TranscriptRetention({
    db,
    tables: log.tables,
    ...(tr?.policy ? { policy: tr.policy } : {}),
    ...(tr?.timers ? { timers: tr.timers } : {}),
    ...(tr?.pause ? { pause: tr.pause } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'transcript retention') } : {}),
  });
  if (tr?.intervalMs) transcriptRetention.start(tr.intervalMs);
  const processes: StewardProcesses | undefined = opts.processes
    ? new StewardProcesses({
        ...opts.processes,
        log,
        statuses,
        ...(opts.onError ? { onError: opts.onError } : {}),
      })
    : undefined;
  processes?.watch();

  const budgets = new BudgetWatcher({
    log,
    harmonizer: () => runtime.liveAgents().find((a) => a.role === 'harmonizer')?.id,
    post: (agentId, text) => void runtime.send(agentId, text, { sender: { type: 'system' } }),
    ...(opts.budgets?.warnAtPercent !== undefined
      ? { warnAtPercent: opts.budgets.warnAtPercent }
      : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  budgets.start();

  // The brains this composition drives (P2-16): started here or resumed by recovery.
  const runners = new Map<Id, BrainRunner>();
  const runnerOptions = (extra: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'> = {}) => ({
    log,
    runtime,
    commands,
    queries,
    ...(workspaces ? { workspaces } : {}),
    ...(processes ? { processes } : {}),
    ...extra,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  const adopt = (runner: BrainRunner): BrainRunner => {
    runners.set(runner.agentId, runner);
    // Reports its Stewards could not deliver while it was not running (P2-16).
    reports.resend(runner.agentId);
    return runner;
  };
  let definitions: BrainDefinitions = {};
  let resumeOptions: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'> = {};
  runtime.setBrainResumer((agent) => {
    if (agent.role === 'steward') return undefined;
    const define = definitions[agent.role];
    if (!define) return undefined;
    return BrainRunner.resume(define(agent), placementOf(agent), agent.id, {
      ...runnerOptions(resumeOptions),
    }).then(({ runner, result }) => {
      if (runner) adopt(runner);
      return result;
    });
  });
  const disarmHarmonizer: (() => void)[] = [];
  const describeAgent = (id: Id): string => {
    const agent = log.tables.agents.get(id);
    const status = statuses.get(id);
    const what = agent
      ? `${agent.role} ${id}${agent.taskId ? ` (task ${agent.taskId})` : agent.projectId ? ` (project ${agent.projectId})` : ''}`
      : `agent ${id}`;
    return `${what}: ${status?.state ?? 'unknown'}${status?.currentActivity ? ` — ${status.currentActivity}` : ''}`;
  };

  return {
    log,
    statuses,
    workStates,
    transcripts,
    runtime,
    commands,
    reports,
    queries,
    ...(workspaces ? { workspaces } : {}),
    archival,
    transcriptRetention,
    ...(processes ? { processes } : {}),
    budgets,
    startBrain: async (definition, placement, brainOpts = {}) =>
      adopt(await BrainRunner.start(definition, placement, runnerOptions(brainOpts))),
    defineBrains(defs, brainOpts = {}) {
      definitions = { ...defs };
      resumeOptions = brainOpts;
    },
    runnerOf(agentId) {
      const runner = runners.get(agentId);
      return runner && runner.state !== 'ended' ? runner : undefined;
    },
    announceRecovery(report) {
      if (report.resumed.length + report.needAttention.length === 0) return false;
      const hq = [...runners.values()].find(
        (r) => r.definition.role === 'harmonizer' && r.state !== 'ended',
      );
      if (!hq) return false;
      hq.note(recoveryNote(report, describeAgent));
      return true;
    },
    keepHarmonizer(start, keepOpts = {}) {
      const maxRestarts = keepOpts.maxRestarts ?? 3;
      const windowMs = keepOpts.windowMs ?? 10 * 60_000;
      const restarts: number[] = [];
      let scheduled = false;
      let armed = true;
      const check = () => {
        scheduled = false;
        if (!armed) return;
        const running = runtime.liveAgents().some((a) => a.role === 'harmonizer');
        const comingBack = log.tables.agents
          .all()
          .some((a) => a.role === 'harmonizer' && runtime.isReserved(a.id));
        if (running) return;
        if (comingBack) {
          // Look again once its reopen settled: it may still fail.
          scheduled = true;
          setTimeout(check, 50).unref();
          return;
        }
        const now = Date.now();
        while (restarts.length > 0 && now - restarts[0]! > windowMs) restarts.shift();
        if (restarts.length >= maxRestarts) {
          opts.onError?.(
            new Error(`the Harmonizer ended ${restarts.length} times in a row: not restarting it`),
            'keep harmonizer',
          );
          return;
        }
        restarts.push(now);
        start().catch((error: unknown) => opts.onError?.(error, 'keep harmonizer: start'));
      };
      // A stop the user asked for: the adapter's own `agent.stopped` may say `system`.
      const stoppedByUser = new Set<Id>();
      const unsubscribe = log.subscribe(({ event }) => {
        if (!armed) return;
        if (event.type === 'control.stop' && event.target.kind === 'agent') {
          if (event.by.type === 'user') stoppedByUser.add(event.target.id);
          return;
        }
        if (scheduled) return;
        if (
          event.type !== 'agent.finished' &&
          event.type !== 'agent.failed' &&
          event.type !== 'agent.stopped' &&
          event.type !== 'agent.interrupted'
        ) {
          return;
        }
        if (log.tables.agents.get(event.agentId)?.role !== 'harmonizer') return;
        if (stoppedByUser.delete(event.agentId) && event.type === 'agent.stopped') return;
        if (event.type === 'agent.stopped' && event.by.type === 'user') return; // the user's call
        scheduled = true;
        // After the command that ended it: a fallback or a resume may be taking over.
        setImmediate(check);
      });
      const disarm = () => {
        armed = false;
        unsubscribe();
      };
      disarmHarmonizer.push(disarm);
      return disarm;
    },
    recover: () => runtime.recover(),
    async shutdown() {
      // A graceful shutdown interrupts agents (they come back): nothing of theirs is swept.
      processes?.dispose();
      budgets.stop();
      for (const disarm of disarmHarmonizer.splice(0)) disarm();
      archival.stop();
      transcriptRetention.stop();
      reports.dispose();
      await runtime.shutdown();
      await runtime.dispose();
      statuses.dispose();
      transcripts.dispose();
    },
    async dispose() {
      processes?.dispose();
      budgets.stop();
      for (const disarm of disarmHarmonizer.splice(0)) disarm();
      archival.stop();
      transcriptRetention.stop();
      reports.dispose();
      await runtime.dispose();
      statuses.dispose();
      transcripts.dispose();
    },
  };
}
