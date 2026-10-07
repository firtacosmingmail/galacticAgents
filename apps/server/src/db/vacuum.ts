import type { Database } from 'better-sqlite3';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Giving disk space back after transcript retention (P8-02; TECHNOLOGY §6.2). SQLite never
 * shrinks its file on DELETE: freed pages go to a free list and are reused by later writes. To
 * shrink it without a full VACUUM — which rewrites the whole file in one synchronous call and so
 * blocks the event loop for as long as that takes — the database runs with
 * `auto_vacuum = INCREMENTAL`, and the retention job releases the free list a few pages at a time
 * (`PRAGMA incremental_vacuum(n)`), yielding to the event loop between steps.
 *
 * A database created before P8-02 has `auto_vacuum = NONE`, and switching costs one full VACUUM;
 * `startupConversion` runs it once at startup, before the server listens. In WAL mode a VACUUM
 * writes the whole database through the WAL, so it needs about twice the database's size free
 * (a copy in the WAL, then the checkpoint back): it is skipped, with the reason logged, unless the
 * disk has `CONVERSION_SPACE_FACTOR` × the database free. Whatever its outcome the WAL is then
 * truncated (`wal_checkpoint(TRUNCATE)`), so a failed or finished conversion never leaves a WAL
 * as big as the database behind; `journal_size_limit` (`openDatabase`) caps it after any later
 * big write. A failed conversion leaves the database working as before (freed pages are still
 * reused, the file just does not shrink); after `MAX_CONVERSION_ATTEMPTS` failures it is no longer
 * tried at every start — the log says how to try again (`GALACTIC_VACUUM_RETRY=1`).
 */

/** `PRAGMA auto_vacuum`: 0 none, 1 full, 2 incremental. */
export function autoVacuumMode(db: Database): 'none' | 'full' | 'incremental' {
  const mode = db.pragma('auto_vacuum', { simple: true }) as number;
  return mode === 2 ? 'incremental' : mode === 1 ? 'full' : 'none';
}

export interface ConversionResult {
  converted: boolean;
  ms: number;
  error?: unknown;
}

/** Switches an existing database to incremental auto-vacuum (one full VACUUM); a no-op if it is. */
export function convertToIncrementalVacuum(db: Database): ConversionResult {
  if (autoVacuumMode(db) === 'incremental') return { converted: false, ms: 0 };
  const started = performance.now();
  try {
    db.pragma('auto_vacuum = INCREMENTAL');
    db.exec('VACUUM');
    return { converted: autoVacuumMode(db) === 'incremental', ms: performance.now() - started };
  } catch (error) {
    return { converted: false, ms: performance.now() - started, error };
  }
}

/** Free disk space needed for the conversion, as a multiple of the database's size. */
export const CONVERSION_SPACE_FACTOR = 2.2;
/** Failed conversions after which startup stops trying (settings key `CONVERSION_FAILURES_KEY`). */
export const MAX_CONVERSION_ATTEMPTS = 3;
export const CONVERSION_FAILURES_KEY = 'vacuum_conversion_failures';
/** The environment variable that clears the failure count, so the next start tries again. */
export const CONVERSION_RETRY_ENV = 'GALACTIC_VACUUM_RETRY';

export interface StartupConversionOptions {
  /** The database file (`':memory:'` skips the space check). */
  dbPath: string;
  /** Free bytes on the file system holding `dir`; default `fs.statfsSync`. */
  freeBytes?: (dir: string) => number;
  /** Forget earlier failures and try again (`GALACTIC_VACUUM_RETRY=1`). */
  retry?: boolean;
  maxAttempts?: number;
  /** The conversion itself (tests make it fail). */
  convert?: (db: Database) => ConversionResult;
  log?: { info(message: string): void; warn(message: string): void };
}

export type StartupConversion =
  | { outcome: 'already' }
  | { outcome: 'converted'; ms: number }
  | { outcome: 'skipped'; reason: 'disk-space' | 'gave-up'; detail: string }
  | { outcome: 'failed'; error: unknown; failures: number };

/** Free bytes for an unprivileged user on the file system holding `dir` (`fs.statfsSync`). */
export const diskFree = (dir: string): number => {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
};

