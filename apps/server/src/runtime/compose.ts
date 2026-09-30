import type { AgentAdapter, AgentCaps, AgentRuntime as RuntimeName } from '@galactic/protocol';
import type { Database } from '../db/database.js';
import { EventLog, type EventLogOptions } from '../domain/event-log.js';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { AgentRuntime } from './agent-runtime.js';
import { DEFAULT_CAPS } from './caps.js';
import { StatusStore } from './status-store.js';
import { TranscriptPipeline } from './transcripts.js';

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
  flushMs?: number;
  /** Delivered messages kept per inbox for inspection. */
  inboxHistory?: number;
  now?: () => string;
  onError?: (error: unknown, context: string) => void;
}

export interface ComposedRuntime {
  log: EventLog;
  statuses: StatusStore;
  transcripts: TranscriptPipeline;
  runtime: AgentRuntime;
  /** Graceful: stops every agent, flushes transcripts and status, releases timers. */
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
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'status store') } : {}),
  });
  // Rebuild from the log, then fold every later commit in seq order.
  statuses.rebuild(log.eventsSince(0, Number.MAX_SAFE_INTEGER));
  log.subscribe((envelope) => statuses.fold(envelope));
  statuses.start();

  const transcripts = new TranscriptPipeline(db, {
    ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
    ...(opts.onError ? { onError: (e: unknown) => opts.onError!(e, 'transcripts') } : {}),
  });

  const runtime = new AgentRuntime({
    log,
    adapters: opts.adapters ?? [new FakeAdapter()],
    transcripts,
    statuses,
    caps: { ...(opts.caps ?? {}), defaults: defaultCaps },
    ...(opts.inboxHistory !== undefined ? { inboxHistory: opts.inboxHistory } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
  });

  return {
    log,
    statuses,
    transcripts,
    runtime,
    async dispose() {
      await runtime.dispose();
      statuses.dispose();
      transcripts.dispose();
    },
  };
}
