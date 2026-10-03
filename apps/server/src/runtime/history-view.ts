import type { Database, Statement } from 'better-sqlite3';
import type { z } from 'zod';
import type {
  HistoryQuestion,
  HistoryQuestionsQuery,
  HistoryQuestionsResponse,
  HistoryWorkItem,
  HistoryWorkQuery,
  HistoryWorkResponse,
  Id,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { CursorError } from './cursor-error.js';

/**
 * The history view's reads (P25-10; SPEC §4.2 "a history view of archived work and past
 * questions"): finished and archived projects and tasks, and answered and cancelled questions,
 * newest first by (`updated_at`, `id`), searched by text and paged back by an opaque cursor.
 *
 * Each list is read through a partial index of migration 0008 that holds exactly its rows in that
 * order (`… WHERE state IN ('completed', 'failed', 'archived')`, `… WHERE status IN ('answered',
 * 'cancelled')`); the queries repeat those terms verbatim so SQLite can use the index, and bound
 * the cursor with row values, so a page without a search reads only its rows. A search
 * (`LIKE`, case-insensitive for ASCII) walks the same index until the page is full. The queries
 * name it (`INDEXED BY`): without statistics the planner would rather take `questions_status`
 * for the `status IN` term and sort, and a query that can no longer use the index fails loudly
 * instead of turning into a scan. The extra filters are written `+column` for the same reason.
 *
 * **Work** merges two tables: projects and tasks are each read up to `limit + 1` rows past the
 * cursor and merged by (`updated_at`, kind `t` before `p` at the same instant, `id`), all
 * descending; the position is the cursor: `<updatedAt>~p<id>` or `<updatedAt>~t<id>`.
 * **Questions**: `<updatedAt>~q<id>`.
 *
 * Rows are returned as the domain tables (and so the stream's snapshot) hold them: agent text was
 * redacted when it was logged (a question's text, its tool call; TECHNOLOGY §8), user-written text
 * (an answer) is not — the same as the stream and the conversation endpoint.
 */

interface Cursor {
  at: string;
  k: 'p' | 't' | 'q';
  id: Id;
}

const encode = (c: Cursor) => `${c.at}~${c.k}${c.id}`;

/** The cursor a client sent back, or `undefined` when it is not one of ours. */
export function decodeHistoryCursor(raw: string): Cursor | undefined {
  const m = /^([^~]+)~([ptq])(.+)$/.exec(raw);
  if (!m || Number.isNaN(Date.parse(m[1]!))) return undefined;
  return { at: m[1]!, k: m[2] as Cursor['k'], id: m[3]! };
}

/** `%` and `_` (and the escape itself) taken literally in a `LIKE … ESCAPE '\'` pattern. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const WORK_STATES = `state IN ('completed', 'failed', 'archived')`;
const QUESTION_STATUSES = `status IN ('answered', 'cancelled')`;

interface KeyRow {
  id: Id;
  updated_at: string;
}

/** A parsed `GET /api/history/work` query. */
export type WorkHistoryQuery = z.output<typeof HistoryWorkQuery>;
/** A parsed `GET /api/history/questions` query. */
export type QuestionHistoryQuery = z.output<typeof HistoryQuestionsQuery>;

export class HistoryView {
  private readonly stmts = new Map<string, Statement>();

  constructor(
    private readonly db: Database,
    private readonly tables: Tables,
  ) {}

  private stmt(sql: string): Statement {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  private cursor(raw: string | undefined, kinds: Cursor['k'][]): Cursor | undefined {
    if (raw === undefined) return undefined;
    const c = decodeHistoryCursor(raw);
    if (!c || !kinds.includes(c.k)) throw new CursorError(`not a history cursor: ${raw}`);
    return c;
  }

  /** The keys of one table's history rows past `cursor`, newest first, at most `take`. */
  private keys(
    table: 'projects' | 'tasks' | 'questions',
    k: Cursor['k'],
    cursor: Cursor | undefined,
    filters: { sql: string; args: unknown[] }[],
    take: number,
  ): KeyRow[] {
    const where = [table === 'questions' ? QUESTION_STATUSES : WORK_STATES];
    const args: unknown[] = [];
    if (cursor) {
      // Same table: strictly older in (at, id). The other table of a merge sorts by its kind
      // letter at the same instant (`t` > `p`): a `t` cursor takes the projects at its instant
      // too, a `p` cursor none of the tasks there.
      if (cursor.k === k) {
        where.push('(updated_at, id) < (?, ?)');
        args.push(cursor.at, cursor.id);
      } else {
        where.push(`updated_at ${k < cursor.k ? '<=' : '<'} ?`);
        args.push(cursor.at);
      }
    }
    for (const f of filters) {
      where.push(f.sql);
      args.push(...f.args);
    }
    return this.stmt(
      `SELECT id, updated_at FROM ${table} INDEXED BY ${table}_history WHERE ${where.join(' AND ')}
        ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...args, take) as KeyRow[];
  }

  work(q: WorkHistoryQuery): HistoryWorkResponse {
    const cursor = this.cursor(q.before, ['p', 't']);
    const take = q.limit + 1;
    const states = q.state ? [...new Set(q.state)] : undefined;
    const filters = (textColumn: string) => [
      ...(states ? [{ sql: `+state IN (${states.map(() => '?').join(', ')})`, args: states }] : []),
      ...(q.q ? [{ sql: `${textColumn} LIKE ? ESCAPE '\\'`, args: [likePattern(q.q)] }] : []),
    ];
    const rows: (KeyRow & { k: 'p' | 't' })[] = [
      ...(q.kind === 'task'
        ? []
        : this.keys('projects', 'p', cursor, filters('name'), take).map((r) => ({
            ...r,
            k: 'p' as const,
          }))),
      ...(q.kind === 'project'
        ? []
        : this.keys('tasks', 't', cursor, filters('description'), take).map((r) => ({
            ...r,
            k: 't' as const,
          }))),
    ];
    // Newest first: (updated_at, k, id) descending, the order the cursor encodes.
    const desc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
    rows.sort((a, b) => desc(a.updated_at, b.updated_at) || desc(a.k, b.k) || desc(a.id, b.id));
    const items: HistoryWorkItem[] = [];
    for (const row of rows.slice(0, q.limit)) {
      const cursorOf = encode({ at: row.updated_at, k: row.k, id: row.id });
      if (row.k === 'p') {
        const item = this.tables.projects.get(row.id);
        if (item) items.push({ kind: 'project', item, cursor: cursorOf });
      } else {
        const item = this.tables.tasks.get(row.id);
        if (item) items.push({ kind: 'task', item, cursor: cursorOf });
      }
    }
    return { items, hasMore: rows.length > q.limit };
  }

  questions(q: QuestionHistoryQuery): HistoryQuestionsResponse {
    const cursor = this.cursor(q.before, ['q']);
    const filters: { sql: string; args: unknown[] }[] = [];
    if (q.kind) filters.push({ sql: '+kind = ?', args: [q.kind] });
    if (q.status) filters.push({ sql: '+status = ?', args: [q.status] });
    if (q.q) {
      const pattern = likePattern(q.q);
      filters.push({
        sql: `(json_extract(context, '$.text') LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\')`,
        args: [pattern, pattern],
      });
    }
    const rows = this.keys('questions', 'q', cursor, filters, q.limit + 1);
    const page = rows.slice(0, q.limit);
    const reasons = this.cancelReasons(page.map((r) => r.id));
    const items: HistoryQuestion[] = [];
    for (const row of page) {
      const question = this.tables.questions.get(row.id);
      if (!question) continue;
      const reason = question.status === 'cancelled' ? reasons.get(row.id) : undefined;
      items.push({
        question,
        ...(reason ? { reason } : {}),
        cursor: encode({ at: row.updated_at, k: 'q', id: row.id }),
      });
    }
    return { items, hasMore: rows.length > q.limit };
  }

  /**
   * Why each of these questions was cancelled: the `reason` of its latest `question.cancelled`
   * (the row does not keep it). One read through migration 0008's `events_type_question`: a
   * lookup per id of the page, not a walk of every `question.cancelled` in the log.
   */
  private cancelReasons(ids: Id[]): Map<Id, string> {
    if (ids.length === 0) return new Map();
    const rows = this.stmt(
      `SELECT json_extract(payload, '$.questionId') AS id, json_extract(payload, '$.reason') AS reason
         FROM events WHERE type = 'question.cancelled'
          AND json_extract(payload, '$.questionId') IN (${ids.map(() => '?').join(', ')})
        ORDER BY id`,
    ).all(...ids) as { id: Id; reason: string | null }[];
    const out = new Map<Id, string>();
    for (const r of rows) if (r.reason) out.set(r.id, r.reason);
    return out;
  }
}
