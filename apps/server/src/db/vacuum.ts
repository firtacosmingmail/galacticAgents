import type { Database } from 'better-sqlite3';

/**
 * Giving disk space back after transcript retention (P8-02; TECHNOLOGY §6.2). SQLite never
 * shrinks its file on DELETE: freed pages go to a free list and are reused by later writes. To
 * shrink it without a full VACUUM — which rewrites the whole file in one synchronous call and so
 * blocks the event loop for as long as that takes — the database runs with
 * `auto_vacuum = INCREMENTAL`, and the retention job releases the free list a few pages at a time
 * (`PRAGMA incremental_vacuum(n)`), yielding to the event loop between steps.
 *
 * A database created before P8-02 has `auto_vacuum = NONE`, and switching costs one full VACUUM;
 * `convertToIncrementalVacuum` runs it once at startup, before the server listens. If it fails (a
 * full disk: VACUUM needs room for a copy) the database keeps working as before; freed pages are
 * still reused, the file just does not shrink, and the conversion is tried again at the next start.
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
