import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireDataLock,
  DataLockError,
  liveLockHolder,
  lockPathOf,
  readDataLock,
  removeStaleTempDatabases,
  type LockProbe,
} from './data-lock.js';

/** P8-03 review — the data lock: one owner of the database at a time; stale locks taken over. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'galactic-lock-'));
  dirs.push(d);
  return join(d, 'galactic.sqlite');
}

const BOOT = '2026-10-06T06:00:00.000Z';
/** A fake process table: pid → start time. */
function probe(procs: Map<number, number>, bootAt = BOOT): LockProbe {
  return {
    alive: (pid) => procs.has(pid),
    startTime: (pid) => procs.get(pid),
    bootAt: () => bootAt,
  };
}

describe('the data lock (P8-03 review)', () => {
  it('is held by one process; a second one is refused with the holder named', () => {
    const db = dbPath();
    const procs = new Map([
      [100, 1_000_000],
      [200, 2_000_000],
    ]);
    const lock = acquireDataLock(db, 'server', { probe: probe(procs), pid: 100 });
    expect(readDataLock(lockPathOf(db))).toMatchObject({
      pid: 100,
      role: 'server',
      processStart: 1_000_000,
      bootAt: BOOT,
    });
    lock.update({ port: 4999, host: '127.0.0.1' });
    expect(liveLockHolder(db, probe(procs))).toMatchObject({ pid: 100, port: 4999 });

    let refused: unknown;
    try {
      acquireDataLock(db, 'import', { probe: probe(procs), pid: 200 });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(DataLockError);
    expect((refused as Error).message).toMatch(/Mission Control \(pid 100, port 4999\)/);

    lock.release();
    expect(existsSync(lockPathOf(db))).toBe(false);
    lock.release(); // idempotent
    const next = acquireDataLock(db, 'import', { probe: probe(procs), pid: 200 });
    expect(liveLockHolder(db, probe(procs))?.role).toBe('import');
    next.release();
  });

  it('a server still starting (no port yet) holds it too', () => {
    const db = dbPath();
    const procs = new Map([[100, 1_000_000]]);
    acquireDataLock(db, 'server', { probe: probe(procs), pid: 100 });
    expect(() => acquireDataLock(db, 'restore', { probe: probe(procs), pid: 300 })).toThrow(
      /Mission Control \(pid 100, starting\)/,
    );
  });

  it('takes over a stale lock: dead pid, recycled pid, another boot, unreadable file', () => {
    const db = dbPath();
    const procs = new Map([[100, 1_000_000]]);
    // Dead holder.
    acquireDataLock(db, 'server', { probe: probe(procs), pid: 100 });
    procs.delete(100);
    expect(liveLockHolder(db, probe(procs))).toBeUndefined();
    procs.set(200, 2_000_000);
    acquireDataLock(db, 'server', { probe: probe(procs), pid: 200 });
    expect(readDataLock(lockPathOf(db))?.pid).toBe(200);

    // The pid now belongs to another process (started later than the holder).
    procs.set(200, 9_000_000);
    expect(liveLockHolder(db, probe(procs))).toBeUndefined();
    procs.set(300, 3_000_000);
    acquireDataLock(db, 'server', { probe: probe(procs), pid: 300 });

    // Written in another boot.
    expect(liveLockHolder(db, probe(procs, '2026-10-07T06:00:00.000Z'))).toBeUndefined();

    // A holder killed while writing it.
    writeFileSync(lockPathOf(db), '{"pid": 3');
    expect(liveLockHolder(db, probe(procs))).toBeUndefined();
    procs.set(400, 4_000_000);
    expect(() => acquireDataLock(db, 'server', { probe: probe(procs), pid: 400 })).not.toThrow();
  });

  it('release leaves a lock another process took over alone', () => {
    const db = dbPath();
    const procs = new Map([
      [100, 1_000_000],
      [200, 2_000_000],
    ]);
    const first = acquireDataLock(db, 'server', { probe: probe(procs), pid: 100 });
    procs.delete(100); // "dies"; a new server takes the stale lock over
    acquireDataLock(db, 'server', { probe: probe(procs), pid: 200 });
    first.release();
    expect(readDataLock(lockPathOf(db))?.pid).toBe(200);
  });

  it('removes temp databases of imports and restores whose pid is gone', () => {
    const db = dbPath();
    const dir = join(db, '..');
    for (const f of [
      'galactic.sqlite.import-111',
      'galactic.sqlite.import-111-wal',
      'galactic.sqlite.restore-222-journal',
      'galactic.sqlite.import-333',
      'galactic.sqlite',
      'galactic.sqlite.lock',
      'other.sqlite.import-111',
    ]) {
      writeFileSync(join(dir, f), '');
    }
    const removed = removeStaleTempDatabases(db, (pid) => pid === 333);
    expect(removed.sort()).toEqual([
      'galactic.sqlite.import-111',
      'galactic.sqlite.import-111-wal',
      'galactic.sqlite.restore-222-journal',
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      'galactic.sqlite',
      'galactic.sqlite.import-333',
      'galactic.sqlite.lock',
      'other.sqlite.import-111',
    ]);
  });
});
