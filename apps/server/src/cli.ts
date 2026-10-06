import BetterSqlite3 from 'better-sqlite3';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataPaths, DEFAULT_PORT } from './config/config.js';
import { BACKUP_DIR } from './db/backup.js';
import { exportMap, ExportError } from './db/map-export.js';
import { importMap, ImportError } from './db/map-import.js';

/**
 * `galactic export <file>` and `galactic import <file>` (P8-03; docs/BACKUP_RESTORE.md), run by
 * `bin/galactic.mjs` against the data folder (`~/.galactic`, `GALACTIC_HOME`, `GALACTIC_DB`).
 *
 * The export opens the database read-only, so it works while Mission Control runs (WAL readers
 * see a consistent state) and writes the file 0600: it holds the whole history, messages included.
 * The import replaces the database, so it refuses while a Mission Control answers on the
 * configured port; into a database that holds a map only with `--replace` (which copies it into
 * `backups/` first).
 */

export const CLI_USAGE = [
  'usage: galactic export <file> [--transcripts]',
  '       galactic import <file> [--replace] [--prefer-rows]',
].join('\n');

export interface CliIo {
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Whether a Mission Control answers on `port` (default: `GET /health` on 127.0.0.1). */
  isServerRunning?: (port: number) => Promise<boolean>;
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
  };
  const allowed = command ? known[command] : undefined;
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

  // import
  const port = configuredPort(io.env, paths.configPath);
  if (await (io.isServerRunning ?? healthAnswers)(port)) {
    io.err(`Mission Control is running on port ${port}: stop it first, then import.`);
    return 1;
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
      backupDir: join(paths.dataDir, BACKUP_DIR),
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
