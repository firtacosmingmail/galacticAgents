import BetterSqlite3, { type Database } from 'better-sqlite3';
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_BACKUP_SCHEDULE,
  type BackupInfo,
  type BackupKind,
  type BackupOutcome,
  type BackupSchedule,
  type BackupsResponse,
} from '@galactic/protocol';
import type { Timers } from '../runtime/archival.js';
import { diskFree } from './vacuum.js';

/**
 * Scheduled and manual SQLite backups (P8-03; TECHNOLOGY §6.4, docs/BACKUP_RESTORE.md).
 *
 * A backup is a complete copy of the database taken with SQLite's online backup API
 * (better-sqlite3 `db.backup`): pages are copied a step at a time, awaiting the event loop between
 * steps, so the server keeps serving while it runs, and the copy is a consistent state of the
 * database (writes made meanwhile through the same connection are carried into it). The copy is
 * written as `<name>.partial` (created 0600 before SQLite opens it), switched to a rollback
 * journal so it is one self-contained file, checked with `PRAGMA quick_check`, and only then
 * renamed to its final name; a failed or corrupt copy is removed.
 *
 * The daily backup runs when the server is idle-ish: it is due 24 h after the newest automatic
 * one (read from the file names, so a restart does not reset the clock), and is taken at the first
 * check (every 15 min) when the log has been quiet for 2 min — or regardless once it is 6 h
 * overdue. It is skipped, with one log line per episode, when the disk would keep less than
 * `reserveBytes` free after the copy: a backup must never be what fills the disk under the live
 * database (P8-04, decision 99). After each backup the folder is rotated: the newest automatic
 * backup of each of the last `keepDaily` days and of each of the last `keepWeekly` ISO weeks
 * (UTC), and the newest `keepManual` manual and pre-import copies each, are kept.
 */

export const BACKUP_DIR = 'backups';
/** How often the schedule looks whether a backup is due. */
export const BACKUP_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NAME = /^galactic-(\d{8}T\d{9}Z)-(auto|manual|pre-import)\.sqlite$/;

export interface BackupServiceOptions {
  db: Database;
  /** `<dataDir>/backups`. */
  dir: string;
  schedule?: Partial<BackupSchedule>;
  /** Time between automatic backups (default 24 h). */
  intervalMs?: number;
  /** How long the log must have been quiet for a due backup to start (default 2 min). */
  idleMs?: number;
  /** How long a due backup waits for a quiet moment before it runs anyway (default 6 h). */
  maxDeferMs?: number;
  /** Free space the disk must keep after the copy (default 1 GiB). */
  reserveBytes?: number;
  /** Pages copied per step of the online backup (default 1024, 4 MiB at the default page size). */
  stepPages?: number;
  now?: () => string;
  /** Free bytes on the file system holding a folder; default `fs.statfsSync`. */
  freeBytes?: (dir: string) => number;
  /** When the log last changed (default: the newest event's `at`). */
  lastActivityAt?: () => string | undefined;
  timers?: Timers;
  log?: { info(message: string): void; warn(message: string): void };
}

const NODE_TIMERS: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.(); // never keeps the process alive
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** `2026-10-06T12:30:05.123Z` → `20261006T123005123Z` (sorts like the time). */
export function stampOf(iso: string): string {
  return iso.replace(/[-:.]/g, '');
}

