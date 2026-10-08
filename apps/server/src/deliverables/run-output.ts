import type { Database } from 'better-sqlite3';
import type { Id, RunOutputChunk, RunOutputResponse, TranscriptChunk } from '@galactic/protocol';
import { TranscriptPipeline, type ChunkStore } from '../runtime/transcripts.js';

/**
 * A managed run's output (P9-08; TECHNOLOGY §9.8, SPEC decision 130). The raw stdout and stderr
 * of a run go through the transcript pipeline's boundary-aware redaction (§6.2: a key split over
 * two reads is still caught, a private-key block is masked whatever the chunking), are written
 * to `run_output` in batches (≈ 10 Hz) and handed to subscribers only once written — so nothing
 * unredacted is stored or leaves the process, and a client never holds a `seq` the database does
 * not. ANSI sequences are kept (the panel renders them in a terminal view).
 *
 * **The byte limit** (`deliverables.runs.output.maxBytesPerRun`, read at every write): when a
 * run's stored output passes it, its oldest chunks are deleted in the same transaction as the
 * write — the newest one always stays — so the run keeps its newest part ("earlier output
 * dropped"); `GET /api/runs/:id/output` reports how much went as `truncatedBefore` (the `seq`
 * before the oldest kept chunk). A batch the storage refuses is dropped, never delivered (the
 * transcript rule of P8-04): a full disk loses output, never the server's other writes.
 */

export interface RunOutputOptions {
  /** The byte limit per run, read at every write (the setting applies live). */
  maxBytesPerRun: () => number;
  flushMs?: number;
  holdMs?: number;
  now?: () => string;
  onError?: (error: unknown) => void;
  /** The most bytes a subscription's backlog sends (default `RUN_BACKLOG_BYTES`). */
  backlogBytes?: number;
}

type OutputRow = { run_id: string; seq: number; at: string; chunk: string };

