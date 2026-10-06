import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';
import { seedDemoProject } from '../domain/demo.js';
import { EventLog } from '../domain/event-log.js';
import { BackupService, listBackups } from './backup.js';
import { openDatabase } from './database.js';
import { loadMigrations } from './migrate.js';
import { restoreBackup, RestoreError } from './restore.js';

/** P8-03 — restoring a backup file: checked, the replaced database kept, a new log identity. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function withBackup() {
  const home = mkdtempSync(join(tmpdir(), 'galactic-restore-'));
  dirs.push(home);
  const dbPath = join(home, 'galactic.sqlite');
  const db = openDatabase(dbPath);
  const log = new EventLog(db);
  log.runCommand((ctx) => seedDemoProject(ctx));
  const service = new BackupService({
    db,
    dir: join(home, 'backups'),
    freeBytes: () => 100 * 2 ** 30,
  });
  const backup = await service.backupNow();
  const atBackup = { seq: log.currentSeq(), logId: log.logId, snapshot: log.snapshot() };
  // Work done after the backup: lost by the restore.
  log.runCommand((ctx) => seedDemoProject(ctx));
  const later = log.currentSeq();
  db.close();
  return {
    home,
    dbPath,
    file: join(home, 'backups', backup.name!),
    name: backup.name!,
    atBackup,
    later,
  };
}

describe('restoring a backup (P8-03)', () => {
  it('puts the backup back with a new log identity and keeps a copy of what it replaced', async () => {
    const t = await withBackup();
    const report = await restoreBackup(t.dbPath, t.file);
    expect(report.seq).toBe(t.atBackup.seq);
    expect(report.logId).not.toBe(t.atBackup.logId);
    expect(report.replacedBackup).toBeDefined();
    expect(statSync(t.dbPath).mode & 0o777).toBe(0o600);

    const db = openDatabase(t.dbPath);
    const log = new EventLog(db);
    expect(log.logId).toBe(report.logId);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    const { logId: _a, ...restored } = log.snapshot();
    const { logId: _b, ...original } = t.atBackup.snapshot;
    expect(restored).toEqual(original);
    db.close();

    const kept = listBackups(join(t.home, 'backups')).find((b) => b.kind === 'pre-import')!;
    const copy = new BetterSqlite3(join(t.home, 'backups', kept.name), { readonly: true });
    expect((copy.prepare('SELECT MAX(id) AS n FROM events').get() as { n: number }).n).toBe(
      t.later,
    );
    copy.close();
  });

  it('refuses a file that is not a sound database, leaving the target alone', async () => {
    const t = await withBackup();
    const bad = join(t.home, 'bad.sqlite');
    writeFileSync(bad, 'not a database at all, just text that is long enough to have a header');
    await expect(restoreBackup(t.dbPath, bad)).rejects.toBeInstanceOf(RestoreError);
    await expect(restoreBackup(t.dbPath, join(t.home, 'missing.sqlite'))).rejects.toThrow(
      /No backup/,
    );
    const db = new BetterSqlite3(t.dbPath, { readonly: true });
    expect((db.prepare('SELECT MAX(id) AS n FROM events').get() as { n: number }).n).toBe(t.later);
    db.close();
  });

  it('refuses a backup from a newer build, accepts one from an older build', async () => {
    const t = await withBackup();
    const newer = new BetterSqlite3(t.file);
    newer
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(9_999, 'from_the_future', new Date().toISOString());
    newer.close();
    await expect(restoreBackup(t.dbPath, t.file)).rejects.toThrow(
      /cannot be restored by this build: .*migration 9999 \("from_the_future"\)/,
    );
    // The target is untouched.
    const db = new BetterSqlite3(t.dbPath, { readonly: true });
    expect((db.prepare('SELECT MAX(id) AS n FROM events').get() as { n: number }).n).toBe(t.later);
    db.close();

    // An older backup (fewer migrations than this build) restores; the server migrates it.
    const older = await withBackup();
    const all = loadMigrations();
    await expect(
      restoreBackup(older.dbPath, older.file, {
        migrations: [...all, { ...all.at(-1)!, version: all.at(-1)!.version + 1, name: 'later' }],
      }),
    ).resolves.toMatchObject({ seq: older.atBackup.seq });
  });

  it('galactic restore takes a name from the backups folder and refuses while the server runs', async () => {
    const t = await withBackup();
    const lines: string[] = [];
    const errors: string[] = [];
    const io = (running: boolean) => ({
      env: { GALACTIC_HOME: t.home },
      out: (l: string) => lines.push(l),
      err: (l: string) => errors.push(l),
      isServerRunning: () => Promise.resolve(running),
    });
    expect(await runCli(['restore', t.name], io(true))).toBe(1);
    expect(errors.join('\n')).toMatch(/stop it first, then restore/);
    expect(await runCli(['restore', t.name], io(false))).toBe(0);
    expect(lines.join('\n')).toMatch(/Restored .* \(events up to seq 3\)/);
  });
});