const mib = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MiB`;

/** Failed conversions so far (a missing or unreadable count is 0). */
function failuresOf(db: Database): number {
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(CONVERSION_FAILURES_KEY) as { value: string } | undefined;
    const n = row ? Number(JSON.parse(row.value)) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function setFailures(db: Database, n: number): void {
  try {
    if (n === 0) db.prepare('DELETE FROM settings WHERE key = ?').run(CONVERSION_FAILURES_KEY);
    else {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(CONVERSION_FAILURES_KEY, JSON.stringify(n));
    }
  } catch {
    // A full disk may refuse this too: the next start simply tries again.
  }
}

/** Truncates the WAL (it holds a copy of the database after a VACUUM, finished or not). */
export function truncateWal(db: Database): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Nothing to give back (not WAL, or a reader holds it): the size limit trims it later.
  }
}

/**
 * The startup conversion to incremental auto-vacuum (P8-02, review fix): skipped when the disk
 * lacks room for it or after `maxAttempts` failures, the WAL truncated after any attempt.
 */
export function startupConversion(db: Database, opts: StartupConversionOptions): StartupConversion {
  if (autoVacuumMode(db) === 'incremental') {
    if (failuresOf(db) > 0) setFailures(db, 0);
    return { outcome: 'already' };
  }
  const log = opts.log ?? { info: () => {}, warn: () => {} };
  const max = opts.maxAttempts ?? MAX_CONVERSION_ATTEMPTS;
  if (opts.retry) setFailures(db, 0);
  const failures = failuresOf(db);
  if (failures >= max) {
    const detail =
      `the conversion to incremental auto-vacuum failed ${failures} times and is no longer tried ` +
      `at startup; start once with ${CONVERSION_RETRY_ENV}=1 to try again (the database works ` +
      'without it: freed space is reused, the file just does not shrink)';
    log.warn(`[db] ${detail}`);
    return { outcome: 'skipped', reason: 'gave-up', detail };
  }
  if (opts.dbPath !== ':memory:') {
    const { pages, pageSize } = pageStats(db);
    const size = pages * pageSize;
    const needed = Math.ceil(size * CONVERSION_SPACE_FACTOR);
    let free: number | undefined;
    try {
      free = (opts.freeBytes ?? diskFree)(dirname(opts.dbPath));
    } catch {
      free = undefined; // unknown: try anyway, a failure is counted and the WAL truncated
    }
    if (free !== undefined && free < needed) {
      const detail =
        `not converting the database to incremental auto-vacuum: it needs about ${mib(needed)} ` +
        `free (${CONVERSION_SPACE_FACTOR}× the ${mib(size)} database) and the disk has ` +
        `${mib(free)}; tried again at the next start`;
      log.warn(`[db] ${detail}`);
      return { outcome: 'skipped', reason: 'disk-space', detail };
    }
  }
  log.info('Converting the database to incremental auto-vacuum (once)…');
  let result: ConversionResult;
  try {
    result = (opts.convert ?? convertToIncrementalVacuum)(db);
  } catch (error) {
    result = { converted: false, ms: 0, error };
  }
  const count = result.converted ? 0 : failures + 1;
  setFailures(db, count);
  // Last: the VACUUM (and the count) went through the WAL, which now holds a copy of the database.
  truncateWal(db);
  if (result.converted) {
    log.info(`Converted in ${Math.round(result.ms)} ms`);
    return { outcome: 'converted', ms: result.ms };
  }
  const error = result.error ?? new Error('auto_vacuum is still not incremental');
  log.warn(
    `[db] could not convert to incremental auto-vacuum (attempt ${count} of ${max}): ` +
      `${error instanceof Error ? error.message : String(error)}` +
      (count >= max
        ? `; no longer tried at startup — start once with ${CONVERSION_RETRY_ENV}=1 to try again`
        : '; tried again at the next start'),
  );
  return { outcome: 'failed', error, failures: count };
}

/** Pages in the database file and on its free list, and the page size. */
export function pageStats(db: Database): { pages: number; free: number; pageSize: number } {
  return {
    pages: db.pragma('page_count', { simple: true }) as number,
    free: db.pragma('freelist_count', { simple: true }) as number,
    pageSize: db.pragma('page_size', { simple: true }) as number,
  };
}

export interface VacuumReport {
  mode: 'none' | 'full' | 'incremental';
  /** Pages handed back to the file system. */
  pagesFreed: number;
  steps: number;
  /** The longest synchronous step (the longest the event loop was held), in ms. */
  longestStepMs: number;
  ms: number;
}

/**
 * Pages released per step: 256 × 4 KiB = 1 MiB, ≈ 3–30 ms; a step that crosses the WAL's
 * auto-checkpoint (1 000 pages) also pays the checkpoint's fsync (≈ 0.1 s). See P8-02 notes.
 */
export const VACUUM_STEP_PAGES = 256;

export const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Releases the free list in steps of `stepPages`, awaiting `pause` between steps. The moved
 * pages go through the WAL, which SQLite's auto-checkpoint copies back as usual (an explicit
 * TRUNCATE checkpoint measured up to ≈ 0.4 s in one go, so there is none). Without incremental
 * auto-vacuum it does nothing: the free pages are reused by later writes.
 */
export async function vacuumIncrementally(
  db: Database,
  opts: { stepPages?: number; pause?: () => Promise<void> } = {},
): Promise<VacuumReport> {
  const mode = autoVacuumMode(db);
  const report: VacuumReport = {
    mode,
    pagesFreed: 0,
    steps: 0,
    longestStepMs: 0,
    ms: 0,
  };
  if (mode !== 'incremental') return report;
  const step = opts.stepPages ?? VACUUM_STEP_PAGES;
  const pause = opts.pause ?? nextTick;
  const started = performance.now();
  for (;;) {
    const before = db.pragma('freelist_count', { simple: true }) as number;
    if (before === 0) break;
    const t = performance.now();
    db.pragma(`incremental_vacuum(${step})`);
    const after = db.pragma('freelist_count', { simple: true }) as number;
    report.longestStepMs = Math.max(report.longestStepMs, performance.now() - t);
    report.steps += 1;
    report.pagesFreed += before - after;
    if (after >= before) break; // nothing moved (a reader holds the pages): try next run
    await pause();
  }
  report.ms = performance.now() - started;
  return report;
}