/** `run_output` as a pipeline store, with the per-run byte limit applied in each write. */
export function runOutputStore(db: Database, maxBytes: () => number): ChunkStore {
  const insert = db.prepare('INSERT INTO run_output (run_id, seq, at, chunk) VALUES (?, ?, ?, ?)');
  const since = db.prepare(
    'SELECT run_id, seq, at, chunk FROM run_output WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  );
  const max = db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM run_output WHERE run_id = ?');
  const total = db.prepare(
    'SELECT COALESCE(SUM(length(CAST(chunk AS BLOB))), 0) AS n FROM run_output WHERE run_id = ?',
  );
  const sizes = db.prepare(
    'SELECT seq, length(CAST(chunk AS BLOB)) AS n FROM run_output WHERE run_id = ? ORDER BY seq',
  );
  const drop = db.prepare('DELETE FROM run_output WHERE run_id = ? AND seq <= ?');
  /** Each run's stored bytes, read once from the table and then kept in step with the writes. */
  const bytes = new Map<Id, number>();
  const write = db.transaction((chunks: readonly TranscriptChunk[]) => {
    const touched = new Set<Id>();
    for (const c of chunks) {
      if (!bytes.has(c.agentId)) {
        bytes.set(c.agentId, (total.get(c.agentId) as { n: number }).n);
      }
      insert.run(c.agentId, c.seq, c.at, c.text);
      bytes.set(c.agentId, bytes.get(c.agentId)! + Buffer.byteLength(c.text));
      touched.add(c.agentId);
    }
    const limit = maxBytes();
    for (const runId of touched) {
      let stored = bytes.get(runId)!;
      if (stored <= limit) continue;
      const rows = sizes.all(runId) as { seq: number; n: number }[];
      let through: number | undefined;
      // The oldest first, never the newest chunk.
      for (const row of rows.slice(0, -1)) {
        if (stored <= limit) break;
        stored -= row.n;
        through = row.seq;
      }
      if (through !== undefined) drop.run(runId, through);
      bytes.set(runId, stored);
    }
  });
  return {
    write: (chunks) => {
      try {
        write(chunks);
      } catch (error) {
        bytes.clear(); // re-read from the table: the transaction rolled back
        throw error;
      }
    },
    read: (runId, after, limit) =>
      (since.all(runId, after, limit) as OutputRow[]).map((r) => ({
        agentId: r.run_id,
        seq: r.seq,
        at: r.at,
        kind: 'text' as const,
        text: r.chunk,
      })),
    highWater: (runId) => (max.get(runId) as { seq: number }).seq,
  };
}

const toRunChunk = (c: TranscriptChunk): RunOutputChunk => ({
  runId: c.agentId,
  seq: c.seq,
  at: c.at,
  chunk: c.text,
});

/** The most bytes of output one `run_output` message carries (a larger single chunk goes alone). */
export const RUN_OUTPUT_PAGE_BYTES = 256 * 1024;

/**
 * The most bytes of stored output a `run.subscribe` sends as its backlog (P9-12 review N7): the
 * newest part only. What is older is read over REST (`GET /api/runs/:id/output`), as the panel
 * does first, so a long run's backlog never fills the socket's send buffer.
 */
export const RUN_BACKLOG_BYTES = 4 * RUN_OUTPUT_PAGE_BYTES;

/** `chunks` split into runs of at most `max` bytes, in order. */
export function pagesOf(
  chunks: readonly RunOutputChunk[],
  max = RUN_OUTPUT_PAGE_BYTES,
): RunOutputChunk[][] {
  const pages: RunOutputChunk[][] = [];
  let page: RunOutputChunk[] = [];
  let bytes = 0;
  for (const c of chunks) {
    const n = Buffer.byteLength(c.chunk);
    if (page.length > 0 && bytes + n > max) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(c);
    bytes += n;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

export class RunOutput {
  private readonly pipeline: TranscriptPipeline;
  private readonly oldest;
  private readonly newestFirst;
  private readonly backlogBytes: number;

  constructor(db: Database, opts: RunOutputOptions) {
    this.pipeline = new TranscriptPipeline(db, {
      store: runOutputStore(db, opts.maxBytesPerRun),
      ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}),
      ...(opts.holdMs !== undefined ? { holdMs: opts.holdMs } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.onError ? { onError: opts.onError } : {}),
    });
    this.oldest = db.prepare('SELECT MIN(seq) AS seq FROM run_output WHERE run_id = ?');
    this.newestFirst = db.prepare(
      'SELECT seq, length(CAST(chunk AS BLOB)) AS n FROM run_output WHERE run_id = ? AND seq > ? ORDER BY seq DESC',
    );
    this.backlogBytes = opts.backlogBytes ?? RUN_BACKLOG_BYTES;
  }

  /**
   * Where a subscription's backlog starts: `since`, or later when what is stored after `since`
   * is more than `backlogBytes` — then only the newest chunks that fit (at least one) are sent.
   */
  private backlogFrom(runId: Id, since: number): number {
    let bytes = 0;
    for (const row of this.newestFirst.iterate(runId, since) as Iterable<{
      seq: number;
      n: number;
    }>) {
      if (bytes > 0 && bytes + row.n > this.backlogBytes) return row.seq;
      bytes += row.n;
    }
    return since;
  }

  /** RAW output of a run (stdout or stderr): redacted, buffered, written in batches. */
  append(runId: Id, text: string): void {
    if (text !== '') this.pipeline.append(runId, 'text', text);
  }

  /**
   * Persisted output after `since`, then each written batch (`run.subscribe`), handed over in
   * pages of at most `RUN_OUTPUT_PAGE_BYTES` (review N2: a 64 MiB backlog is not one socket
   * message; a single chunk larger than a page goes alone). The backlog is the newest
   * `RUN_BACKLOG_BYTES` at most (P9-12 review N7): a client reads anything older over REST.
   */
  subscribe(runId: Id, since: number, listener: (chunks: RunOutputChunk[]) => void): () => void {
    return this.pipeline.subscribe(runId, this.backlogFrom(runId, since), (chunks) => {
      for (const page of pagesOf(chunks.map(toRunChunk))) listener(page);
    });
  }

  /** `GET /api/runs/:id/output?after=&limit=`. */
  page(runId: Id, after = 0, limit = 1_000): RunOutputResponse {
    const rows = this.pipeline.read(runId, after, limit + 1);
    const oldest = (this.oldest.get(runId) as { seq: number | null }).seq;
    return {
      runId,
      chunks: rows.slice(0, limit).map(toRunChunk),
      ...(oldest !== null && oldest > 1 ? { truncatedBefore: oldest - 1 } : {}),
      hasMore: rows.length > limit,
    };
  }

  /** Writes what is buffered now (a run that ended: its last words before `run.ended`). */
  flush(): void {
    this.pipeline.flush();
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}