function isoOfStamp(stamp: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp)!;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`;
}

export function backupName(kind: BackupKind, at: string): string {
  return `galactic-${stampOf(new Date(at).toISOString())}-${kind}.sqlite`;
}

/** The backups in `dir`, newest first (files that are not backups are ignored). */
export function listBackups(dir: string): BackupInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    let bytes: number;
    try {
      bytes = statSync(join(dir, name)).size;
    } catch {
      continue; // removed meanwhile
    }
    out.push({ name, kind: m[2] as BackupKind, createdAt: isoOfStamp(m[1]!), bytes });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.name < b.name ? 1 : -1));
}

const dayKey = (iso: string) => Math.floor(Date.parse(iso) / DAY_MS);
/** ISO weeks start on Monday; 1970-01-01 was a Thursday, hence the 3 days. */
const weekKey = (iso: string) => Math.floor((dayKey(iso) + 3) / 7);

/**
 * The rotation: which backups to delete. Automatic ones: the newest of each of the last
 * `keepDaily` days that have one, plus the newest of each of the last `keepWeekly` weeks; manual
 * and pre-import copies: the newest `keepManual` of each kind.
 */
export function backupsToRemove(
  backups: readonly BackupInfo[],
  schedule: Pick<BackupSchedule, 'keepDaily' | 'keepWeekly' | 'keepManual'>,
): BackupInfo[] {
  const newestFirst = [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set<string>();
  const newestPer = (key: (iso: string) => number, limit: number) => {
    const seen = new Set<number>();
    for (const b of newestFirst) {
      if (b.kind !== 'auto') continue;
      const k = key(b.createdAt);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.name);
    }
  };
  newestPer(dayKey, schedule.keepDaily);
  newestPer(weekKey, schedule.keepWeekly);
  for (const kind of ['manual', 'pre-import'] as const) {
    newestFirst
      .filter((b) => b.kind === kind)
      .slice(0, schedule.keepManual)
      .forEach((b) => keep.add(b.name));
  }
  return newestFirst.filter((b) => !keep.has(b.name));
}

const mib = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MiB`;

/** The database's size in pages (what the backup copies; the WAL's frames are folded in). */
export function databaseBytes(db: Database): number {
  const pages = db.pragma('page_count', { simple: true }) as number;
  const size = db.pragma('page_size', { simple: true }) as number;
  return pages * size;
}

/**
 * Copies `db` to `file` with the online backup API (stepwise, yielding between steps), makes the
 * copy a single file (rollback journal), mode 0600, and checks it. Throws on failure, leaving no
 * file behind.
 */
