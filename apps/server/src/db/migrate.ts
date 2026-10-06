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
/** A migration that rebuilds a table declares it with this line (P2-02). */
const FK_OFF = /^-- migrate: foreign_keys=off$/m;

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
  const recorded = db.prepare('SELECT version, name FROM schema_migrations').all() as {
    version: number;
    name: string;
  }[];
  // A database that ran another branch's migrations under the same numbers (a `0011` that was
  // budgets there) must not be taken for this schema: the names have to match the files.
  const files = new Map(migrations.map((m) => [m.version, m.name]));
  const mismatched = recorded.filter(
    (r) => files.has(r.version) && files.get(r.version) !== r.name,
  );
  if (mismatched.length > 0) {
    throw new Error(
      'The database was migrated by a different build: ' +
        mismatched
          .map(
            (r) =>
              `migration ${String(r.version).padStart(4, '0')} is "${r.name}" in the database ` +
              `but "${files.get(r.version)}" here`,
          )
          .join('; ') +
        '. Use the build that created it, or a fresh database.',
    );
  }
  const done = new Set(recorded.map((r) => r.version));
  const applied: number[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of migrations) {
    if (done.has(m.version)) continue;
    // A table rebuild (SQLite's way to change a constraint) runs with foreign keys off, which can
    // only be switched outside a transaction; the references are checked before the commit.
    const fkOff = FK_OFF.test(m.sql);
    const fkWasOn = fkOff && (db.pragma('foreign_keys', { simple: true }) as number) === 1;
    if (fkWasOn) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (fkOff) {
          const broken = db.pragma('foreign_key_check') as unknown[];
          if (broken.length > 0) {
            throw new Error(`Migration ${m.version} broke ${broken.length} foreign key(s)`);
          }
        }
        insert.run(m.version, m.name, new Date().toISOString());
      })();
    } finally {
      if (fkWasOn) db.pragma('foreign_keys = ON');
    }
    applied.push(m.version);
  }
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return { applied, current: row.v ?? 0 };
}
