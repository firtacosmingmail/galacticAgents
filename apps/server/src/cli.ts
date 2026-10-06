import BetterSqlite3 from 'better-sqlite3';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths, DEFAULT_PORT } from './config/config.js';
import { BACKUP_DIR, removePartialBackups } from './db/backup.js';
import {
  acquireDataLock,
  DataLockError,
  DEFAULT_LOCK_PROBE,
  describeHolder,
  liveLockHolder,
  removeStaleTempDatabases,
  type DataLock,
  type LockProbe,
} from './db/data-lock.js';
import { exportMap, ExportError } from './db/map-export.js';
import { importMap, ImportError } from './db/map-import.js';
import { restoreBackup, RestoreError } from './db/restore.js';

/**
 * `galactic export <file>`, `galactic import <file>` and `galactic restore <backup>` (P8-03;
 * docs/BACKUP_RESTORE.md), run by
 * `bin/galactic.mjs` against the data folder (`~/.galactic`, `GALACTIC_HOME`, `GALACTIC_DB`).
 *
 * The export opens the database read-only, so it works while Mission Control runs (WAL readers
 * see a consistent state) and writes the file 0600: it holds the whole history, messages included.
 * The import and the restore replace the database, so they refuse while a live process holds
 * the data lock (`<db>.lock`, `db/data-lock.ts`: a Mission Control from its start to its exit,
 * whatever port or address it listens on, or another import) and, as a second check, while a
 * Mission Control answers `/health` on the configured port; they then hold the lock themselves,
 * so a server cannot start under them. The import goes into a database that holds a map only with
 * `--replace` (which copies it into `backups/` first). Both first remove what a killed import,
 * restore or backup left (`<db>.import-<pid>` / `.restore-<pid>` of a dead pid, `*.partial`).
 */

export const CLI_USAGE = [
  'usage: galactic export <file> [--transcripts]',
  '       galactic import <file> [--replace] [--prefer-rows]',
  '       galactic restore <backup file or name in backups/>',
].join('\n');

export interface CliIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Whether a Mission Control answers on `port` (default: `GET /health` on 127.0.0.1). */
  isServerRunning?: (port: number) => Promise<boolean>;
  /** How the data lock's holder is checked (default: the OS). */
  lockProbe?: LockProbe;
}

async function healthAnswers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json()) as { name?: unknown };
    return body.name === 'galactic-agents';
  } catch {
    return false;
  }
}

/** The port Mission Control would listen on: `GALACTIC_PORT`, then config.json, then 4321. */
function configuredPort(env: NodeJS.ProcessEnv, configPath: string): number {
  if (env['GALACTIC_PORT'] !== undefined) return Number(env['GALACTIC_PORT']);
  try {
    const file = JSON.parse(readFileSync(configPath, 'utf8')) as { port?: unknown };
    if (typeof file.port === 'number') return file.port;
  } catch {
    // no config file yet: the default port
  }
  return DEFAULT_PORT;
}

