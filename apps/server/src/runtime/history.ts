import type { Database, Statement } from 'better-sqlite3';
import type {
  ConversationEntry,
  ConversationResponse,
  Event,
  Id,
  TranscriptChunk,
  TranscriptResponse,
} from '@galactic/protocol';
import type { TranscriptPipeline } from './transcripts.js';

/**
 * Paged reads for the side panel (P25-01): an agent's conversation and its transcript, straight
 * from the two streams of TECHNOLOGY §6.2 — never a scan of the whole log.
 *
 * **The conversation** of an agent is what the chat shows: every `message.sent` to it (the user's
 * lines, its subordinates' reports, the system's notices; the `(type, agentId)` index of
 * migration 0006) and every `text` chunk of its own transcript (its replies: the SDK adapter
 * emits one chunk per assistant text block, so a chunk is a whole reply). The two are merged by
 * time — (`at`, messages first, then `seq`) — and the position in that order is the cursor:
 * `<at>~m<seq>` or `<at>~r<chunkSeq>`, opaque to clients. The newest page comes first; `before`
 * pages back and `after` forward, so a reloaded chat can show the last page and load older ones
 * on scroll. A reply still buffered in the transcript pipeline (≤ 250 ms) is not in the page yet;
 * it arrives on the transcript stream.
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

  constructor(
    private readonly db: Database,
    private readonly transcripts?: TranscriptPipeline,
  ) {}

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
    if (raw !== undefined && !cursor) throw new RangeError(`not a conversation cursor: ${raw}`);
    const forward = q.after !== undefined;
    const take = q.limit + 1;

    // Messages: `src` 0. Older than the cursor: at < c.at, or the same instant and (the cursor is
    // a reply, or an earlier id). Newer: at > c.at, or the same instant, the cursor a message, a
    // later id. Replies: `src` 1, the mirror image.
    let msgWhere = '';
    let chunkWhere = '';
    const msgArgs: unknown[] = [agentId];
    const chunkArgs: unknown[] = [agentId];
    if (cursor) {
      if (!forward) {
        msgWhere = cursor.src === 1 ? 'AND at <= ?' : 'AND (at < ? OR (at = ? AND id < ?))';
        chunkWhere = cursor.src === 1 ? 'AND (at < ? OR (at = ? AND seq < ?))' : 'AND at < ?';
      } else {
        msgWhere = cursor.src === 1 ? 'AND at > ?' : 'AND (at > ? OR (at = ? AND id > ?))';
        chunkWhere = cursor.src === 1 ? 'AND (at > ? OR (at = ? AND seq > ?))' : 'AND at >= ?';
      }
      const three = [cursor.at, cursor.at, cursor.n];
      msgArgs.push(...(cursor.src === 0 ? three : [cursor.at]));
      chunkArgs.push(...(cursor.src === 1 ? three : [cursor.at]));
    }
    const dir = forward ? 'ASC' : 'DESC';
    const messages = this.stmt(
      `SELECT id, at, payload FROM events
        WHERE type = 'message.sent' AND json_extract(payload, '$.agentId') = ? ${msgWhere}
        ORDER BY at ${dir}, id ${dir} LIMIT ${take}`,
    ).all(...msgArgs) as EventRow[];
    const replies = this.stmt(
      `SELECT seq, at, chunk FROM transcript_chunks
        WHERE agent_id = ? AND json_extract(chunk, '$.kind') = 'text' ${chunkWhere}
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
    return {
      entries: page.map(([, entry]) => entry),
      hasMore: entries.length > q.limit,
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
    return {
      chunks: page.map((r) => {
        const { kind, text } = JSON.parse(r.chunk) as Pick<TranscriptChunk, 'kind' | 'text'>;
        return { agentId, seq: r.seq, at: r.at, kind, text };
      }),
      hasMore: rows.length > q.limit,
      lastSeq: this.transcripts?.lastSeq(agentId) ?? this.maxSeq(agentId),
    };
  }

  /** The newest persisted `seq` of an agent (no pipeline to ask). */
  maxSeq(agentId: Id): number {
    return (
      this.stmt(
        'SELECT COALESCE(MAX(seq), 0) AS seq FROM transcript_chunks WHERE agent_id = ?',
      ).get(agentId) as { seq: number }
    ).seq;
  }
}

function compare(a: Cursor, b: Cursor): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.src !== b.src) return a.src - b.src;
  return a.n - b.n;
}
