import type { Database, Statement } from 'better-sqlite3';
import type { Id, TranscriptChunk } from '@galactic/protocol';
import { REDACTION_RULES, redactSecrets, type RedactionRule } from './redact.js';

/**
 * The transcript pipeline (TECHNOLOGY §6.2; P1-06). `agent.output` never enters the event log:
 * it comes here, is redacted at once, buffered, and written to `transcript_chunks` in batches
 * (≈10 Hz). Subscribers get the same batches, so nothing unredacted ever leaves the process and
 * no client is fed per token. Per-agent `seq` is strictly increasing and survives restarts.
 *
 * Redaction is boundary-aware (P1-27): a secret that arrives split over two chunks — the way a
 * streamed key does — is caught by matching across the previous chunk's tail, and the secret's
 * head is moved from that chunk into the new one before both are redacted. That only works
 * while the previous chunk is still here, so the newest chunk of every agent is held back for
 * `holdMs` before it is flushed: long enough for the next delta to land, too short to see.
 */

export type TranscriptListener = (chunks: TranscriptChunk[]) => void;

export interface TranscriptOptions {
  /** Batch interval. */
  flushMs?: number;
  /** How long the newest chunk of an agent waits for its successor before it is flushed. */
  holdMs?: number;
  now?: () => string;
  /** The secret shapes; `redact` defaults to `redactSecrets` over them. */
  rules?: RedactionRule[];
  redact?: (text: string) => string;
  /** Called when a flush or a listener throws; the pipeline keeps going. */
  onError?: (error: unknown) => void;
  /** Max chunks kept in memory per agent before a flush is forced. */
  maxBuffered?: number;
}

interface Row {
  agent_id: string;
  seq: number;
  at: string;
  chunk: string;
}

interface Pending {
  chunk: TranscriptChunk;
  /** The text as it arrived; needed to redact across the boundary with the next chunk. */
  raw: string;
  appendedAt: number;
}

/** How much of the previous chunk's tail is matched together with the new text. */
const TAIL = 512;

