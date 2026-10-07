import type { Database, Statement } from 'better-sqlite3';
import type {
  ConversationEntry,
  ConversationResponse,
  Event,
  Id,
  TranscriptChunk,
  TranscriptResponse,
} from '@galactic/protocol';
import { CursorError } from './cursor-error.js';
import { readCompaction } from './transcript-retention.js';
import { HIGH_WATER_SQL } from './transcripts.js';

/**
 * Paged reads for the side panel (P25-01): an agent's conversation and its transcript, straight
 * from the two streams of TECHNOLOGY §6.2 — never a scan of the whole log.
 *
 * **The conversation** of an agent is what the chat shows: every `message.sent` to it (the user's
 * lines, its subordinates' reports, the system's notices — but not a brain's turn prompts,
 * `turn: true`, P25-03) and every `text` chunk of its own
 * transcript (its replies: the SDK adapter emits one chunk per assistant text block, so a chunk
 * is a whole reply); both read through migration 0007's partial indexes. The two are merged by
 * time — (`at`, messages first, then `seq`) — and the position in that order is the cursor:
 * `<at>~m<seq>` or `<at>~r<chunkSeq>`, opaque to clients. The newest page comes first; `before`
 * pages back and `after` forward, so a reloaded chat can show the last page and load older ones
 * on scroll. A reply still buffered in the transcript pipeline (≤ 250 ms) is not in the page yet;
 * it arrives on the transcript stream subscribed from the page's `lastSeq` (the newest persisted
 * chunk, read in the same synchronous call, so nothing falls between the page and the stream).
 */

interface Cursor {
  at: string;
  /** 0 = message (event), 1 = reply (transcript chunk): the tiebreak at the same instant. */
  src: 0 | 1;
  n: number;
}

const encode = (c: Cursor) => `${c.at}~${c.src === 0 ? 'm' : 'r'}${c.n}`;

/** The cursor a client sent back, or `undefined` when it is not one of ours. */
export function decodeCursor(raw: string): Cursor | undefined {
  const m = /^(.+)~([mr])(\d+)$/.exec(raw);
  if (!m || Number.isNaN(Date.parse(m[1]!))) return undefined;
  return { at: m[1]!, src: m[2] === 'm' ? 0 : 1, n: Number(m[3]) };
}

interface EventRow {
  id: number;
  at: string;
  payload: string;
}
interface ChunkRow {
  seq: number;
  at: string;
  chunk: string;
}

export class History {
  private readonly stmts = new Map<string, Statement>();

  constructor(private readonly db: Database) {}

