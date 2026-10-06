import { STORAGE_OK, type StorageHealth } from '@galactic/protocol';
import { storageConditionOf } from '../db/database.js';
import type { EventLog } from '../domain/event-log.js';
import type { StorageState } from './agent-runtime.js';

/**
 * The database's write health for the panel (P8-09; SPEC decision 99). Two sources:
 *
 * - the runtime's held queue (`AgentRuntime.storageState()`): agent events the storage refused,
 *   waiting to be written in order — the banner's "N agent events waiting";
 * - every outermost command (`EventLog.addStorageObserver`): one the storage refused marks the
 *   storage refusing even when nothing is held (the user's action on a full disk while no agent
 *   runs); the next command that commits an event clears it.
 *
 * Runtime state only: it is never logged (a full disk could not log it) and goes to the clients
 * on the WebSocket (`ws/session.ts`). A change of condition is published at once; a change of the
 * counts alone at most once per `minIntervalMs` (default 1 s), so a Steward working through a full
 * disk does not flood the sockets. While the storage is not `ok` the held queue is read every
 * `pollMs` (default 250 ms): held events change without any command running.
 */

export interface StorageMonitorOptions {
  log: EventLog;
  /** The runtime's held queue (`AgentRuntime.storageState`). */
  state: () => StorageState;
  pollMs?: number;
  minIntervalMs?: number;
  /** Clock (ms), injectable for tests. */
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}

export type StorageListener = (health: StorageHealth) => void;

export class StorageMonitor {
  private health: StorageHealth = STORAGE_OK;
  private refusal: { since: string; error: unknown } | undefined;
  private readonly listeners = new Set<StorageListener>();
  private readonly offObserver: () => void;
  private poll: NodeJS.Timeout | undefined;
  private trailing: NodeJS.Timeout | undefined;
  private lastPublished = Number.NEGATIVE_INFINITY;
  private scheduled = false;
  private disposed = false;

  constructor(private readonly opts: StorageMonitorOptions) {
    this.offObserver = opts.log.addStorageObserver((error) => {
      if (error === undefined) {
        this.refusal = undefined;
      } else {
        this.refusal = { since: this.refusal?.since ?? opts.log.clock(), error };
      }
      // After the command that told us: a held write is taken off the queue only once its
      // command returned, so the queue is read when the current synchronous work is done.
      this.schedule();
    });
  }

  /** The current health (what a new socket's snapshot carries). */
  current(): StorageHealth {
    return this.health;
  }

  subscribe(listener: StorageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Reads the sources again and publishes a change (tests call it; timers do otherwise). */
  check(): StorageHealth {
    if (this.disposed) return this.health;
    const next = this.compute();
    const prev = this.health;
    const conditionChanged = next.condition !== prev.condition;
    const countsChanged =
      next.held !== prev.held || next.dropped !== prev.dropped || next.since !== prev.since;
    if (conditionChanged) {
      this.publish(next);
    } else if (countsChanged || next.error !== prev.error) {
      const wait = this.lastPublished + (this.opts.minIntervalMs ?? 1_000) - this.now();
      if (wait <= 0) this.publish(next);
      else if (!this.trailing) {
        this.trailing = setTimeout(() => {
          this.trailing = undefined;
          this.check();
        }, wait);
        this.trailing.unref?.();
      }
    }
    this.pollWhileRefusing();
    return this.health;
  }

  dispose(): void {
    this.disposed = true;
    this.offObserver();
    clearInterval(this.poll);
    clearTimeout(this.trailing);
    this.poll = undefined;
    this.trailing = undefined;
    this.listeners.clear();
  }

  private compute(): StorageHealth {
    const held = this.opts.state();
    if (held.held > 0) {
      const condition = held.permanent
        ? 'unwritable'
        : (storageConditionOf({ code: held.code ?? 'SQLITE_FULL' }) ?? 'full');
      const since = held.since ?? this.refusal?.since;
      return {
        condition,
        held: held.held,
        dropped: held.dropped,
        ...(since ? { since } : {}),
        ...(held.error ? { error: held.error } : {}),
      };
    }
    if (this.refusal) {
      const { error, since } = this.refusal;
      return {
        condition: storageConditionOf(error) ?? 'unavailable',
        held: 0,
        dropped: 0,
        since,
        ...(error instanceof Error ? { error: error.message } : {}),
      };
    }
    return STORAGE_OK;
  }

  private publish(next: StorageHealth): void {
    this.health = next;
    this.lastPublished = this.now();
    clearTimeout(this.trailing);
    this.trailing = undefined;
    for (const listener of [...this.listeners]) {
      try {
        listener(next);
      } catch (error) {
        this.opts.onError?.(error, 'storage listener');
      }
    }
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.check();
    }).unref?.();
  }

  private pollWhileRefusing(): void {
    const refusing = this.health.condition !== 'ok' || this.refusal !== undefined;
    if (refusing && !this.poll && !this.disposed) {
      this.poll = setInterval(() => this.check(), this.opts.pollMs ?? 250);
      this.poll.unref?.();
    } else if (!refusing && this.poll) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }
}
