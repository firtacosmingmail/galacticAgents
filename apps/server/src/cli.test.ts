import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MapExport } from '@galactic/protocol';
import { runCli, type CliIo } from './cli.js';
import { openDatabase } from './db/database.js';
import { seedDemoProject } from './domain/demo.js';
import { EventLog } from './domain/event-log.js';

/** P8-03 — `galactic export` / `galactic import`, against temp data folders only. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'galactic-cli-'));
  dirs.push(d);
  return d;
};

function io(home: string, running = false): CliIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    env: { GALACTIC_HOME: home },
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    isServerRunning: () => Promise.resolve(running),
    lines,
    errors,
  };
}

function seeded(home: string): number {
  const db = openDatabase(join(home, 'galactic.sqlite'));
  const log = new EventLog(db);
  log.runCommand((ctx) => seedDemoProject(ctx));
  const seq = log.currentSeq();
  db.close();
  return seq;
}

describe('galactic export / import (P8-03)', () => {
  it('exports to a 0600 file and imports it into an empty data folder', async () => {
    const a = temp();
    const seq = seeded(a);
    const file = join(temp(), 'map.json');
    writeFileSync(file, 'old', { mode: 0o644 });
    const ex = io(a);
    expect(await runCli(['export', file], ex)).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(ex.lines.join('\n')).toMatch(/Exported 3 events/);
    const exported = MapExport.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(exported.source.seq).toBe(seq);

    const b = temp();
    const im = io(b);
    expect(await runCli(['import', file], im)).toBe(0);
    expect(im.lines.join('\n')).toMatch(/Imported 3 events/);
    // Into a folder that holds a map: refused without --replace, done with it (and a backup).
    const again = io(b);
    expect(await runCli(['import', file], again)).toBe(1);
    expect(again.errors.join('\n')).toMatch(/already holds a map/);
    const replace = io(b);
    expect(await runCli(['import', file, '--replace'], replace)).toBe(0);
    expect(replace.lines.join('\n')).toMatch(/copied to .*backups/);
  });

  it('refuses to import while Mission Control runs', async () => {
    const a = temp();
    seeded(a);
    const file = join(temp(), 'map.json');
    await runCli(['export', file], io(a));
    const b = temp();
    const running = io(b, true);
    expect(await runCli(['import', file], running)).toBe(1);
    expect(running.errors.join('\n')).toMatch(/running on port 4321/);
  });

  it('explains what it cannot do', async () => {
    const home = temp();
    const usage = io(home);
    expect(await runCli(['export'], usage)).toBe(2);
    expect(await runCli(['import', 'x', '--transcripts'], usage)).toBe(2);
    expect(await runCli(['frobnicate', 'x'], usage)).toBe(2);
    const missing = io(home);
    expect(await runCli(['export', join(home, 'out.json')], missing)).toBe(1);
    expect(missing.errors.join('\n')).toMatch(/No database/);
    const unreadable = io(home);
    expect(await runCli(['import', join(home, 'nope.json')], unreadable)).toBe(1);
    expect(unreadable.errors.join('\n')).toMatch(/Cannot read/);
    const bad = join(home, 'bad.json');
    writeFileSync(bad, JSON.stringify({ format: 'something else' }));
    const invalid = io(home);
    expect(await runCli(['import', bad], invalid)).toBe(1);
    expect(invalid.errors.join('\n')).toMatch(/Not a map export/);
  });
});
