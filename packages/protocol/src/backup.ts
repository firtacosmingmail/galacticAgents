import { z } from 'zod';
import { Agent, Body, Project, Proposal, Question, Task } from './domain.js';
import { Id, Timestamp } from './primitives.js';

// --- backups (P8-03; TECHNOLOGY §6.4, docs/BACKUP_RESTORE.md) -----------------------------------

/**
 * Why a backup file exists: `auto` — the daily scheduled copy; `manual` — "Back up now" in the
 * settings; `pre-import` — the copy `galactic import --replace` takes of the database it replaces.
 */
export const BackupKind = z.enum(['auto', 'manual', 'pre-import']);
export type BackupKind = z.infer<typeof BackupKind>;

/** One backup file in `<dataDir>/backups/` (a complete SQLite database, mode 0600). */
export const BackupInfo = z.object({
  /** The file name (`galactic-<UTC time>-<kind>.sqlite`); never a path. */
  name: z.string().min(1),
  kind: BackupKind,
  /** When it was taken (from the name, so it survives copies that change the file times). */
  createdAt: Timestamp,
  bytes: z.number().int().nonnegative(),
});
export type BackupInfo = z.infer<typeof BackupInfo>;

/** What the last backup attempt did. */
export const BackupOutcome = z.object({
  at: Timestamp,
  kind: BackupKind,
  /** `skipped`: not taken (the disk lacks room, or a backup was already running). */
  outcome: z.enum(['ok', 'skipped', 'failed']),
  /** The file written (`ok`). */
  name: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  ms: z.number().nonnegative().optional(),
  /** Why it was skipped or failed, in words. */
  detail: z.string().optional(),
});
export type BackupOutcome = z.infer<typeof BackupOutcome>;

/** The rotation (config.json `backups`): how many of each kind are kept. */
export const BackupSchedule = z.object({
  /** Whether the daily backup runs (manual backups always work). */
  enabled: z.boolean(),
  /** The newest daily backup of each of the last `keepDaily` days with one. */
  keepDaily: z.number().int().nonnegative(),
  /** And the newest of each of the last `keepWeekly` weeks with one (ISO weeks, UTC). */
  keepWeekly: z.number().int().nonnegative(),
  /** The newest `keepManual` manual backups, and as many pre-import copies. */
  keepManual: z.number().int().nonnegative(),
});
export type BackupSchedule = z.infer<typeof BackupSchedule>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: true,
  keepDaily: 7,
  keepWeekly: 4,
  keepManual: 5,
};

/** `GET /api/backups` (local only unless `autoApproveRemote`, decision 90). */
export const BackupsResponse = z.object({
  /** Newest first. */
  backups: z.array(BackupInfo),
  /** The folder they are in, for the restore procedure. */
  directory: z.string(),
  schedule: BackupSchedule,
  /** A backup is being taken now. */
  running: z.boolean(),
  last: BackupOutcome.optional(),
});
export type BackupsResponse = z.infer<typeof BackupsResponse>;

/** `POST /api/backups` ("Back up now"): the attempt's outcome. */
export const BackupNowResponse = BackupOutcome;
export type BackupNowResponse = BackupOutcome;

// --- export and import of the map (P8-03) --------------------------------------------------------

export const MAP_EXPORT_FORMAT = 'galactic-map-export' as const;
/** Bumped when the file's shape changes; an import refuses versions it does not know. */
export const MAP_EXPORT_VERSION = 1 as const;

/**
 * One event exactly as the log holds it: its `seq`, its `at` and its payload. The payload is kept
 * as written (not re-validated against today's event schema): an old log stays importable, and the
 * import writes it back byte for byte.
 */
export const ExportedEvent = z.object({
  seq: z.number().int().positive(),
  at: z.string().min(1),
  event: z.looseObject({ type: z.string().min(1) }),
});
export type ExportedEvent = z.infer<typeof ExportedEvent>;

/**
 * The domain rows at the export's `seq` — a check on the import's rebuild, which folds the events
 * into rows again and compares. Unlike a snapshot, `bodies` keeps retired demo bodies' tombstones
 * (P7-07): archived work still names them.
 */
export const ExportedRows = z.object({
  bodies: z.array(Body),
  projects: z.array(Project),
  tasks: z.array(Task),
  agents: z.array(Agent),
  questions: z.array(Question),
  proposals: z.array(Proposal),
});
export type ExportedRows = z.infer<typeof ExportedRows>;

export const ExportedChunk = z.object({
  agentId: Id,
  seq: z.number().int().nonnegative(),
  at: z.string().min(1),
  chunk: z.string(),
});
export type ExportedChunk = z.infer<typeof ExportedChunk>;

/** A transcript compaction marker (P8-02), exported with the chunks it describes. */
export const ExportedCompaction = z.object({
  agentId: Id,
  throughSeq: z.number().int().nonnegative(),
  throughAt: z.string().min(1),
  lastSeq: z.number().int().nonnegative(),
  removedAt: z.string().min(1),
  removedChunks: z.number().int().nonnegative(),
  reason: z.enum(['age', 'archived']),
});
export type ExportedCompaction = z.infer<typeof ExportedCompaction>;

/**
 * `galactic export <file>` / `GET /api/export`: the map and its history as one JSON document. The
 * event log is the truth (TECHNOLOGY §6.1: everything else is a projection), so it is exported
 * whole; the rows ride along as a check. Never in it: the token, VAPID keys, push subscriptions,
 * `config.json`, the process table, agents' runtime sessions (they live in each CLI's own store),
 * and transcripts unless asked for.
 */
export const MapExport = z.object({
  format: z.literal(MAP_EXPORT_FORMAT),
  formatVersion: z.literal(MAP_EXPORT_VERSION),
  exportedAt: Timestamp,
  app: z.object({ name: z.string(), version: z.string() }),
  /** The database's applied migrations: an import needs a build with the same ones (or more). */
  schema: z.object({
    version: z.number().int().nonnegative(),
    migrations: z.array(z.object({ version: z.number().int().positive(), name: z.string() })),
  }),
  /** The exported log: its identity and its last `seq`. */
  source: z.object({ logId: z.string(), seq: z.number().int().nonnegative() }),
  includes: z.object({ transcripts: z.boolean() }),
  events: z.array(ExportedEvent),
  rows: ExportedRows,
  transcripts: z
    .object({ chunks: z.array(ExportedChunk), compactions: z.array(ExportedCompaction) })
    .optional(),
});
export type MapExport = z.infer<typeof MapExport>;

/** `GET /api/export?transcripts=1`. */
export const ExportQuery = z.object({
  transcripts: z
    .enum(['0', '1', 'true', 'false'])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});
