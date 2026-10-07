import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupInfo } from '@galactic/protocol';
import { seedDemoProject } from '../domain/demo.js';
import { EventLog } from '../domain/event-log.js';
import { openDatabase } from './database.js';
import {
  BackupService,
  backupName,
  backupsToRemove,
  listBackups,
  type BackupServiceOptions,
} from './backup.js';

/** P8-03 — scheduled and manual backups: online copy, 0600, checked, rotated, skipped on a full disk. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(opts: Partial<BackupServiceOptions> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'galactic-backup-'));
  dirs.push(home);
  const db = openDatabase(join(home, 'galactic.sqlite'));
  const log = new EventLog(db);
  log.runCommand((ctx) => seedDemoProject(ctx));
  let now = Date.parse('2026-10-06T10:00:00.000Z');
  const lines: string[] = [];
  const service = new BackupService({
    db,
    dir: join(home, 'backups'),
    now: () => new Date(now).toISOString(),
    freeBytes: () => 100 * 2 ** 30,
    lastActivityAt: () => undefined,
    log: { info: (m) => lines.push(m), warn: (m) => lines.push(m) },
    ...opts,
  });
  return {
    home,
    db,
    log,
    service,
    lines,
    advance: (ms: number) => void (now += ms),
    setNow: (iso: string) => void (now = Date.parse(iso)),
  };
}

const HOUR = 60 * 60 * 1000;

describe('backups (P8-03)', () => {
  it('backs up now: a complete, checked, single-file copy readable only by the user', async () => {
    const { service, log, home } = setup();
    const outcome = await service.backupNow();
    expect(outcome).toMatchObject({ outcome: 'ok', kind: 'manual' });
    const file = join(home, 'backups', outcome.name!);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, 'backups')).mode & 0o777).toBe(0o700);
    // One self-contained file: no WAL or journal beside it, nothing partial left.
    expect(readdirSync(join(home, 'backups'))).toEqual([outcome.name]);
    const copy = new BetterSqlite3(file, { readonly: true });
    expect(copy.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    const events = copy.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(events.n).toBe(log.currentSeq());
    copy.close();
    expect(service.list()).toEqual([
      expect.objectContaining({ name: outcome.name, kind: 'manual', createdAt: outcome.at }),
    ]);
    expect(service.response()).toMatchObject({ running: false, last: { outcome: 'ok' } });
  });

  it('a write while the backup runs does not break it, and two requests share one backup', async () => {
    const { service, log } = setup({ stepPages: 1 });
    const first = service.backupNow();
    const second = service.backupNow();
    log.runCommand((ctx) => seedDemoProject(ctx));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.outcome).toBe('ok');
    expect(service.list()).toHaveLength(1);
  });

  it('is skipped, logged once, when the disk would keep less than the reserve', async () => {
    let free = 10 * 2 ** 20;
    const { service, lines } = setup({ freeBytes: () => free, reserveBytes: 2 ** 30 });
    const skipped = await service.backupNow('auto');
    expect(skipped).toMatchObject({ outcome: 'skipped' });
    expect(skipped.detail).toMatch(/free/);
    await service.backupNow('auto');
    expect(lines.filter((l) => l.includes('skipped'))).toHaveLength(1);
    expect(service.list()).toEqual([]);
    free = 100 * 2 ** 30;
    expect((await service.backupNow('auto')).outcome).toBe('ok');
  });

  it('a failed copy leaves nothing behind and reports the failure', async () => {
    const { service, home } = setup();
    // The backup folder is a file: nothing can be written there.
    writeFileSync(join(home, 'backups'), 'not a folder');
    const failed = await service.backupNow();
    expect(failed.outcome).toBe('failed');
    expect(service.response().last?.outcome).toBe('failed');
  });

  it('the daily backup waits for a quiet log, and runs anyway once 6 h overdue', async () => {
    let lastActivity: string | undefined;
    const t = setup({ lastActivityAt: () => lastActivity });
    expect(t.service.due()).toBe(true); // never backed up, nothing happening
    expect((await t.service.tick())?.outcome).toBe('ok');
    expect(t.service.due()).toBe(false);
    t.advance(23 * HOUR);
    expect(await t.service.tick()).toBeUndefined();
    t.advance(1 * HOUR);
    // Due, but the log is busy (an event a moment ago).
    lastActivity = new Date(
      Date.parse(t.service.response().backups[0]!.createdAt) + 24 * HOUR,
    ).toISOString();
    expect(t.service.due()).toBe(false);
    t.advance(3 * 60 * 1000); // quiet for 3 min
    expect(t.service.due()).toBe(true);
    // Busy all along: after 6 h overdue it runs regardless.
    t.advance(-3 * 60 * 1000);
    t.advance(6 * HOUR);
    lastActivity = new Date(
      Date.parse(t.service.response().backups[0]!.createdAt) + 30 * HOUR,
    ).toISOString();
    expect(t.service.due()).toBe(true);
  });

  it('the schedule survives a restart (the newest automatic backup is read from the folder)', async () => {
    const t = setup();
    await t.service.tick();
    const again = new BackupService({
      db: t.db,
      dir: join(t.home, 'backups'),
      now: () => new Date(Date.parse('2026-10-06T12:00:00.000Z')).toISOString(),
      freeBytes: () => 100 * 2 ** 30,
      lastActivityAt: () => undefined,
    });
    expect(again.due()).toBe(false);
  });

  it('a disabled schedule never backs up by itself; "Back up now" still works', async () => {
    const t = setup({ schedule: { enabled: false } });
    expect(await t.service.tick()).toBeUndefined();
    expect((await t.service.backupNow()).outcome).toBe('ok');
  });

  it('starts and stops its timer; the first check runs at start', async () => {
    const handles: { fn: () => void; ms: number }[] = [];
    let cleared = 0;
    const t = setup({
      timers: {
        setInterval: (fn, ms) => {
          handles.push({ fn, ms });
          return handles.length;
        },
        clearInterval: () => void (cleared += 1),
      },
    });
    t.service.start(1000);
    expect(handles).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    while (t.service.running) await new Promise((r) => setTimeout(r, 10));
    expect(t.service.list().map((b) => b.kind)).toEqual(['auto']);
    t.service.stop();
    expect(cleared).toBe(1);
  });

  it('rotates: the newest per day for 7 days, per week for 4 weeks, 5 manual and 5 pre-import', () => {
    const backups: BackupInfo[] = [];
    // Two automatic backups a day for 60 days, 8 manual, 7 pre-import.
    for (let d = 0; d < 60; d++) {
      for (const h of [3, 15]) {
        const at = new Date(
          Date.parse('2026-08-01T00:00:00.000Z') + d * 24 * HOUR + h * HOUR,
        ).toISOString();
        backups.push({ name: backupName('auto', at), kind: 'auto', createdAt: at, bytes: 1 });
      }
    }
    for (let i = 0; i < 8; i++) {
      const at = new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * HOUR).toISOString();
      backups.push({ name: backupName('manual', at), kind: 'manual', createdAt: at, bytes: 1 });
    }
    for (let i = 0; i < 7; i++) {
      const at = new Date(Date.parse('2026-09-02T00:00:00.000Z') + i * HOUR).toISOString();
      backups.push({
        name: backupName('pre-import', at),
        kind: 'pre-import',
        createdAt: at,
        bytes: 1,
      });
    }
    const gone = new Set(
      backupsToRemove(backups, { keepDaily: 7, keepWeekly: 4, keepManual: 5 }).map((b) => b.name),
    );
    const kept = backups.filter((b) => !gone.has(b.name));
    const autos = kept
      .filter((b) => b.kind === 'auto')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    // 7 daily (the 15:00 one of each of the last 7 days) plus the weeks' newest not among them.
    const days = new Set(autos.map((b) => b.createdAt.slice(0, 10)));
    expect(days.size).toBe(autos.length);
    expect(autos.every((b) => b.createdAt.endsWith('T15:00:00.000Z'))).toBe(true);
    expect(autos.length).toBeGreaterThanOrEqual(7);
    expect(autos.length).toBeLessThanOrEqual(7 + 4);
    expect(autos[0]!.createdAt.slice(0, 10)).toBe('2026-09-29');
    // The oldest kept is at most ~4 weeks back.
    const oldest = autos.map((b) => Date.parse(b.createdAt)).sort((a, b) => a - b)[0]!;
    expect(Date.parse('2026-09-29T15:00:00.000Z') - oldest).toBeLessThan(28 * 24 * HOUR);
    expect(kept.filter((b) => b.kind === 'manual')).toHaveLength(5);
    expect(kept.filter((b) => b.kind === 'pre-import')).toHaveLength(5);
    // The newest manual ones are the ones kept.
    expect(
      kept
        .filter((b) => b.kind === 'manual')
        .map((b) => b.createdAt)
        .sort()[0],
    ).toBe('2026-09-01T03:00:00.000Z');
  });

  it('rotates the folder after each backup and ignores files that are not backups', async () => {
    const t = setup({ schedule: { keepDaily: 2, keepWeekly: 0, keepManual: 1 } });
    mkdirSync(join(t.home, 'backups'), { recursive: true });
    writeFileSync(join(t.home, 'backups', 'notes.txt'), 'mine');
    for (let i = 0; i < 4; i++) {
      await t.service.backupNow('auto');
      t.advance(24 * HOUR);
    }
    await t.service.backupNow('manual');
    t.advance(HOUR);
    await t.service.backupNow('manual');
    const list = listBackups(join(t.home, 'backups'));
    expect(list.filter((b) => b.kind === 'auto')).toHaveLength(2);
    expect(list.filter((b) => b.kind === 'manual')).toHaveLength(1);
    expect(existsSync(join(t.home, 'backups', 'notes.txt'))).toBe(true);
  });

  it('a keep of 0 never deletes the newest backup of a kind (the one just taken, the only pre-import)', () => {
    const at = (h: number) =>
      new Date(Date.parse('2026-10-01T00:00:00.000Z') + h * HOUR).toISOString();
    const backups: BackupInfo[] = [
      { name: backupName('auto', at(1)), kind: 'auto', createdAt: at(1), bytes: 1 },
      { name: backupName('auto', at(30)), kind: 'auto', createdAt: at(30), bytes: 1 },
      { name: backupName('manual', at(2)), kind: 'manual', createdAt: at(2), bytes: 1 },
      { name: backupName('pre-import', at(3)), kind: 'pre-import', createdAt: at(3), bytes: 1 },
    ];
    const gone = backupsToRemove(backups, { keepDaily: 0, keepWeekly: 0, keepManual: 0 });
    expect(gone.map((b) => b.name)).toEqual([backupName('auto', at(1))]);
  });

  it('removes what a killed backup left before taking the next one', async () => {
    const t = setup();
    const dir = join(t.home, 'backups');
    mkdirSync(dir, { recursive: true });
    const stale = backupName('auto', '2026-10-05T03:00:00.000Z');
    writeFileSync(join(dir, `${stale}.partial`), 'half a copy');
    writeFileSync(join(dir, `${stale}.partial-journal`), 'its journal');
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    const outcome = await t.service.backupNow();
    expect(outcome.outcome).toBe('ok');
    expect(readdirSync(dir).sort()).toEqual([outcome.name, 'notes.txt'].sort());
    expect(t.lines.some((l) => l.includes(`removed ${stale}.partial`))).toBe(true);
  });

  it('idle() waits for the backup under way (the shutdown awaits it)', async () => {
    const t = setup({ stepPages: 1 });
    await t.service.idle(); // nothing running: resolves at once
    const taking = t.service.backupNow();
    expect(t.service.running).toBe(true);
    await t.service.idle();
    expect(t.service.running).toBe(false);
    expect((await taking).outcome).toBe('ok');
    expect(readdirSync(join(t.home, 'backups')).some((n) => n.includes('.partial'))).toBe(false);
  });
});
