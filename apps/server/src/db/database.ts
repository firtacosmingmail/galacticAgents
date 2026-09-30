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
 */
export function openDatabase(path: string, opts: OpenOptions = {}): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new BetterSqlite3(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (opts.migrate !== false) migrate(db);
  return db;
}
