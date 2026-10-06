import type { Database } from 'better-sqlite3';
import {
  MAP_EXPORT_FORMAT,
  MAP_EXPORT_VERSION,
  type ExportedChunk,
  type ExportedCompaction,
  type ExportedEvent,
  type MapExport,
} from '@galactic/protocol';
import { SERVER_VERSION } from '../version.js';
import { loadMigrations, type Migration } from './migrate.js';
import { tables } from './tables.js';

/**
 * Export of the map and its history (P8-03; TECHNOLOGY §6.4, docs/BACKUP_RESTORE.md): the whole
 * event log — the truth everything else is folded from (TECHNOLOGY §6.1) — with the schema it was
 * written under and the domain rows at its last `seq`, which the import uses to check its rebuild.
 * Optionally the transcripts (chunks and their compaction markers). Read in one transaction, so
 * the events and the rows are of the same moment even while the server writes.
 *
 * Never exported (they are secrets, device configuration or runtime bookkeeping): the token,
 * `config.json`, the VAPID keys, push subscriptions, the process table, the settings table, and
 * agents' runtime sessions (those live in each CLI's own store, not in the database).
 */

export class ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportError';
  }
}

export interface ExportOptions {
  /** Include the transcripts (default false: they are large and may hold pasted secrets). */
  transcripts?: boolean;
  now?: () => string;
  migrations?: Migration[];
}

/** The `schema_migrations` rows, oldest first. */
export function appliedMigrations(db: Database): { version: number; name: string }[] {
  return db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as {
    version: number;
    name: string;
  }[];
}

/**
 * Refuses a database this build cannot read as its own: one migrated by a different build (a
 * migration of the same number with another name), or one not yet migrated to this build's
 * schema (start Mission Control once to migrate it).
 */
function checkSchema(db: Database, migrations: Migration[]): { version: number; name: string }[] {
  const applied = appliedMigrations(db);
  const files = new Map(migrations.map((m) => [m.version, m.name]));
  for (const m of applied) {
    const mine = files.get(m.version);
    if (mine === undefined) {
      throw new ExportError(
        `The database has migration ${m.version} ("${m.name}"), which this build does not know: ` +
          'export it with the build that migrated it.',
      );
    }
    if (mine !== m.name) {
      throw new ExportError(
        `The database was migrated by a different build: migration ${m.version} is "${m.name}" ` +
          `there but "${mine}" here.`,
      );
    }
  }
  if (applied.length < migrations.length) {
    throw new ExportError(
      `The database is at schema version ${applied.length}, this build at ${migrations.length}: ` +
        'start Mission Control once to update it, then export.',
    );
  }
  return applied;
}

export function exportMap(db: Database, opts: ExportOptions = {}): MapExport {
  const migrations = opts.migrations ?? loadMigrations();
  const now = opts.now ?? (() => new Date().toISOString());
  return db.transaction((): MapExport => {
    const applied = checkSchema(db, migrations);
    const t = tables(db);
    const events = (
      db.prepare('SELECT id, at, payload FROM events ORDER BY id').all() as {
        id: number;
        at: string;
        payload: string;
      }[]
    ).map((r): ExportedEvent => ({
      seq: r.id,
      at: r.at,
      event: JSON.parse(r.payload) as ExportedEvent['event'],
    }));
    // Stored as plain text by `EventLog` (not JSON like the other settings).
    const logId =
      (
        db.prepare(`SELECT value FROM settings WHERE key = 'log_id'`).get() as
          { value: string } | undefined
      )?.value ?? '';
    const out: MapExport = {
      format: MAP_EXPORT_FORMAT,
      formatVersion: MAP_EXPORT_VERSION,
      exportedAt: now(),
      app: { name: 'galactic-agents', version: SERVER_VERSION },
      schema: { version: applied.at(-1)?.version ?? 0, migrations: applied },
      source: { logId, seq: events.at(-1)?.seq ?? 0 },
      includes: { transcripts: opts.transcripts === true },
      events,
      rows: {
        bodies: t.bodies.all(),
        projects: t.projects.all(),
        tasks: t.tasks.all(),
        agents: t.agents.all(),
        questions: t.questions.all(),
        proposals: t.proposals.all(),
      },
    };
    if (opts.transcripts) {
      const chunks = db
        .prepare('SELECT agent_id, seq, at, chunk FROM transcript_chunks ORDER BY agent_id, seq')
        .all() as { agent_id: string; seq: number; at: string; chunk: string }[];
      const compactions = db
        .prepare(
          `SELECT agent_id, through_seq, through_at, last_seq, removed_at, removed_chunks, reason
             FROM transcript_compactions ORDER BY agent_id`,
        )
        .all() as {
        agent_id: string;
        through_seq: number;
        through_at: string;
        last_seq: number;
        removed_at: string;
        removed_chunks: number;
        reason: 'age' | 'archived';
      }[];
      out.transcripts = {
        chunks: chunks.map((c): ExportedChunk => ({
          agentId: c.agent_id,
          seq: c.seq,
          at: c.at,
          chunk: c.chunk,
        })),
        compactions: compactions.map((c): ExportedCompaction => ({
          agentId: c.agent_id,
          throughSeq: c.through_seq,
          throughAt: c.through_at,
          lastSeq: c.last_seq,
          removedAt: c.removed_at,
          removedChunks: c.removed_chunks,
          reason: c.reason,
        })),
      };
    }
    return out;
  })();
}