/** Runs one command; resolves with the process exit code. */
export async function runCli(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const positional = rest.filter((a) => !a.startsWith('--'));
  const file = positional[0];
  const known: Record<string, string[]> = {
    export: ['--transcripts'],
    import: ['--replace', '--prefer-rows'],
    restore: [],
  };
  const allowed = command && Object.hasOwn(known, command) ? known[command] : undefined;
  if (!allowed || !file || positional.length > 1 || [...flags].some((f) => !allowed.includes(f))) {
    io.err(CLI_USAGE);
    return 2;
  }
  const paths = dataPaths(io.env);

  if (command === 'export') {
    if (!existsSync(paths.dbPath)) {
      io.err(`No database at ${paths.dbPath}.`);
      return 1;
    }
    const db = new BetterSqlite3(paths.dbPath, { readonly: true, fileMustExist: true });
    try {
      const exported = exportMap(db, { transcripts: flags.has('--transcripts') });
      writeFileSync(file, JSON.stringify(exported) + '\n', { mode: 0o600 });
      chmodSync(file, 0o600); // an existing file keeps its mode otherwise
      io.out(
        `Exported ${exported.events.length} events (seq ${exported.source.seq}), ` +
          `${exported.rows.projects.length} projects and ${exported.rows.tasks.length} tasks` +
          (exported.transcripts
            ? `, ${exported.transcripts.chunks.length} transcript chunks`
            : '') +
          ` to ${file}.`,
      );
      return 0;
    } catch (error) {
      io.err(error instanceof ExportError ? error.message : `Export failed: ${String(error)}`);
      return 1;
    } finally {
      db.close();
    }
  }

  // import and restore replace the database: never under a running server
  const probe = io.lockProbe ?? DEFAULT_LOCK_PROBE;
  const holder = liveLockHolder(paths.dbPath, probe);
  if (holder) {
    io.err(`${describeHolder(holder)} is using ${paths.dbPath}: stop it first, then ${command}.`);
    return 1;
  }
  const port = configuredPort(io.env, paths.configPath);
  if (await (io.isServerRunning ?? healthAnswers)(port)) {
    io.err(`Mission Control is running on port ${port}: stop it first, then ${command}.`);
    return 1;
  }
  let lock: DataLock;
  try {
    lock = acquireDataLock(paths.dbPath, command === 'restore' ? 'restore' : 'import', { probe });
  } catch (error) {
    io.err(
      error instanceof DataLockError
        ? `${error.message} Stop it first, then ${command}.`
        : `Cannot take the data lock: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  try {
    const backupDir = join(paths.dataDir, BACKUP_DIR);
    for (const name of [
      ...removeStaleTempDatabases(paths.dbPath, (pid) => probe.alive(pid)),
      ...removePartialBackups(backupDir),
    ]) {
      io.out(`Removed ${name}, left by an import, restore or backup that did not finish.`);
    }
    return await replaceDatabase(
      command as 'import' | 'restore',
      file,
      flags,
      paths.dbPath,
      backupDir,
      io,
    );
  } finally {
    lock.release();
  }
}

/** The import or the restore proper, with the data lock held. */
async function replaceDatabase(
  command: 'import' | 'restore',
  file: string,
  flags: Set<string>,
  dbPath: string,
  backupDir: string,
  io: CliIo,
): Promise<number> {
  const paths = { dbPath };

  if (command === 'restore') {
    // A bare name is looked up in the backups folder (as the settings page lists it).
    const source = existsSync(file) || file.includes('/') ? file : join(backupDir, file);
    try {
      const report = await restoreBackup(paths.dbPath, source, { backupDir });
      if (report.replacedBackup) {
        io.out(`The previous database was copied to ${report.replacedBackup}.`);
      }
      io.out(
        `Restored ${source} (events up to seq ${report.seq}) into ${paths.dbPath}. Start ` +
          'Mission Control: agents that were running when the backup was taken resume as after a restart.',
      );
      return 0;
    } catch (error) {
      io.err(error instanceof RestoreError ? error.message : `Restore failed: ${String(error)}`);
      return 1;
    }
  }

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    io.err(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  try {
    const report = await importMap(paths.dbPath, input, {
      replace: flags.has('--replace'),
      preferRows: flags.has('--prefer-rows'),
      backupDir,
    });
    if (report.replacedBackup)
      io.out(`The previous database was copied to ${report.replacedBackup}.`);
    if (report.rebuilt === 'rows') {
      io.out(`The rebuild differed from the exported rows; the exported rows were written:`);
      for (const line of report.drift.slice(0, 20)) io.out(`  ${line}`);
    }
    io.out(
      `Imported ${report.events} events (seq ${report.seq}), ${report.rows.projects} projects and ` +
        `${report.rows.tasks} tasks into ${paths.dbPath}` +
        (report.transcriptChunks > 0 ? ` with ${report.transcriptChunks} transcript chunks` : '') +
        '. Start Mission Control: agents that were running resume as after a restart.',
    );
    return 0;
  } catch (error) {
    if (error instanceof ImportError) {
      io.err(error.message);
      for (const line of error.drift.slice(0, 20)) io.err(`  ${line}`);
      if (error.drift.length > 20) io.err(`  … and ${error.drift.length - 20} more`);
      return 1;
    }
    io.err(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
