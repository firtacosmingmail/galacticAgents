import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { backupName, backupTo, BACKUP_DIR } from './backup.js';
import { checkSchema, ExportError } from './map-export.js';
import { isEmptyDatabase } from './map-import.js';
import { loadMigrations, type Migration } from './migrate.js';

/**
 * Restoring a backup file (P8-03; docs/BACKUP_RESTORE.md): `galactic restore <file>`, with
 * Mission Control stopped. The backup is checked (`quick_check`), the database it replaces is
 * copied into `backups/` first (`pre-import`) unless it is empty, and the restored database gets a
 * **new log identity**: its log ends where the backup was taken, so the events written after that
 * are gone, and the `seq`s they had will be handed out again — a client that saw them must take a
 * snapshot instead of resuming (`hello{lastEventId, logId}` would otherwise skip the new events).
 * Like the import, the new database is built next to the target and renamed into place.
 */

export class RestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreError';
  }
}

export interface RestoreReport {
  /** The copy of the database that was replaced (absent when it was empty or missing). */
  replacedBackup?: string;
  /** The restored log's last `seq`. */
  seq: number;
  logId: string;
}

export async function restoreBackup(
  dbPath: string,
  file: string,
  opts: { backupDir?: string; now?: () => string; migrations?: Migration[] } = {},
): Promise<RestoreReport> {
  if (!existsSync(file)) throw new RestoreError(`No backup at ${file}.`);
  const now = opts.now ?? (() => new Date().toISOString());
  const source = new BetterSqlite3(file, { readonly: true, fileMustExist: true });
  const temp = `${dbPath}.restore-${process.pid}`;
  const cleanTemp = () => {
    for (const f of [temp, `${temp}-wal`, `${temp}-shm`, `${temp}-journal`]) {
      rmSync(f, { force: true });
    }
  };
  try {
    let check: unknown;
    try {
      check = source.pragma('quick_check', { simple: true });
    } catch (error) {
      throw new RestoreError(`${file} is not a readable database: ${(error as Error).message}`);
    }
    if (check !== 'ok') {
      throw new RestoreError(`${file} failed its integrity check: ${String(check)}`);
    }
    // A backup from a newer build (or another branch's migrations) cannot be run by this one; an
    // older one is migrated by the server at its next start.
    try {
      checkSchema(source, opts.migrations ?? loadMigrations(), { allowOlder: true });
    } catch (error) {
      if (error instanceof ExportError) {
        throw new RestoreError(
          `${file} cannot be restored by this build: ${error.message.replace('export it', 'restore it')}`,
        );
      }
      throw new RestoreError(
        `${file} is not a Mission Control backup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let replacedBackup: string | undefined;
    if (existsSync(dbPath)) {
      const old = new BetterSqlite3(dbPath);
      try {
        if (!isEmptyDatabase(old)) {
          const dir = opts.backupDir ?? join(dirname(dbPath), BACKUP_DIR);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          replacedBackup = join(dir, backupName('pre-import', now()));
          await backupTo(old, replacedBackup);
        }
      } finally {
        old.close();
      }
    }

    cleanTemp();
    mkdirSync(dirname(dbPath), { recursive: true });
    await backupTo(source, temp);
    const db = new BetterSqlite3(temp);
    let report: RestoreReport;
    try {
      const logId = randomUUID();
      db.prepare(
        `INSERT INTO settings (key, value) VALUES ('log_id', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(logId);
      const seq = (
        db.prepare('SELECT COALESCE(MAX(id), 0) AS seq FROM events').get() as { seq: number }
      ).seq;
      db.pragma('journal_mode = WAL');
      report = { seq, logId, ...(replacedBackup ? { replacedBackup } : {}) };
    } finally {
      db.close();
    }
    for (const f of [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      rmSync(f, { force: true });
    }
    renameSync(temp, dbPath);
    chmodSync(dbPath, 0o600);
    return report;
  } catch (error) {
    cleanTemp();
    throw error;
  } finally {
    source.close();
  }
}
