import { DEFAULT_RETENTION_MS } from '../domain/bodies.js';
import type { EventLog } from '../domain/event-log.js';
import {
  retained,
  sweepRetention,
  type RetentionItem,
  type SweepReport,
} from '../domain/retention.js';

/**
 * The scheduled archival job (P2-13; SPEC decision 4, 15): an interval timer in the runtime
 * composition that runs `sweepRetention` — finished, unpinned projects and standalone tasks past
 * the retention period are archived (their body freed), and "moved to …" markers are cleared. The
 * job reads the log's clock, so tests drive it with an injected `now` and `sweep()` instead of the
 * timer; the composition starts the timer only when it is given an interval (`index.ts` does).
 */

/** How often the server sweeps: retention is counted in days, an hour late is fine. */
export const ARCHIVAL_INTERVAL_MS = 60 * 60 * 1000;

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const NODE_TIMERS: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.(); // the job never keeps the process alive
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ArchivalOptions {
  log: EventLog;
  /** Decision 4's retention period (`config.retentionMs`); default 7 days. */
  retentionMs?: number;
  /** Timers, injectable for tests. */
  timers?: Timers;
  /** A sweep that threw (anything but a domain refusal, which the report lists). */
  onError?: (error: unknown) => void;
  /** Every sweep's report (logging, tests). */
  onSweep?: (report: SweepReport) => void;
}

export class Archival {
  /** Mutable (P25-01): a settings write applies from the next sweep on. */
  retentionMs: number;
  private readonly timers: Timers;
  private handle: unknown;

  constructor(private readonly opts: ArchivalOptions) {
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.timers = opts.timers ?? NODE_TIMERS;
  }

  /** Runs one sweep now (archive-now for everything due; the timer calls it too). */
  sweep(): SweepReport {
    const report = sweepRetention(this.opts.log, this.retentionMs);
    this.opts.onSweep?.(report);
    return report;
  }

  /** What the timer is waiting for, soonest first (a settings or history view can show it). */
  pending(): RetentionItem[] {
    return retained(this.opts.log, this.retentionMs);
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  /**
   * Starts the timer; with `immediate` (the default) it sweeps once first, which catches what
   * ran out while the server was down.
   */
  start(intervalMs: number = ARCHIVAL_INTERVAL_MS, { immediate = true } = {}): void {
    if (this.handle !== undefined) return;
    const tick = () => {
      try {
        this.sweep();
      } catch (error) {
        this.opts.onError?.(error);
      }
    };
    this.handle = this.timers.setInterval(tick, intervalMs);
    if (immediate) tick();
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }
}
