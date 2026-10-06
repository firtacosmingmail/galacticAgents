import BetterSqlite3, { type Database } from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyEvent,
  emptyWorld,
  MapExport,
  type Body,
  type EventEnvelope,
  type ExportedEvent,
  type ExportedRows,
  type Id,
  type WorldState,
} from '@galactic/protocol';
import { EventLog } from '../domain/event-log.js';
import { backupName, backupTo, BACKUP_DIR } from './backup.js';
import { openDatabase } from './database.js';
import { loadMigrations, migrate, type Migration } from './migrate.js';
import { tables, type Tables } from './tables.js';

/**
 * Import of a map export (P8-03; TECHNOLOGY §6.4, docs/BACKUP_RESTORE.md). The import writes the
 * exported events back with their `seq` and `at`, then **rebuilds the domain tables by replaying
 * them** through the world fold the web client uses (`applyEvent`, `@galactic/protocol`; its
 * conformance test holds it equal to the server's commands), starting from the body catalogue the
 * migrations seed. The rebuilt rows are compared with the rows the export carries: equal, they are
 * written; different, the import refuses and lists the differences — unless `preferRows`, which
 * writes the exported rows instead (a database whose rows had drifted from its log before the
 * export, e.g. rows changed by an early migration). The budget projections are folded from the
 * log afterwards (`EventLog`), and the status store is rebuilt from it at the next start, like
 * after any restart.
 *
 * The import builds a new database next to the target and only renames it into place once it is
 * complete and checked, so a failed import leaves the target as it was. It refuses a target that
 * holds anything (events, work, agents, transcripts) unless `replace`, which first copies the
 * target into `backups/` (`pre-import`) and carries its push subscriptions over (device
 * configuration, never exported). The server must not be running (`galactic import` checks).
 * The new database gets a new log identity, so connected clients take a snapshot instead of
 * resuming against a log they did not see.
 */

export type ImportErrorCode = 'invalid' | 'schema' | 'not_empty' | 'drift';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    /** `drift`: the differences between the rebuilt rows and the exported ones. */
    readonly drift: string[] = [],
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportOptions {
  /** Replace a database that is not empty (after copying it into `backups/`). */
  replace?: boolean;
  /** Write the exported rows when the rebuild disagrees with them (instead of refusing). */
  preferRows?: boolean;
  /** Where `replace` puts its copy (default `<the database's folder>/backups`). */
  backupDir?: string;
  migrations?: Migration[];
  now?: () => string;
}

export interface ImportReport {
  events: number;
  /** The last `seq` imported. */
  seq: number;
  /** The new database's log identity. */
  logId: string;
  rows: Record<keyof ExportedRows, number>;
  transcriptChunks: number;
  /** `replayed`: the rows are the rebuild's; `rows`: the export's (`preferRows` over drift). */
  rebuilt: 'replayed' | 'rows';
  /** How the rebuild differed from the exported rows (empty: it reproduced them). */
  drift: string[];
  /** `replace`: the copy of the database that was replaced. */
  replacedBackup?: string;
  pushSubscriptionsKept: number;
}

const ROW_KINDS = ['bodies', 'projects', 'tasks', 'agents', 'questions', 'proposals'] as const;

/** Whether the database holds nothing worth keeping: no events, work, agents or transcripts. */
export function isEmptyDatabase(db: Database): boolean {
  const count = (table: string): number => {
    try {
      return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    } catch {
      return 0; // the table does not exist yet: nothing in it
    }
  };
  return [
    'events',
    'projects',
    'tasks',
    'agents',
    'questions',
    'proposals',
    'transcript_chunks',
  ].every((table) => count(table) === 0);
}

/**
 * Folds the log into domain rows, from the seeded catalogue: the server-side rebuild path. A
 * retired demo body (P7-07) leaves the world but keeps its tombstone row, as `retireBody` does.
 */
export function foldRows(seed: readonly Body[], events: readonly ExportedEvent[]): ExportedRows {
  let world: WorldState = {
    ...emptyWorld(),
    bodies: Object.fromEntries(seed.map((b) => [b.id, b])),
  };
  const retired = new Map<Id, Body>();
  for (const e of events) {
    const envelope = { seq: e.seq, at: e.at, event: e.event } as unknown as EventEnvelope;
    if (envelope.event.type === 'body.retired') {
      const body = world.bodies[envelope.event.bodyId];
      if (body) retired.set(body.id, { ...body, meta: { ...body.meta, retired: true } });
    }
    // An event type this build does not know folds to nothing (the fold has no default case).
    world = (applyEvent(world, envelope) as WorldState | undefined) ?? world;
  }
  const bodies = new Map(Object.entries(world.bodies));
  for (const [id, body] of retired) if (!bodies.has(id)) bodies.set(id, body);
  return {
    bodies: [...bodies.values()],
    projects: Object.values(world.projects),
    tasks: Object.values(world.tasks),
    agents: Object.values(world.agents),
    questions: Object.values(world.questions),
    proposals: Object.values(world.proposals),
  };
}