export class TranscriptPipeline {
  private readonly flushMs: number;
  private readonly holdMs: number;
  private readonly now: () => string;
  private readonly rules: RedactionRule[];
  private readonly redact: (text: string) => string;
  private readonly onError: (error: unknown) => void;
  private readonly maxBuffered: number;
  private readonly insert: Statement;
  private readonly selectSince: Statement;
  private readonly selectMax: Statement;
  private readonly deleteBefore: Statement;
  private readonly nextSeq = new Map<Id, number>();
  private readonly buffer = new Map<Id, Pending[]>();
  private readonly listeners = new Map<Id, Set<TranscriptListener>>();
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private readonly db: Database,
    opts: TranscriptOptions = {},
  ) {
    this.flushMs = opts.flushMs ?? 100;
    this.holdMs = opts.holdMs ?? 250;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.rules = opts.rules ?? REDACTION_RULES;
    this.redact = opts.redact ?? ((text) => redactSecrets(text, this.rules));
    this.onError = opts.onError ?? (() => {});
    this.maxBuffered = opts.maxBuffered ?? 500;
    this.insert = db.prepare(
      'INSERT INTO transcript_chunks (agent_id, seq, at, chunk) VALUES (?, ?, ?, ?)',
    );
    this.selectSince = db.prepare(
      'SELECT agent_id, seq, at, chunk FROM transcript_chunks WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    );
    this.selectMax = db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript_chunks WHERE agent_id = ?',
    );
    this.deleteBefore = db.prepare('DELETE FROM transcript_chunks WHERE agent_id = ? AND seq <= ?');
  }

  /**
   * Redacts and buffers one piece of output. Returns the chunk as it stands now; its text can
   * still lose a trailing secret head to the next chunk while it is buffered.
   */
  append(agentId: Id, kind: TranscriptChunk['kind'], text: string): TranscriptChunk {
    const seq = this.allocateSeq(agentId);
    let pending = this.buffer.get(agentId);
    if (!pending) {
      pending = [];
      this.buffer.set(agentId, pending);
    }
    let raw = text;
    const prev = pending.at(-1);
    if (prev) {
      const cut = this.boundaryCut(prev.raw, text);
      if (cut !== undefined) {
        // The secret starts in the previous chunk: its head moves here, then both are redacted.
        raw = prev.raw.slice(cut) + text;
        prev.raw = prev.raw.slice(0, cut);
        prev.chunk.text = this.redact(prev.raw);
      }
    }
    const chunk: TranscriptChunk = { agentId, seq, at: this.now(), kind, text: this.redact(raw) };
    if (this.disposed) return chunk; // shutting down: dropped, never an exception for the caller
    pending.push({ chunk, raw, appendedAt: Date.now() });
    if (pending.length >= this.maxBuffered) this.drain(false);
    else this.schedule();
    return chunk;
  }

  /** The persisted chunks of an agent with `seq > since`, in order. */
  read(agentId: Id, since = 0, limit = 1_000): TranscriptChunk[] {
    return (this.selectSince.all(agentId, since, limit) as Row[]).map(fromRow);
  }

  /** Every persisted chunk after `since`, paged. */
  private readAll(agentId: Id, since: number): TranscriptChunk[] {
    const out: TranscriptChunk[] = [];
    let cursor = since;
    for (;;) {
      const page = this.read(agentId, cursor, 1_000);
      out.push(...page);
      if (page.length < 1_000) return out;
      cursor = page[page.length - 1]!.seq;
    }
  }

  /** The last `seq` an agent has, persisted or buffered; 0 for an unknown agent. */
  lastSeq(agentId: Id): number {
    return this.allocateSeq(agentId, false);
  }

  /**
   * Delivers the chunks after `since` (history, then whatever is buffered), then every later
   * batch, always in `seq` order. Returns the unsubscribe function.
   */
  subscribe(agentId: Id, since: number, listener: TranscriptListener): () => void {
    // A per-subscription cursor: a buffered chunk handed over at subscribe time is not sent
    // again when its batch is flushed.
    let cursor = since;
    const forward: TranscriptListener = (chunks) => {
      const fresh = chunks.filter((c) => c.seq > cursor);
      if (fresh.length === 0) return;
      cursor = fresh[fresh.length - 1]!.seq;
      listener(fresh);
    };
    const buffered = (this.buffer.get(agentId) ?? []).map((p) => ({ ...p.chunk }));
    const backlog = [...this.readAll(agentId, since), ...buffered];
    if (backlog.length > 0) this.notify(forward, backlog);
    let set = this.listeners.get(agentId);
    if (!set) {
      set = new Set();
      this.listeners.set(agentId, set);
    }
    set.add(forward);
    return () => {
      set.delete(forward);
      if (set.size === 0) this.listeners.delete(agentId);
    };
  }

  /** Writes every buffered chunk now, held ones included, and hands the batches to subscribers. */
  flush(): void {
    this.drain(true);
  }

  /**
   * The timer's flush: writes the buffered chunks in one transaction and hands the batches to
   * subscribers. The newest chunk of an agent stays behind while it is younger than `holdMs`
   * (see above) unless `all` is set.
   */
  private drain(all: boolean): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer.size === 0) return;
    const cutoff = Date.now() - this.holdMs;
    const batches: [Id, TranscriptChunk[]][] = [];
    let held = false;
    for (const [agentId, pending] of this.buffer) {
      const last = pending.at(-1)!;
      const keep = !all && this.holdMs > 0 && last.appendedAt > cutoff;
      const ready = keep ? pending.slice(0, -1) : pending;
      if (ready.length > 0) batches.push([agentId, ready.map((p) => p.chunk)]);
      if (keep) {
        held = true;
        this.buffer.set(agentId, [last]);
      } else this.buffer.delete(agentId);
    }
    if (held) this.schedule();
    if (batches.length === 0) return;
    try {
      this.db.transaction(() => {
        for (const [, chunks] of batches) {
          for (const c of chunks)
            this.insert.run(c.agentId, c.seq, c.at, JSON.stringify({ kind: c.kind, text: c.text }));
        }
      })();
    } catch (error) {
      this.onError(error);
      // Subscribers still get the batch; the rows are lost (a full disk is a Phase 8 concern).
    }
    for (const [agentId, chunks] of batches) {
      for (const listener of this.listeners.get(agentId) ?? []) this.notify(listener, chunks);
    }
  }

  /**
   * Retention hook (Phase 8): drops an agent's chunks up to `throughSeq`. A no-op unless called;
   * v1 keeps everything.
   */
  prune(agentId: Id, throughSeq: number): number {
    return this.deleteBefore.run(agentId, throughSeq).changes;
  }

  /** Flushes everything and stops the timer. */
  dispose(): void {
    this.flush();
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Where in `prevRaw` a secret begins that only completes in `text`; `undefined` when none of
   * the rules matches across the boundary.
   */
  private boundaryCut(prevRaw: string, text: string): number | undefined {
    const tail = prevRaw.slice(-TAIL);
    const joined = tail + text;
    let cut: number | undefined;
    for (const rule of this.rules) {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      const re = new RegExp(rule.pattern.source, flags);
      for (const m of joined.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (start < tail.length && end > tail.length) {
          const at = prevRaw.length - tail.length + start;
          if (cut === undefined || at < cut) cut = at;
        }
      }
    }
    return cut;
  }

  private allocateSeq(agentId: Id, advance = true): number {
    let next = this.nextSeq.get(agentId);
    if (next === undefined) {
      next = (this.selectMax.get(agentId) as { seq: number }).seq;
      this.nextSeq.set(agentId, next);
    }
    if (!advance) return next;
    next += 1;
    this.nextSeq.set(agentId, next);
    return next;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.drain(false);
    }, this.flushMs);
  }

  private notify(listener: TranscriptListener, chunks: TranscriptChunk[]): void {
    try {
      listener(chunks);
    } catch (error) {
      this.onError(error);
    }
  }
}

function fromRow(r: Row): TranscriptChunk {
  const { kind, text } = JSON.parse(r.chunk) as Pick<TranscriptChunk, 'kind' | 'text'>;
  return { agentId: r.agent_id, seq: r.seq, at: r.at, kind, text };
}
