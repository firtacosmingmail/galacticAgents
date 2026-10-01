import type { Database, Statement } from 'better-sqlite3';
import type { Id, TranscriptChunk } from '@galactic/protocol';
import {
  PRIVATE_KEY_BEGIN,
  PRIVATE_KEY_END,
  REDACTION_RULES,
  mask,
  redactSecrets,
  replaceMatch,
  type RedactionRule,
} from './redact.js';

/**
 * The transcript pipeline (TECHNOLOGY §6.2; P1-06, P1-27, P1-31). `agent.output` never enters
 * the event log: its RAW text comes here, is redacted at once, buffered, and written to
 * `transcript_chunks` in batches (≈10 Hz). Subscribers get the same batches, only after they
 * were written, so nothing unredacted ever leaves the process and no client is fed per token.
 * Per-agent `seq` is strictly increasing and survives restarts.
 *
 * Redaction is chunking-aware in three ways:
 * - **Private-key blocks** are masked by a per-agent state machine: after a `BEGIN … PRIVATE
 *   KEY` line everything is masked, in this chunk and the following ones, until the `END` line
 *   (or {@link PRIVATE_KEY_CAP} characters, after which the state resets). Header lines split
 *   over two chunks are found through a short carry of the previous raw text.
 * - **A secret split over two chunks** while the previous chunk is still buffered: the match
 *   across the previous chunk's tail moves the secret's head from that chunk into the new one,
 *   and both are redacted (P1-27). That only works while the previous chunk is still here, so
 *   the newest chunk of every agent is held back for `holdMs` before it is flushed. A held chunk
 *   is still mutable, so it is never handed out before it is written.
 * - **A secret split over two chunks after the previous one was flushed** (a gap longer than
 *   `holdMs`): the part of the match in the new chunk is masked; the head stays as it was
 *   stored (it was redacted on its own if it already matched).
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
  /** The text as it arrived (private keys masked); needed to redact across the next boundary. */
  raw: string;
  appendedAt: number;
}

interface KeyState {
  /** Inside a private-key block whose END line has not been seen yet. */
  inKey: boolean;
  /** Characters masked since the BEGIN line. */
  masked: number;
  /** The last raw characters, to find a BEGIN/END line split over two chunks. */
  carry: string;
}

