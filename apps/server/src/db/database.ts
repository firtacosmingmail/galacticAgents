import BetterSqlite3, { type Database } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrate.js';

export type { Database } from 'better-sqlite3';

export interface OpenOptions {
  /** Skip migrations (tests of the runner itself). */
  migrate?: boolean;
}

/**
 * Opens (creating if needed) the SQLite database in WAL mode with foreign keys on, and brings the
 * schema up to date. `':memory:'` gives a throwaway database for tests.
 *
 * `auto_vacuum = INCREMENTAL` comes first (P8-02): it only takes effect before the first table is
 * created, so a new database gets it and transcript retention can hand freed pages back to the
 * file system in small steps (`PRAGMA incremental_vacuum`). On an existing database without it
 * the pragma is only remembered until a full VACUUM, which `convertToIncrementalVacuum` runs once
 * at startup (`db/vacuum.ts`).
 *
 * `journal_size_limit` keeps the WAL from staying as big as the largest write burst it ever held
 * (a VACUUM, a retention run): after a checkpoint it is truncated back to this size.
 */
export const JOURNAL_SIZE_LIMIT = 64 * 2 ** 20;

export function openDatabase(path: string, opts: OpenOptions = {}): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma('auto_vacuum = INCREMENTAL');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT}`);
  if (opts.migrate !== false) migrate(db);
  return db;
}

/**
 * SQLite result codes that say the storage refused the write (P8-04: disk full, an I/O error, a
 * lock held too long, a read-only file) rather than the statement being wrong: the same write can
 * succeed later, once the disk has room or the lock is gone. Extended codes count by prefix.
 */
const STORAGE_CODES = [
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  'SQLITE_PROTOCOL',
];

/**
 * What a storage failure means for the user (P8-09): `full` (SQLITE_FULL: the disk is full),
 * `unwritable` (SQLITE_READONLY, SQLITE_CANTOPEN: the file must be fixed, it does not pass by
 * itself), `unavailable` (any other storage failure: an I/O error, a lock held too long). Undefined
 * for an error that is not a storage failure.
 */
export function storageConditionOf(
  error: unknown,
): 'full' | 'unavailable' | 'unwritable' | undefined {
  if (!isStorageFailure(error)) return undefined;
  const code = (error as { code: string }).code;
  const is = (c: string) => code === c || code.startsWith(`${c}_`);
  if (is('SQLITE_FULL')) return 'full';
  if (is('SQLITE_READONLY') || is('SQLITE_CANTOPEN')) return 'unwritable';
  return 'unavailable';
}

/** Whether `error` is a storage failure (see `STORAGE_CODES`): worth retrying, not a refusal. */
export function isStorageFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === 'string' && STORAGE_CODES.some((c) => code === c || code.startsWith(`${c}_`))
  );
}
