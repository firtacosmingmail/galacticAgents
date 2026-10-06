import type { Database, Statement } from 'better-sqlite3';
import {
  DEFAULT_TRANSCRIPT_RETENTION,
  type Id,
  type TranscriptCompaction,
  type TranscriptRetention as RetentionPolicy,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { nextTick, vacuumIncrementally, type VacuumReport } from '../db/vacuum.js';
import type { Timers } from './archival.js';

/**
 * Transcript retention and compaction (P8-02; TECHNOLOGY §6.2). `transcript_chunks` is the one
 * store that grows without bound (every token an agent writes); the event log stays whole — it
 * is what resume (`lastEventId`), the timeline replay and the history are read from, and it is
 * small. Compaction **removes chunks**, oldest first, and records what it removed per agent in
 * `transcript_compactions` (migration 0011), so the transcript and chat views can say "older
 * transcript removed on <date> by retention" instead of silently showing a partial transcript.
 * No summary is kept: a summary would be an LLM's or a truncation's, and the log already keeps
 * the facts (messages, tool calls, states, questions).
 *
 * The policy (settings, `TranscriptRetention`, in days, `null` = keep):
 * - `archivedDays` — an agent whose work is archived (its task, or a project in its chain) for
 *   longer than this loses its whole transcript. The archive time comes from the log (the last
 *   `*.state_changed` into `archived`), falling back to the row's `updatedAt`.
 * - `maxAgeDays` — any other agent (the Harmonizer included) loses the chunks older than this:
 *   always a prefix, so what is left is a contiguous tail after `through_seq`.
 * - **Pinned work is never compacted**: an agent whose task or any project in its chain is
 *   pinned is skipped by both rules (decision 11b, 41).
 *
 * The job never holds the event loop for long: chunks are deleted in batches of `batchSize`, one
 * transaction each, awaiting between batches; then the free pages are released by
 * `vacuumIncrementally` in small steps (`db/vacuum.ts`). The marker row is written in the same
 * transaction as each batch, so a crash mid-way leaves a marker that covers what was removed.
 * It also keeps the agent's high-water `seq` (`last_seq`): even an agent's newest chunk can go,
 * and its numbering still resumes after it.
 */

export type { RetentionPolicy };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the job runs: like the archival sweep, hourly. */
export const TRANSCRIPT_RETENTION_INTERVAL_MS = 60 * 60 * 1000;
/** Chunks deleted per transaction (≈ 10–30 ms each at ~450 B a chunk; P8-02 notes). */
export const COMPACTION_BATCH = 500;

export interface AgentCompaction {
  agentId: Id;
  reason: 'age' | 'archived';
  removed: number;
  throughSeq: number;
}

export interface CompactionReport {
  /** When the run started (the policy's clock). */
  at: string;
  agents: AgentCompaction[];
  removedChunks: number;
  /** Delete batches (transactions) run. */
  batches: number;
  /** The longest delete batch, in ms (the longest the event loop was held while deleting). */
  longestBatchMs: number;
  /** Agents skipped because their work is pinned. */
  pinned: number;
  vacuum: VacuumReport;
  ms: number;
}

export interface TranscriptRetentionOptions {
  db: Database;
  tables: Tables;
  policy?: RetentionPolicy;
  /** The clock (ISO); injectable for tests. */
  now?: () => string;
  timers?: Timers;
  batchSize?: number;
  vacuumStepPages?: number;
  /** Awaited between batches and vacuum steps (default: the next event-loop turn). */
  pause?: () => Promise<void>;
  onError?: (error: unknown) => void;
  onRun?: (report: CompactionReport) => void;
}

/** What one agent's chunks are due for, by the policy (`undefined`: nothing). */
interface Due {
  reason: 'age' | 'archived';
  /** `age`: chunks written before this instant; `archived`: every chunk up to `maxSeq`. */
  before?: string;
  maxSeq?: number;
}

interface CompactionRow {
  through_seq: number;
  through_at: string;
  removed_at: string;
  reason: 'age' | 'archived';
}

const NODE_TIMERS: Timers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const markerStmts = new WeakMap<Database, Statement>();

/** The compaction marker of an agent, as the views report it. */
export function readCompaction(db: Database, agentId: Id): TranscriptCompaction | undefined {
  let stmt = markerStmts.get(db);
  if (!stmt) {
    stmt = db.prepare(
      'SELECT through_seq, through_at, removed_at, reason FROM transcript_compactions WHERE agent_id = ?',
    );
    markerStmts.set(db, stmt);
  }
  const row = stmt.get(agentId) as CompactionRow | undefined;
  return row
    ? {
        throughSeq: row.through_seq,
        throughAt: row.through_at,
        removedAt: row.removed_at,
        reason: row.reason,
      }
    : undefined;
}

export class TranscriptRetention {
  /** Mutable: a settings write applies from the next run on. */
  policy: RetentionPolicy;
  private readonly db: Database;
  private readonly tables: Tables;
  private readonly now: () => string;
  private readonly timers: Timers;
  private readonly batchSize: number;
  private readonly pause: () => Promise<void>;
  private handle: unknown;
  /** Set by `stop()`: a run in flight ends at its next pause (the database may be closing). */
  private stopped = false;
  private inFlight: Promise<CompactionReport> | undefined;
  private readonly stmts: Record<
    'nextAgent' | 'head' | 'maxSeq' | 'remove' | 'mark' | 'archivedAt',
    Statement
  >;

  constructor(private readonly opts: TranscriptRetentionOptions) {
    this.db = opts.db;
    this.tables = opts.tables;
    this.policy = opts.policy ?? DEFAULT_TRANSCRIPT_RETENTION;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.timers = opts.timers ?? NODE_TIMERS;
    this.batchSize = opts.batchSize ?? COMPACTION_BATCH;
    this.pause = opts.pause ?? nextTick;
    this.stmts = {
      // Distinct agents by index seeks on the primary key (agent_id, seq): no scan of the table.
      nextAgent: this.db.prepare(
        'SELECT agent_id FROM transcript_chunks WHERE agent_id > ? ORDER BY agent_id LIMIT 1',
      ),
      head: this.db.prepare(
        'SELECT seq, at FROM transcript_chunks WHERE agent_id = ? ORDER BY seq LIMIT ?',
      ),
      maxSeq: this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript_chunks WHERE agent_id = ?',
      ),
      remove: this.db.prepare('DELETE FROM transcript_chunks WHERE agent_id = ? AND seq <= ?'),
      mark: this.db.prepare(
        `INSERT INTO transcript_compactions
           (agent_id, through_seq, through_at, last_seq, removed_at, removed_chunks, reason)
         VALUES (@agentId, @throughSeq, @throughAt, @lastSeq, @removedAt, @removed, @reason)
         ON CONFLICT (agent_id) DO UPDATE SET
           through_at = CASE WHEN excluded.through_seq > through_seq
                             THEN excluded.through_at ELSE through_at END,
           through_seq = MAX(through_seq, excluded.through_seq),
           last_seq = MAX(last_seq, excluded.last_seq),
           removed_at = excluded.removed_at,
           removed_chunks = removed_chunks + excluded.removed_chunks,
           reason = excluded.reason`,
      ),
      // When each project or task last entered `archived` (the indexed `type`, then the payload).
      archivedAt: this.db.prepare(
        `SELECT coalesce(json_extract(payload, '$.taskId'), json_extract(payload, '$.projectId'))
                  AS id,
                type, MAX(at) AS at
           FROM events
          WHERE type IN ('project.state_changed', 'task.state_changed')
            AND json_extract(payload, '$.to') = 'archived'
          GROUP BY type, id`,
      ),
    };
  }

  /**
   * One run: removes what the policy says is due, then gives the space back. Concurrent calls
   * share the run in flight.
   */
  run(): Promise<CompactionReport> {
    this.stopped = false;
    this.inFlight ??= this.compact().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  get running(): boolean {
    return this.handle !== undefined;
  }

  /** Starts the timer; with `immediate` (the default) it also runs once now. */
  start(intervalMs = TRANSCRIPT_RETENTION_INTERVAL_MS, { immediate = true } = {}): void {
    if (this.handle !== undefined) return;
    const tick = () => {
      this.run().then(
        (report) => this.opts.onRun?.(report),
        (error: unknown) => this.opts.onError?.(error),
      );
    };
    this.handle = this.timers.setInterval(tick, intervalMs);
    if (immediate) tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.handle === undefined) return;
    this.timers.clearInterval(this.handle);
    this.handle = undefined;
  }

  /** What each agent with chunks is due for, by the policy and the clock. */
  plan(at = this.now()): { due: Map<Id, Due>; pinned: number } {
    const now = Date.parse(at);
    const { maxAgeDays, archivedDays } = this.policy;
    const archived = this.archiveTimes();
    const due = new Map<Id, Due>();
    let pinned = 0;
    for (let id = this.nextAgent(''); id !== undefined; id = this.nextAgent(id)) {
      const work = this.workOf(id, archived);
      if (work.pinned) {
        pinned += 1;
        continue;
      }
      if (
        archivedDays !== null &&
        work.archivedAt !== undefined &&
        Date.parse(work.archivedAt) + archivedDays * DAY_MS <= now
      ) {
        due.set(id, { reason: 'archived', maxSeq: this.maxSeq(id) });
      } else if (maxAgeDays !== null) {
        const before = new Date(now - maxAgeDays * DAY_MS).toISOString();
        const [head] = this.head(id, 1);
        if (head && head.at < before) due.set(id, { reason: 'age', before });
      }
    }
    return { due, pinned };
  }

  private async compact(): Promise<CompactionReport> {
    const started = performance.now();
    const at = this.now();
    const { due, pinned } = this.plan(at);
    const report: CompactionReport = {
      at,
      agents: [],
      removedChunks: 0,
      batches: 0,
      longestBatchMs: 0,
      pinned,
      vacuum: { mode: 'none', pagesFreed: 0, steps: 0, longestStepMs: 0, ms: 0 },
      ms: 0,
    };
    for (const [agentId, d] of due) {
      const done: AgentCompaction = { agentId, reason: d.reason, removed: 0, throughSeq: 0 };
      for (;;) {
        const t = performance.now();
        const step = this.removeBatch(agentId, d, at);
        if (step) {
          report.batches += 1;
          report.longestBatchMs = Math.max(report.longestBatchMs, performance.now() - t);
          done.removed += step.removed;
          done.throughSeq = step.throughSeq;
        }
        if (!step?.more) break;
        await this.pause();
        if (this.stopped) break;
      }
      if (done.removed > 0) {
        report.agents.push(done);
        report.removedChunks += done.removed;
      }
      await this.pause();
      if (this.stopped) break;
    }
    if (report.removedChunks > 0 && !this.stopped) {
      report.vacuum = await vacuumIncrementally(this.db, {
        ...(this.opts.vacuumStepPages ? { stepPages: this.opts.vacuumStepPages } : {}),
        pause: this.pause,
      });
    }
    report.ms = performance.now() - started;
    return report;
  }

  /**
   * Removes the next batch of an agent's due chunks — always the oldest ones, so what is left is
   * a contiguous tail — and records it, in one transaction. `undefined` when nothing is due.
   */
  private removeBatch(
    agentId: Id,
    due: Due,
    removedAt: string,
  ): { removed: number; throughSeq: number; more: boolean } | undefined {
    return this.db.transaction(() => {
      const rows = this.head(agentId, this.batchSize);
      let n = 0;
      while (n < rows.length && this.isDue(rows[n]!, due)) n += 1;
      if (n === 0) return undefined;
      const last = rows[n - 1]!;
      const lastSeq = this.maxSeq(agentId);
      const removed = this.stmts.remove.run(agentId, last.seq).changes;
      this.stmts.mark.run({
        agentId,
        throughSeq: last.seq,
        throughAt: last.at,
        lastSeq,
        removedAt,
        removed,
        reason: due.reason,
      });
      return { removed, throughSeq: last.seq, more: n === rows.length };
    })();
  }

  private isDue(row: { seq: number; at: string }, due: Due): boolean {
    return due.reason === 'archived' ? row.seq <= (due.maxSeq ?? 0) : row.at < due.before!;
  }

  private nextAgent(after: string): Id | undefined {
    return (this.stmts.nextAgent.get(after) as { agent_id: Id } | undefined)?.agent_id;
  }

  private head(agentId: Id, limit: number): { seq: number; at: string }[] {
    return this.stmts.head.all(agentId, limit) as { seq: number; at: string }[];
  }

  private maxSeq(agentId: Id): number {
    return (this.stmts.maxSeq.get(agentId) as { seq: number }).seq;
  }

  /** `{task: {id: at}, project: {id: at}}`: the last move into `archived`, from the log. */
  private archiveTimes(): { task: Map<Id, string>; project: Map<Id, string> } {
    const task = new Map<Id, string>();
    const project = new Map<Id, string>();
    for (const r of this.stmts.archivedAt.all() as { id: Id; type: string; at: string }[]) {
      (r.type === 'task.state_changed' ? task : project).set(r.id, r.at);
    }
    return { task, project };
  }

  /**
   * The work an agent belongs to: its task and the chain of projects above it (the agent's own
   * project, else its task's, then each parent). Pinned when any of them is; archived since the
   * latest archive time among the archived ones (the conservative choice: kept longer).
   */
  private workOf(
    agentId: Id,
    archived: { task: Map<Id, string>; project: Map<Id, string> },
  ): { pinned: boolean; archivedAt?: string } {
    const agent = this.tables.agents.get(agentId);
    if (!agent) return { pinned: false };
    let pinned = false;
    let archivedAt: string | undefined;
    const archivedSince = (at: string) => {
      if (archivedAt === undefined || at > archivedAt) archivedAt = at;
    };
    const task = agent.taskId ? this.tables.tasks.get(agent.taskId) : undefined;
    if (task) {
      pinned ||= task.pinned === true;
      if (task.state === 'archived') archivedSince(archived.task.get(task.id) ?? task.updatedAt);
    }
    const seen = new Set<Id>();
    for (
      let projectId = agent.projectId ?? task?.projectId;
      projectId !== undefined && !seen.has(projectId);
      projectId = this.tables.projects.get(projectId)?.parentProjectId
    ) {
      seen.add(projectId);
      const project = this.tables.projects.get(projectId);
      if (!project) break;
      pinned ||= project.pinned === true;
      if (project.state === 'archived')
        archivedSince(archived.project.get(project.id) ?? project.updatedAt);
    }
    return archivedAt !== undefined ? { pinned, archivedAt } : { pinned };
  }
}
