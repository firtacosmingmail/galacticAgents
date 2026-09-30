import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { openDatabase } from './database.js';
import { loadMigrations, migrate } from './migrate.js';
import { tables } from './tables.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('migrations', () => {
  it('migrates a fresh database from zero and re-running is a no-op', () => {
    const db = openDatabase(':memory:', { migrate: false });
    const first = migrate(db);
    expect(first.applied).toEqual(loadMigrations().map((m) => m.version));
    expect(first.current).toBeGreaterThanOrEqual(1);
    const again = migrate(db);
    expect(again.applied).toEqual([]);
    expect(again.current).toBe(first.current);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'agents',
        'bodies',
        'events',
        'projects',
        'proposals',
        'questions',
        'schema_migrations',
        'settings',
        'tasks',
        'transcript_chunks',
      ]),
    );
  });

  it('opens a file database in WAL mode with foreign keys on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'galactic-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'nested', 'galactic.sqlite'));
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  it('rejects a numbering gap in the migrations folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'galactic-mig-'));
    dirs.push(dir);
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (x);');
    writeFileSync(join(dir, '0003_c.sql'), 'CREATE TABLE c (x);');
    writeFileSync(join(dir, 'README.md'), 'ignored');
    expect(() => loadMigrations(dir)).toThrow(/numbering gap at 3/);
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (x);');
    expect(loadMigrations(dir).map((m) => m.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('domain tables', () => {
  it('inserts and reads back every domain type', () => {
    const t = tables(openDatabase(':memory:'));
    t.bodies.insert(fx.body);
    t.bodies.insert(fx.moon);
    t.bodies.insert(fx.asteroid);
    t.projects.insert(fx.project);
    t.tasks.insert(fx.task);
    t.tasks.insert(fx.asteroidTask);
    t.agents.insert({ ...fx.agent, supervisorId: undefined });
    t.agents.insert(fx.harmonizer);
    t.proposals.insert(fx.proposal);
    t.questions.insert(fx.question);
    t.questions.insert(fx.permissionQuestion);
    t.settings.set('retentionDays', 14);

    expect(t.bodies.get('b-earth')).toEqual(fx.body);
    expect(t.bodies.get('b-luna')).toEqual(fx.moon);
    expect(t.bodies.get('b-ast-1')).toEqual(fx.asteroid);
    expect(t.bodies.all().map((b) => b.id)).toEqual(['b-earth', 'b-luna', 'b-ast-1']);
    expect(t.projects.get('p-1')).toEqual(fx.project);
    expect(t.tasks.get('t-1')).toEqual(fx.task);
    expect(t.tasks.get('t-2')).toEqual(fx.asteroidTask);
    expect(t.agents.get('a-harmonizer')).toEqual(fx.harmonizer);
    expect(t.proposals.get('pr-1')).toEqual(fx.proposal);
    expect(t.questions.get('q-1')).toEqual(fx.question);
    expect(t.questions.get('q-2')).toEqual(fx.permissionQuestion);
    expect(t.settings.get<number>('retentionDays')).toBe(14);
    expect(t.settings.get('missing')).toBeUndefined();
  });

  it('upserts, deletes and validates on the way in', () => {
    const t = tables(openDatabase(':memory:'));
    t.bodies.insert(fx.body);
    t.bodies.upsert({ ...fx.body, name: 'Terra' });
    expect(t.bodies.get('b-earth')?.name).toBe('Terra');
    expect(t.bodies.delete('b-earth')).toBe(true);
    expect(t.bodies.get('b-earth')).toBeUndefined();
    expect(() => t.bodies.insert({ ...fx.body, kind: 'comet' as never })).toThrow();
  });

  it('enforces foreign keys and writes the two streams', () => {
    const db = openDatabase(':memory:');
    const t = tables(db);
    expect(() => t.projects.insert(fx.project)).toThrow(/FOREIGN KEY/);
    db.prepare('INSERT INTO events (at, type, payload) VALUES (?, ?, ?)').run(
      fx.NOW,
      'agent.idle',
      '{}',
    );
    db.prepare('INSERT INTO events (at, type, payload) VALUES (?, ?, ?)').run(
      fx.NOW,
      'agent.idle',
      '{}',
    );
    expect((db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id).toBe(2);
    db.prepare('INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)').run(
      'a-1',
      1,
      fx.NOW,
      'hello',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM transcript_chunks').get()).toEqual({ n: 1 });
  });
});