export async function backupTo(db: Database, file: string, stepPages = 1024): Promise<void> {
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });
  // Created 0600 before SQLite opens it, so the copy is never readable by others, not even briefly.
  closeSync(openSync(partial, 'wx', 0o600));
  try {
    await db.backup(partial, { progress: () => stepPages });
    const copy = new BetterSqlite3(partial);
    try {
      // The copy inherits WAL mode from the source's header; a backup is one file.
      copy.pragma('journal_mode = DELETE');
      const check = copy.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`the copy failed its integrity check: ${String(check)}`);
    } finally {
      copy.close();
    }
    chmodSync(partial, 0o600);
    renameSync(partial, file);
  } catch (error) {
    for (const f of [partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`]) {
      rmSync(f, { force: true });
    }
    throw error;
  }
}

export class BackupService {
  readonly dir: string;
  readonly schedule: BackupSchedule;
  private readonly db: Database;
  private readonly intervalMs: number;
  private readonly idleMs: number;
  private readonly maxDeferMs: number;
  private readonly reserveBytes: number;
  private readonly stepPages: number;
  private readonly now: () => string;
  private readonly freeBytes: (dir: string) => number;
  private readonly lastActivityAt: () => string | undefined;
  private readonly timers: Timers;
  private readonly log: { info(message: string): void; warn(message: string): void };
  private inFlight: Promise<BackupOutcome> | undefined;
  private handle: unknown;
  private lastOutcome: BackupOutcome | undefined;
  /** The disk-space skip was logged; cleared by the next backup that runs. */
  private lowSpaceLogged = false;

  constructor(opts: BackupServiceOptions) {
    this.db = opts.db;
    this.dir = opts.dir;
    this.schedule = { ...DEFAULT_BACKUP_SCHEDULE, ...opts.schedule };
    this.intervalMs = opts.intervalMs ?? DAY_MS;
    this.idleMs = opts.idleMs ?? 2 * 60 * 1000;
    this.maxDeferMs = opts.maxDeferMs ?? 6 * 60 * 60 * 1000;
    this.reserveBytes = opts.reserveBytes ?? 2 ** 30;
    this.stepPages = opts.stepPages ?? 1024;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.freeBytes = opts.freeBytes ?? diskFree;
    const newest = opts.db.prepare('SELECT at FROM events ORDER BY id DESC LIMIT 1');
    this.lastActivityAt =
      opts.lastActivityAt ?? (() => (newest.get() as { at: string } | undefined)?.at);
    this.timers = opts.timers ?? NODE_TIMERS;
    this.log = opts.log ?? { info: () => {}, warn: () => {} };
  }

  list(): BackupInfo[] {
    return listBackups(this.dir);
  }

  get last(): BackupOutcome | undefined {
    return this.lastOutcome;
  }

  get running(): boolean {
    return this.inFlight !== undefined;
  }

  response(): BackupsResponse {
    return {
      backups: this.list(),
      directory: this.dir,
      schedule: this.schedule,
      running: this.running,
      ...(this.lastOutcome ? { last: this.lastOutcome } : {}),
    };
  }

  /**
   * Takes a backup now. A call while one is running gets that one's outcome. Never throws: the
   * outcome says what happened.
   */
  backupNow(kind: BackupKind = 'manual'): Promise<BackupOutcome> {
    this.inFlight ??= this.take(kind).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Whether the automatic backup is due by now, and may start (idle, or overdue). */
  due(at = this.now()): boolean {
    if (!this.schedule.enabled) return false;
    const newest = this.list().find((b) => b.kind === 'auto');
    const now = Date.parse(at);
    const dueSince = newest ? Date.parse(newest.createdAt) + this.intervalMs : -Infinity;
    if (now < dueSince) return false;
    if (now - dueSince >= this.maxDeferMs) return true;
    const last = this.lastActivityAt();
    return last === undefined || now - Date.parse(last) >= this.idleMs;
  }

  /** One check of the schedule: takes the automatic backup if it is due. */
  async tick(): Promise<BackupOutcome | undefined> {
    if (this.running || !this.due()) return undefined;
    return this.backupNow('auto');
  }

  start(checkIntervalMs = BACKUP_CHECK_INTERVAL_MS, { immediate = true } = {}): void {
    if (this.handle !== undefined) return;
    const check = () => {
      this.tick().catch((error: unknown) => this.log.warn(`[backup] ${String(error)}`));
    };
    this.handle = this.timers.setInterval(check, checkIntervalMs);
    if (immediate) check();
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }

  private async take(kind: BackupKind): Promise<BackupOutcome> {
    const at = this.now();
    const started = performance.now();
    const outcome = (o: Omit<BackupOutcome, 'at' | 'kind'>): BackupOutcome => {
      this.lastOutcome = { at, kind, ...o };
      return this.lastOutcome;
    };
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const size = databaseBytes(this.db);
      const free = this.freeBytes(this.dir);
      if (free < size + this.reserveBytes) {
        const detail =
          `the disk has ${mib(free)} free; a backup of ${mib(size)} needs ` +
          `${mib(size + this.reserveBytes)} (it keeps ${mib(this.reserveBytes)} free)`;
        if (!this.lowSpaceLogged || kind !== 'auto') {
          this.log.warn(`[backup] skipped: ${detail}`);
          this.lowSpaceLogged = true;
        }
        return outcome({ outcome: 'skipped', detail });
      }
      this.lowSpaceLogged = false;
      const name = backupName(kind, at);
      await backupTo(this.db, join(this.dir, name), this.stepPages);
      const bytes = statSync(join(this.dir, name)).size;
      const ms = Math.round(performance.now() - started);
      this.log.info(`[backup] ${name} (${mib(bytes)}, ${ms} ms)`);
      this.rotate();
      return outcome({ outcome: 'ok', name, bytes, ms });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log.warn(`[backup] failed: ${detail}`);
      return outcome({ outcome: 'failed', detail, ms: Math.round(performance.now() - started) });
    }
  }

  /** Deletes what the rotation does not keep. */
  rotate(): BackupInfo[] {
    const gone = backupsToRemove(this.list(), this.schedule);
    for (const b of gone) rmSync(join(this.dir, b.name), { force: true });
    return gone;
  }
}