  private stmt(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  conversation(
    agentId: Id,
    q: { before?: string | undefined; after?: string | undefined; limit: number },
  ): ConversationResponse {
    const raw = q.before ?? q.after;
    const cursor = raw === undefined ? undefined : decodeCursor(raw);
    if (raw !== undefined && !cursor) throw new CursorError(`not a conversation cursor: ${raw}`);
    const forward = q.after !== undefined;
    const take = q.limit + 1;

    // Messages: `src` 0. Older than the cursor: (at, id) below the cursor's when it is a message,
    // else at <= its instant (messages come first at the same instant). Newer: the mirror image.
    // Replies: `src` 1, likewise. Row values keep each bound one range of the partial indexes of
    // migration 0007 — (agentId, at, id) over `message.sent`, (agent_id, at, seq) over the `text`
    // chunks — which also serve the ORDER BY: a page reads only its rows.
    let msgWhere = '';
    let chunkWhere = '';
    const msgArgs: unknown[] = [agentId];
    const chunkArgs: unknown[] = [agentId];
    if (cursor) {
      const [lt, le] = forward ? ['>', '>='] : ['<', '<='];
      if (cursor.src === 0) {
        msgWhere = `AND (at, id) ${lt} (?, ?)`;
        msgArgs.push(cursor.at, cursor.n);
        chunkWhere = `AND at ${forward ? le : lt} ?`;
        chunkArgs.push(cursor.at);
      } else {
        msgWhere = `AND at ${forward ? lt : le} ?`;
        msgArgs.push(cursor.at);
        chunkWhere = `AND (at, seq) ${lt} (?, ?)`;
        chunkArgs.push(cursor.at, cursor.n);
      }
    }
    const dir = forward ? 'ASC' : 'DESC';
    const messages = this.stmt(
      `SELECT id, at, payload FROM events
        WHERE type = 'message.sent' AND json_extract(payload, '$.agentId') = ?
          AND json_extract(payload, '$.turn') IS NULL ${msgWhere}
        ORDER BY at ${dir}, id ${dir} LIMIT ${take}`,
    ).all(...msgArgs) as EventRow[];
    const replies = this.stmt(
      `SELECT seq, at, chunk FROM transcript_chunks
        WHERE agent_id = ? AND json_valid(chunk) AND json_extract(chunk, '$.kind') = 'text'
          ${chunkWhere}
        ORDER BY at ${dir}, seq ${dir} LIMIT ${take}`,
    ).all(...chunkArgs) as ChunkRow[];

    const entries: [Cursor, ConversationEntry][] = [];
    for (const row of messages) {
      const event = JSON.parse(row.payload) as Event;
      if (event.type !== 'message.sent') continue;
      const key: Cursor = { at: row.at, src: 0, n: row.id };
      entries.push([
        key,
        {
          id: `m:${event.messageId}`,
          agentId,
          kind: 'message',
          at: row.at,
          sender: event.sender,
          text: event.text,
          messageId: event.messageId,
          seq: row.id,
          cursor: encode(key),
        },
      ]);
    }
    for (const row of replies) {
      const { text } = JSON.parse(row.chunk) as { text: string };
      if (text.trim() === '') continue;
      const key: Cursor = { at: row.at, src: 1, n: row.seq };
      entries.push([
        key,
        {
          id: `r:${agentId}:${row.seq}`,
          agentId,
          kind: 'reply',
          at: row.at,
          sender: { type: 'agent', id: agentId },
          text,
          chunkSeq: row.seq,
          cursor: encode(key),
        },
      ]);
    }
    entries.sort((a, b) => compare(a[0], b[0]) * (forward ? 1 : -1));
    const page = entries.slice(0, q.limit);
    if (!forward) page.reverse();
    const compacted = readCompaction(this.db, agentId);
    return {
      entries: page.map(([, entry]) => entry),
      hasMore: entries.length > q.limit,
      lastSeq: this.maxSeq(agentId),
      ...(compacted ? { compacted } : {}),
    };
  }

  /**
   * An agent's persisted transcript by per-agent `seq`, oldest first: the newest `limit` chunks,
   * those before `before`, or those after `after` (what `transcript.subscribe{since}` takes).
   * `kinds` filters; the page is `limit` chunks of those kinds.
   */
  transcript(
    agentId: Id,
    q: {
      before?: number | undefined;
      after?: number | undefined;
      limit: number;
      kinds?: TranscriptChunk['kind'][] | undefined;
    },
  ): TranscriptResponse {
    const forward = q.after !== undefined;
    const args: unknown[] = [agentId];
    let where = '';
    if (q.after !== undefined) {
      where += ' AND seq > ?';
      args.push(q.after);
    } else if (q.before !== undefined) {
      where += ' AND seq < ?';
      args.push(q.before);
    }
    if (q.kinds) {
      where += ` AND json_extract(chunk, '$.kind') IN (${q.kinds.map(() => '?').join(', ')})`;
      args.push(...q.kinds);
    }
    const rows = this.stmt(
      `SELECT seq, at, chunk FROM transcript_chunks WHERE agent_id = ?${where}
        ORDER BY seq ${forward ? 'ASC' : 'DESC'} LIMIT ${q.limit + 1}`,
    ).all(...args) as ChunkRow[];
    const page = rows.slice(0, q.limit);
    if (!forward) page.reverse();
    const compacted = readCompaction(this.db, agentId);
    return {
      ...(compacted ? { compacted } : {}),
      chunks: page.map((r) => {
        const { kind, text } = JSON.parse(r.chunk) as Pick<TranscriptChunk, 'kind' | 'text'>;
        return { agentId, seq: r.seq, at: r.at, kind, text };
      }),
      hasMore: rows.length > q.limit,
      lastSeq: this.maxSeq(agentId),
    };
  }

  /**
   * The newest persisted `seq` of an agent (no pipeline to ask), or its high-water mark when
   * retention removed its newest chunks (P8-02).
   */
  maxSeq(agentId: Id): number {
    return (this.stmt(HIGH_WATER_SQL).get(agentId, agentId) as { seq: number }).seq;
  }
}

function compare(a: Cursor, b: Cursor): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.src !== b.src) return a.src - b.src;
  return a.n - b.n;
}
