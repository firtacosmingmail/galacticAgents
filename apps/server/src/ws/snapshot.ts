import type { Snapshot } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import type { StatusStore } from '../runtime/status-store.js';
import type { StorageMonitor } from '../runtime/storage-health.js';

/**
 * The wire snapshot (TECHNOLOGY §6.3): the domain tables at the log's current `seq` plus the
 * status records, which are the runtime's projection, not a table. Both are read in the same
 * synchronous tick and the store folds every commit synchronously, so the records are exactly
 * the ones a client would have derived from the events up to `seq` — had it been allowed to.
 * The storage health (P8-09) is runtime state too, carried as it is now.
 */
export function buildSnapshot(
  log: EventLog,
  statuses?: StatusStore,
  storage?: StorageMonitor,
): Snapshot {
  return {
    ...log.snapshot(),
    statuses: statuses?.all() ?? [],
    ...(storage ? { storage: storage.current() } : {}),
  };
}
