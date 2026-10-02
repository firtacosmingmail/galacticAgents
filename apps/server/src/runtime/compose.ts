import {
  ENDED_STATES,
  type AgentAdapter,
  type AgentCaps,
  type AgentRuntime as RuntimeName,
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
import { DEFAULT_CAPS } from './caps.js';
import { StatusStore } from './status-store.js';
import { stewardReports, type StewardReports } from './steward-reports.js';
import { TranscriptPipeline } from './transcripts.js';
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
  caps?: { maxConcurrentAgents?: number; defaults?: AgentCaps };
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
  /** Spawns a brain through the runtime and drives its mailbox and turns (P2-06). */
  startBrain(
    definition: BrainDefinition,
    placement: BrainPlacement,
    opts?: Pick<BrainRunnerOptions, 'coalesceMs' | 'reset'>,
  ): Promise<BrainRunner>;
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

export function composeRuntime(db: Database, opts: ComposeOptions = {}): ComposedRuntime {
  const log = new EventLog(db, opts.log ?? {});
  const defaultCaps = opts.caps?.defaults ?? DEFAULT_CAPS;
  const statuses = new StatusStore({
    capsOf: (id) => log.tables.agents.get(id)?.caps,
    defaultCaps,
    stallThresholdMs:
      opts.stallThresholdMs ?? ((runtime) => (runtime ? STALL_THRESHOLDS_MS[runtime] : 60_000)),
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
  const questions = logRouting(log, livingFromStatuses(statuses));
  const runtime = new AgentRuntime({
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

  // A Steward that ends its turn reports to its supervisor's mailbox (P2-11).
  const reports = stewardReports(runtime, log.tables, opts.onError);

  const commands = new Commands({
    log,
    agents: runtime,
    questions,
    ...(opts.autoApproveRemote ? { autoApproveRemote: true } : {}),
    isRunning: (id) => {
      const status = statuses.get(id);
      return status !== undefined && !ENDED_STATES.has(status.state);
    },
  });
  const queries = createBrainQueries({ tables: log.tables, status: (id) => statuses.get(id) });
  const workspaces = opts.workspaces
    ? new Workspaces({ ...opts.workspaces, commands, tables: log.tables })
    : undefined;
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
    startBrain: (definition, placement, brainOpts = {}) =>
      BrainRunner.start(definition, placement, {
        log,
        runtime,
        commands,
        queries,
        ...(workspaces ? { workspaces } : {}),
        ...brainOpts,
        ...(opts.onError ? { onError: opts.onError } : {}),
      }),
    recover: () => runtime.recover(),
    async shutdown() {
      reports.dispose();
      await runtime.shutdown();
      await runtime.dispose();
      statuses.dispose();
      transcripts.dispose();
    },
    async dispose() {
      reports.dispose();
      await runtime.dispose();
      statuses.dispose();
      transcripts.dispose();
    },
  };
}