/** How much of the previous chunk's tail is matched together with the new text. */
const TAIL = 512;
/** How much raw text is kept to find a key header split over two chunks (> any header line). */
const KEY_CARRY = 64;
/** After this many masked characters without an END line, masking stops (a PEM is ≤ ~3.3 KB). */
export const PRIVATE_KEY_CAP = 16 * 1024;

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
  /** The raw tail of each agent's output so far, for a boundary with an already flushed chunk. */
  private readonly tails = new Map<Id, { kind: TranscriptChunk['kind']; text: string }>();
  private readonly keys = new Map<Id, KeyState>();
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
   * Redacts and buffers one piece of RAW (unredacted) output. Returns the chunk as it stands
   * now; its text can still lose a trailing secret head to the next chunk while it is buffered.
   */
  append(agentId: Id, kind: TranscriptChunk['kind'], text: string): TranscriptChunk {
    const seq = this.allocateSeq(agentId);
    let pending = this.buffer.get(agentId);
    if (!pending) {
      pending = [];
      this.buffer.set(agentId, pending);
    }
    let raw = this.maskPrivateKeys(agentId, text);
    // Only consecutive chunks of one kind continue each other: a text delta and a tool output
    // never split one secret, and joining them would take the next word for part of a key.
    const prev = pending.at(-1);
    const tail = this.tails.get(agentId);
    let before = tail?.kind === kind ? tail.text : '';
    if (prev?.chunk.kind === kind) {
      const hit = this.boundaryMatch(prev.raw, raw);
      if (hit) {
        // The secret starts in the previous chunk: its head moves here, then both are redacted.
        const cut = prev.raw.length - Math.min(prev.raw.length, TAIL) + hit.start;
        raw = prev.raw.slice(cut) + raw;
        prev.raw = prev.raw.slice(0, cut);
        prev.chunk.text = this.redact(prev.raw);
        before = prev.raw;
      }
    } else if (!prev && before) {
      // The previous chunk is already flushed: the rest of the secret is masked here.
      const hit = this.boundaryMatch(before, raw);
      if (hit) raw = mask(hit.rule) + raw.slice(hit.end);
    }
    this.tails.set(agentId, { kind, text: (before + raw).slice(-TAIL) });
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
   * Delivers the persisted chunks after `since`, then every later batch as it is written,
   * always in `seq` order. Buffered chunks are not in the backlog: they can still change (the
   * held one) and are not written yet; they arrive with the next flush, within `flushMs` (or
   * `holdMs` for the held one). Returns the unsubscribe function.
   */
  subscribe(agentId: Id, since: number, listener: TranscriptListener): () => void {
    let cursor = since;
    const forward: TranscriptListener = (chunks) => {
      const fresh = chunks.filter((c) => c.seq > cursor);
      if (fresh.length === 0) return;
      cursor = fresh[fresh.length - 1]!.seq;
      listener(fresh);
    };
    const backlog = this.readAll(agentId, since);
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
   * The timer's flush: writes the buffered chunks in one transaction and, once that succeeded,
   * hands the batches to subscribers. The newest chunk of an agent stays behind while it is
   * younger than `holdMs` (see above) unless `all` is set. A failed write is reported to
   * `onError` and its chunks are dropped: never delivered, so a client never holds a `seq` the
   * database does not.
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
      this.onError(error); // the rows are lost (a full disk is a Phase 8 concern)
      return;
    }
    for (const [agentId, chunks] of batches) {
      for (const listener of this.listeners.get(agentId) ?? []) this.notify(listener, chunks);
    }
  }

  /**
   * Retention hook (Phase 8): drops an agent's chunks up to `throughSeq`. A no-op unless called;
   * v1 keeps everything. The newest persisted chunk is always kept: its `seq` is where the
   * agent's numbering resumes after a restart, so dropping it would hand out a `seq` again.
   */
  prune(agentId: Id, throughSeq: number): number {
    const max = (this.selectMax.get(agentId) as { seq: number }).seq;
    const through = Math.min(throughSeq, max - 1);
    if (through <= 0) return 0;
    return this.deleteBefore.run(agentId, through).changes;
  }

  /** Flushes everything and stops the timer. */
  dispose(): void {
    this.flush();
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Masks private-key blocks in the raw stream of `agentId`, whatever the chunking: from the
   * BEGIN line to the END line, or for {@link PRIVATE_KEY_CAP} characters.
   */
  private maskPrivateKeys(agentId: Id, text: string): string {
    let st = this.keys.get(agentId);
    if (!st) {
      st = { inKey: false, masked: 0, carry: '' };
      this.keys.set(agentId, st);
    }
    const s = st.carry + text;
    const offset = st.carry.length;
    let pos = offset; // `s` before `pos` is handled (emitted or masked)
    let out = '';
    while (pos < s.length) {
      // A header may start in the carry (split over two chunks) but must end in the new text.
      const from = pos === offset ? 0 : pos;
      if (!st.inKey) {
        const begin = findEnding(PRIVATE_KEY_BEGIN, s, from, pos);
        if (!begin) {
          out += s.slice(pos);
          break;
        }
        out += s.slice(pos, Math.max(begin.start, pos)) + mask('private-key');
        st.inKey = true;
        st.masked = 0;
        pos = begin.end;
        continue;
      }
      const end = findEnding(PRIVATE_KEY_END, s, from, pos);
      if (end) {
        st.inKey = false;
        pos = end.end;
        continue;
      }
      const take = Math.min(s.length - pos, PRIVATE_KEY_CAP - st.masked);
      st.masked += take;
      pos += take;
      if (st.masked >= PRIVATE_KEY_CAP) st.inKey = false; // no END in sight: stop masking
    }
    st.carry = s.slice(-KEY_CARRY);
    return out;
  }

  /**
   * The earliest secret that begins in `prevRaw`'s tail and only completes in `text`: where it
   * starts (an index into that tail), where it ends (an index into `text`) and its rule.
   */
  private boundaryMatch(
    prevRaw: string,
    text: string,
  ): { start: number; end: number; rule: string } | undefined {
    const tail = prevRaw.slice(-TAIL);
    const joined = tail + text;
    let best: { start: number; end: number; rule: string } | undefined;
    for (const rule of this.rules) {
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : `${rule.pattern.flags}g`;
      const re = new RegExp(rule.pattern.source, flags);
      for (const m of joined.matchAll(re)) {
        const start = m.index;
        const end = start + m[0].length;
        if (start >= tail.length || end <= tail.length) continue;
        if (replaceMatch(rule, m[0], m.slice(1)) === m[0]) continue; // not a secret after all
        if (!best || start < best.start || (start === best.start && end - tail.length > best.end))
          best = { start, end: end - tail.length, rule: rule.name };
      }
    }
    return best;
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

/** The first match of `pattern` in `s` at or after `from` that ends after `after`. */
function findEnding(
  pattern: RegExp,
  s: string,
  from: number,
  after: number,
): { start: number; end: number } | undefined {
  const re = new RegExp(pattern.source, 'g');
  re.lastIndex = from;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const end = m.index + m[0].length;
    if (end > after) return { start: m.index, end };
  }
  return undefined;
}

function fromRow(r: Row): TranscriptChunk {
  const { kind, text } = JSON.parse(r.chunk) as Pick<TranscriptChunk, 'kind' | 'text'>;
  return { agentId: r.agent_id, seq: r.seq, at: r.at, kind, text };
}
