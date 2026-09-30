import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Reads `NNNN_name.sql` files from the migrations folder, sorted by number. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .map((file) => {
      const m = FILE_PATTERN.exec(file);
      return m
        ? { version: Number(m[1]), name: m[2]!, sql: readFileSync(join(dir, file), 'utf8') }
        : null;
    })
    .filter((m): m is Migration => m !== null)
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migration numbering gap at ${m.version}`);
  });
  return migrations;
}

export interface MigrateResult {
  applied: number[];
  current: number;
}

/** Applies pending migrations, each in its own transaction. Re-running is a no-op. */
export function migrate(db: Database, migrations: Migration[] = loadMigrations()): MigrateResult {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const done = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const applied: number[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      insert.run(m.version, m.name, new Date().toISOString());
    })();
    applied.push(m.version);
  }
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return { applied, current: row.v ?? 0 };
}
