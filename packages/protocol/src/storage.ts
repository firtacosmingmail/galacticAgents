import { z } from 'zod';
import { Timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// Storage health (P8-09; SPEC decision 99; TECHNOLOGY §6.1 "Crashes and storage failures").
//
// The storage state is runtime state, not an event: while the disk is full nothing can be written,
// so a "disk full" event could never be in the log. It rides on the WebSocket instead — in the
// snapshot and in `status` messages (`SnapshotMessage.storage`, `StatusMessage.storage`), both
// optional fields an older page ignores.
// ---------------------------------------------------------------------------

/**
 * Whether the database takes writes:
 * - `ok`: it does;
 * - `full`: the disk is full (SQLITE_FULL) — it passes once there is space;
 * - `unavailable`: a passing storage failure other than space (an I/O error, a lock held too long);
 * - `unwritable`: the database cannot be written at all (read-only or missing file) — it does not
 *   pass by itself, the file must be fixed.
 */
export const StorageCondition = z.enum(['ok', 'full', 'unavailable', 'unwritable']);
export type StorageCondition = z.infer<typeof StorageCondition>;

export const StorageHealth = z.object({
  condition: StorageCondition,
  /** Agent events waiting to be written (held by the runtime, written in order later). */
  held: z.number().int().nonnegative(),
  /** Agent output dropped this episode to keep the held queue within its limits. */
  dropped: z.number().int().nonnegative(),
  /** When writes started failing (absent while `ok`). */
  since: Timestamp.optional(),
  /** The storage's last refusal, as SQLite said it ("database or disk is full"). */
  error: z.string().optional(),
});
export type StorageHealth = z.infer<typeof StorageHealth>;

export const STORAGE_OK: StorageHealth = { condition: 'ok', held: 0, dropped: 0 };

/**
 * The error code of a REST action the storage refused (the body is `{error, message}` like every
 * refusal): `storage_full` (HTTP 507 Insufficient Storage), `storage_unavailable` (503, a passing
 * failure) and `storage_unwritable` (503, read-only or missing database). Nothing was done; the
 * user repeats the action once the storage takes writes again (decision 99: never queued).
 */
export const StorageErrorCode = z.enum([
  'storage_full',
  'storage_unavailable',
  'storage_unwritable',
]);
export type StorageErrorCode = z.infer<typeof StorageErrorCode>;

export const STORAGE_ERROR: Record<
  Exclude<StorageCondition, 'ok'>,
  { code: StorageErrorCode; status: number; message: string }
> = {
  full: {
    code: 'storage_full',
    status: 507,
    message:
      'The disk is full: your action was not saved. Free some space on the disk, then try again.',
  },
  unavailable: {
    code: 'storage_unavailable',
    status: 503,
    message:
      'The database could not be written just now: your action was not saved. Try again in a moment.',
  },
  unwritable: {
    code: 'storage_unwritable',
    status: 503,
    message:
      'The database cannot be written (the file is read-only or missing): your action was not ' +
      "saved. Fix the database file's permissions or restore it, then try again.",
  },
};

/** Whether a REST error code is a storage refusal. */
export function isStorageErrorCode(code: unknown): code is StorageErrorCode {
  return StorageErrorCode.safeParse(code).success;
}