/** JSON with sorted keys: two rows are equal when their canonical forms are. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
}

/** Every difference between two sets of rows, as readable lines (empty: the same). */
export function diffRows(got: ExportedRows, want: ExportedRows): string[] {
  const lines: string[] = [];
  for (const kind of ROW_KINDS) {
    const mine = new Map<Id, Record<string, unknown>>(got[kind].map((r) => [r.id, r]));
    const theirs = new Map<Id, Record<string, unknown>>(want[kind].map((r) => [r.id, r]));
    for (const [id, row] of theirs) {
      const rebuilt = mine.get(id);
      if (!rebuilt) {
        lines.push(`${kind} ${id}: in the export, not in the rebuild`);
        continue;
      }
      const fields = [...new Set([...Object.keys(row), ...Object.keys(rebuilt)])].filter(
        (k) => canonical(row[k]) !== canonical(rebuilt[k]),
      );
      if (fields.length > 0) {
        lines.push(
          `${kind} ${id}: ${fields.map((f) => `${f} ${canonical(rebuilt[f])} ≠ ${canonical(row[f])}`).join('; ')}`,
        );
      }
    }
    for (const id of mine.keys()) {
      if (!theirs.has(id)) lines.push(`${kind} ${id}: in the rebuild, not in the export`);
    }
  }
  return lines;
}

/**
 * Writes rows into the tables, in the export's order where it has the row (so the new table's
 * `rowid` order, which a snapshot lists by, follows the original's). Bodies are upserted over the
 * seeded catalogue. Foreign keys are deferred to the commit by the caller.
 */
