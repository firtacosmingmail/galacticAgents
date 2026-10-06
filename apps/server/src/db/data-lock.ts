import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  bootTime,
  isAlive,
  processStartTime,
  START_TIME_TOLERANCE_MS,
} from '../runtime/supervisor.js';

/**
 * The data lock (P8-03 review): one file next to the database, `<db>.lock`, that says which
 * process owns the database — a running Mission Control from its start to its exit, or a
 * `galactic import` / `galactic restore` while it replaces the file. Only one holder at a time:
 * two servers on one database, or an import renaming a new file under a running server, would
 * each corrupt what the other believes it holds.
 *
 * The file holds the holder's pid, its process start time (`ps lstart`, so a recycled pid is not
 * taken for the holder), the machine's boot time, what it is (`server` / `import` / `restore`),
 * and the server's port and host once it listens. It is created with `O_EXCL`; a lock whose pid
 * is not alive, whose process started at another time, or that was written in another boot is
 * **stale** and is taken over. A clean exit removes it; a killed holder leaves it, and the next
 * start takes it over as stale. A lock the reader cannot parse (a holder killed while writing
 * it) counts as stale too, since the write is a few bytes right after the create.
 */

export type DataLockRole = 'server' | 'import' | 'restore';

export interface DataLockInfo {
  pid: number;
  role: DataLockRole;
  /** The holder's process start time (epoch ms, 1 s resolution), when `ps` could read it. */
  processStart?: number;
  /** When the machine booted (ISO), as the holder saw it. */
  bootAt: string;
  /** When the holder took the lock (ISO). */
  since: string;
  /** The server's port and host, once it listens. */
  port?: number;
  host?: string;
}

/** How a lock's holder is checked; the default asks the OS (tests pass a fake). */
export interface LockProbe {
  alive(pid: number): boolean;
  startTime(pid: number): number | undefined;
  bootAt(): string;
}

export const DEFAULT_LOCK_PROBE: LockProbe = {
  alive: isAlive,
  startTime: processStartTime,
  bootAt: bootTime,
};

export class DataLockError extends Error {
  constructor(
    message: string,
    readonly holder: DataLockInfo,
  ) {
    super(message);
    this.name = 'DataLockError';
  }
}

export function lockPathOf(dbPath: string): string {
  return `${dbPath}.lock`;
}

export function readDataLock(path: string): DataLockInfo | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DataLockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.role !== 'string') return undefined;
    return parsed as DataLockInfo;
  } catch {
    return undefined;
  }
}

/** Whether the lock's holder is still the process that wrote it. */
export function holderAlive(info: DataLockInfo, probe: LockProbe = DEFAULT_LOCK_PROBE): boolean {
  if (!probe.alive(info.pid)) return false;
  if (
    typeof info.bootAt === 'string' &&
    Math.abs(Date.parse(info.bootAt) - Date.parse(probe.bootAt())) > 60_000
  ) {
    return false; // another boot: the pid was handed out again
  }
  if (info.processStart !== undefined) {
    const started = probe.startTime(info.pid);
    if (started !== undefined && Math.abs(started - info.processStart) > START_TIME_TOLERANCE_MS) {
      return false; // a recycled pid
    }
  }
  return true;
}

/** The live holder of the database's lock, or `undefined` when there is none (or it is stale). */
export function liveLockHolder(
  dbPath: string,
  probe: LockProbe = DEFAULT_LOCK_PROBE,
): DataLockInfo | undefined {
  const info = readDataLock(lockPathOf(dbPath));
  return info && holderAlive(info, probe) ? info : undefined;
}

/** "Mission Control (pid 123, port 4321)" / "a galactic import (pid 123)". */
export function describeHolder(info: DataLockInfo): string {
  if (info.role === 'server') {
    return `Mission Control (pid ${info.pid}${info.port !== undefined ? `, port ${info.port}` : ', starting'})`;
  }
  return `a galactic ${info.role} (pid ${info.pid})`;
}

export interface DataLock {
  readonly path: string;
  readonly info: DataLockInfo;
  /** Records the server's port and host once it listens. */
  update(fields: Pick<DataLockInfo, 'port' | 'host'>): void;
  /** Removes the lock if it is still this process's. Idempotent. */
  release(): void;
}

/**
 * Takes the database's lock for this process, or throws `DataLockError` naming the live holder.
 * A stale lock is replaced.
 */
export function acquireDataLock(
  dbPath: string,
  role: DataLockRole,
  opts: { probe?: LockProbe; pid?: number; now?: () => string } = {},
): DataLock {
  const probe = opts.probe ?? DEFAULT_LOCK_PROBE;
  const pid = opts.pid ?? process.pid;
  const path = lockPathOf(dbPath);
  const processStart = probe.startTime(pid);
  let info: DataLockInfo = {
    pid,
    role,
    ...(processStart !== undefined ? { processStart } : {}),
    bootAt: probe.bootAt(),
    since: (opts.now ?? (() => new Date().toISOString()))(),
  };
  const write = () => writeFileSync(path, JSON.stringify(info) + '\n', { mode: 0o600 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let taken = false;
  for (let attempt = 0; attempt < 2 && !taken; attempt++) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      write();
      taken = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readDataLock(path);
      if (holder && holderAlive(holder, probe)) {
        throw new DataLockError(
          `${describeHolder(holder)} is using ${dbPath} (lock ${path}).`,
          holder,
        );
      }
      rmSync(path, { force: true }); // stale: its holder is gone
    }
  }
  if (!taken) throw new Error(`Could not take ${path}: another process keeps creating it.`);
  let released = false;
  return {
    path,
    get info() {
      return info;
    },
    update(fields) {
      if (released) return;
      info = { ...info, ...fields };
      write();
    },
    release() {
      if (released) return;
      released = true;
      const current = readDataLock(path);
      if (current?.pid === pid && current.since === info.since) rmSync(path, { force: true });
    },
  };
}

/**
 * Removes the temporary databases an import or a restore left when it was killed
 * (`<db>.import-<pid>`, `<db>.restore-<pid>` and their `-wal` / `-shm` / `-journal`), when their
 * pid is no longer alive. Returns the files removed.
 */
export function removeStaleTempDatabases(
  dbPath: string,
  alive: (pid: number) => boolean = isAlive,
): string[] {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:import|restore)-(\\d+)(?:-wal|-shm|-journal)?$`,
  );
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const m = pattern.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid !== process.pid && alive(pid)) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(name);
  }
  return removed;
}