function writeRows(t: Tables, rows: ExportedRows, order: ExportedRows): void {
  const sorted = <R extends { id: Id }>(list: readonly R[], ref: readonly { id: Id }[]): R[] => {
    const at = new Map(ref.map((r, i) => [r.id, i]));
    return [...list].sort(
      (a, b) =>
        (at.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (at.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
  };
  for (const b of sorted(rows.bodies, order.bodies)) t.bodies.upsert(b);
  for (const p of sorted(rows.projects, order.projects)) t.projects.insert(p);
  for (const x of sorted(rows.tasks, order.tasks)) t.tasks.insert(x);
  for (const a of sorted(rows.agents, order.agents)) t.agents.insert(a);
  for (const q of sorted(rows.questions, order.questions)) t.questions.insert(q);
  for (const p of sorted(rows.proposals, order.proposals)) t.proposals.insert(p);
}

/** Refuses an export whose schema this build does not have (a newer build, or another branch). */
function checkSchema(data: MapExport, migrations: Migration[]): void {
  const files = new Map(migrations.map((m) => [m.version, m.name]));
  for (const m of data.schema.migrations) {
    const mine = files.get(m.version);
    if (mine === undefined) {
      throw new ImportError(
        'schema',
        `The export was made by a newer build (migration ${m.version} "${m.name}" is unknown ` +
          'here): import it with that build or a later one.',
      );
    }
    if (mine !== m.name) {
      throw new ImportError(
        'schema',
        `The export was made by a different build: migration ${m.version} is "${m.name}" ` +
          `there but "${mine}" here.`,
      );
    }
  }
}

function removeDatabaseFiles(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`])
    rmSync(f, { force: true });
}

/** Imports `input` (a parsed export file) into the database at `dbPath`. */
export async function importMap(
  dbPath: string,
  input: unknown,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const parsed = MapExport.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ImportError(
      'invalid',
      `Not a map export this build can read${issue ? ` (${issue.path.join('.') || 'file'}: ${issue.message})` : ''}.`,
    );
  }
  const data = parsed.data;
  // The payloads exactly as the file has them (the schema's output may order keys differently).
  const rawEvents = (input as { events: { event: Record<string, unknown> }[] }).events;
  const migrations = opts.migrations ?? loadMigrations();
  checkSchema(data, migrations);
  const now = opts.now ?? (() => new Date().toISOString());

  let replacedBackup: string | undefined;
  let keepPush = false;
  if (existsSync(dbPath)) {
    const old = new BetterSqlite3(dbPath);
    try {
      if (!isEmptyDatabase(old)) {
        if (!opts.replace) {
          throw new ImportError(
            'not_empty',
            `${dbPath} already holds a map. Import into an empty data folder, or pass --replace ` +
              '(the current database is copied into backups/ first).',
          );
        }
        const dir = opts.backupDir ?? join(dirname(dbPath), BACKUP_DIR);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        replacedBackup = join(dir, backupName('pre-import', now()));
        await backupTo(old, replacedBackup);
      }
      try {
        keepPush =
          (old.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n >
          0;
      } catch {
        keepPush = false; // no such table yet
      }
    } finally {
      old.close();
    }
  }

  const temp = `${dbPath}.import-${process.pid}`;
  removeDatabaseFiles(temp);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDatabase(temp, { migrate: false });
  try {
    migrate(db, migrations);
    const t = tables(db);
    const outcome = db.transaction(() => {
      // Rows reference each other (a sub-project its parent, an agent its supervisor): checked
      // once everything is in, at the commit.
      db.pragma('defer_foreign_keys = ON');
      const insert = db.prepare('INSERT INTO events (id, at, type, payload) VALUES (?, ?, ?, ?)');
      data.events.forEach((e, i) => {
        insert.run(e.seq, e.at, e.event.type, JSON.stringify(rawEvents[i]!.event));
      });
      let rebuilt: ExportedRows | undefined;
      let drift: string[];
      try {
        rebuilt = foldRows(t.bodies.all(), data.events);
        drift = diffRows(rebuilt, data.rows);
      } catch (error) {
        drift = [`the rebuild failed: ${error instanceof Error ? error.message : String(error)}`];
      }
      if (drift.length > 0 && !opts.preferRows) {
        throw new ImportError(
          'drift',
          `Replaying the exported events does not give the exported rows (${drift.length} ` +
            'difference(s)); nothing was imported. Pass --prefer-rows to import the rows as exported.',
          drift,
        );
      }
      const rows = drift.length === 0 && rebuilt ? rebuilt : data.rows;
      writeRows(t, rows, data.rows);
      let chunks = 0;
      if (data.transcripts) {
        const chunk = db.prepare(
          'INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)',
        );
        for (const c of data.transcripts.chunks) chunk.run(c.agentId, c.seq, c.at, c.chunk);
        chunks = data.transcripts.chunks.length;
        const mark = db.prepare(
          `INSERT INTO transcript_compactions
             (agent_id, through_seq, through_at, last_seq, removed_at, removed_chunks, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const m of data.transcripts.compactions) {
          mark.run(
            m.agentId,
            m.throughSeq,
            m.throughAt,
            m.lastSeq,
            m.removedAt,
            m.removedChunks,
            m.reason,
          );
        }
      }
      return {
        drift,
        rebuilt: drift.length === 0 ? ('replayed' as const) : ('rows' as const),
        chunks,
      };
    })();

    let pushSubscriptionsKept = 0;
    if (keepPush) {
      db.prepare('ATTACH DATABASE ? AS previous').run(dbPath);
      try {
        pushSubscriptionsKept = db
          .prepare('INSERT INTO main.push_subscriptions SELECT * FROM previous.push_subscriptions')
          .run().changes;
      } finally {
        db.exec('DETACH DATABASE previous');
      }
    }
    // A new log identity, and the budget projections folded from the imported log (P8-01).
    const log = new EventLog(db);
    const broken = db.pragma('foreign_key_check') as unknown[];
    if (broken.length > 0)
      throw new Error(`the imported rows break ${broken.length} foreign key(s)`);
    const check = db.pragma('quick_check', { simple: true });
    if (check !== 'ok') throw new Error(`the imported database failed its check: ${String(check)}`);
    const report: ImportReport = {
      events: data.events.length,
      seq: data.events.at(-1)?.seq ?? 0,
      logId: log.logId,
      rows: Object.fromEntries(
        ROW_KINDS.map((k) => [k, data.rows[k].length]),
      ) as ImportReport['rows'],
      transcriptChunks: outcome.chunks,
      rebuilt: outcome.rebuilt,
      drift: outcome.drift,
      ...(replacedBackup ? { replacedBackup } : {}),
      pushSubscriptionsKept,
    };
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    // The replaced database was closed cleanly (its WAL folded in); stale side files must not be
    // read as the new database's. The rename itself replaces the file in one step.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
    renameSync(temp, dbPath);
    rmSync(`${temp}-wal`, { force: true });
    rmSync(`${temp}-shm`, { force: true });
    chmodSync(dbPath, 0o600);
    return report;
  } catch (error) {
    if (db.open) db.close();
    removeDatabaseFiles(temp);
    throw error;
  }
}
