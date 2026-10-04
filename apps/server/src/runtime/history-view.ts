import type { Database, Statement } from 'better-sqlite3';
import type { z } from 'zod';
import type {
  Agent,
  Event,
  HistoryMove,
  HistoryQuestion,
  HistoryQuestionsQuery,
  HistoryQuestionsResponse,
  HistoryStateStep,
  HistoryWorkDetail,
  HistoryWorkItem,
  HistoryWorkQuery,
  HistoryWorkRef,
  HistoryWorkResponse,
  HistoryWorkTrail,
  HolderStep,
  HostKind,
  Id,
  Project,
  Question,
  Task,
  WorkState,
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
 *
 * **Trails and holder chains (P5-03).** Each work row also carries the name of its body and its
 * trail — closure, archive and reopen dates, moves and promotion links — read from the log for
 * the whole page at once through migration 0009's `events_work_subject` (the work's own
 * `*.state_changed`, `task.updated` and `body.moved` events, keyed by the work they are about).
 * Each question carries its holder chain, read for the page through 0008's
 * `events_type_question`. The lifecycle read names its index (`INDEXED BY`): the planner would
 * rather take `events_type_question` for the `type IN` term and filter. A page's ids are bound as one JSON array
 * (`IN (SELECT value FROM json_each(?))`), so one statement serves every page size.
 * **Detail** (`detail(kind, id)`) is one item inspected: the same trail with every state change,
 * its project, tasks, sub-projects, agents and their questions, each read through an index.
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

/** Migration 0009's `events_work_subject`: its expression and its WHERE term, verbatim. */
const SUBJECT = `coalesce(json_extract(payload, '$.projectId'), json_extract(payload, '$.taskId'),
    json_extract(payload, '$.host.id'))`;
const SUBJECT_TYPES = `type IN ('project.state_changed', 'task.state_changed', 'task.updated', 'body.moved')`;

/** A list of ids bound as one JSON array parameter. */
const IDS = `(SELECT value FROM json_each(?))`;

/** The states in which work no longer runs (the domain's `FINISHED_WORK`). */
const FINISHED: ReadonlySet<WorkState> = new Set<WorkState>([
  'completed',
  'failed',
  'moved',
  'archived',
]);
/** The states that close work (the archive comes after). */
const CLOSED: ReadonlySet<WorkState> = new Set<WorkState>(['completed', 'failed', 'moved']);
const ARCHIVED: ReadonlySet<WorkState> = new Set<WorkState>(['archived']);

/** How many of an item's questions the detail returns, newest first. */
export const DETAIL_QUESTIONS = 50;

interface KeyRow {
  id: Id;
  updated_at: string;
}

interface LogRow {
  at: string;
  event: Event;
}

type Work = { kind: 'project'; item: Project } | { kind: 'task'; item: Task };

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
    const desc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
    rows.sort((a, b) => desc(a.updated_at, b.updated_at) || desc(a.k, b.k) || desc(a.id, b.id));
    const page: (Work & { cursor: string })[] = [];
    for (const row of rows.slice(0, q.limit)) {
      const cursorOf = encode({ at: row.updated_at, k: row.k, id: row.id });
      if (row.k === 'p') {
        const item = this.tables.projects.get(row.id);
        if (item) page.push({ kind: 'project', item, cursor: cursorOf });
      } else {
        const item = this.tables.tasks.get(row.id);
        if (item) page.push({ kind: 'task', item, cursor: cursorOf });
      }
    }
    const lifecycles = this.lifecycles(page.map((w) => w.item.id));
    const promoted = this.promotedInto(page.filter((w) => w.kind === 'task').map((w) => w.item.id));
    const items = page.map((w): HistoryWorkItem => {
      const bodyName = this.tables.bodies.get(w.item.bodyId)?.name;
      const trail = this.trail(w, lifecycles.get(w.item.id) ?? [], promoted.get(w.item.id));
      return { ...w, ...(bodyName ? { bodyName } : {}), trail };
    });
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
    const items = this.pastQuestions(rows.slice(0, q.limit).map((r) => r.id));
    return { items, hasMore: rows.length > q.limit };
  }

  /**
   * One project or task inspected from the history (P5-03), in any state (a moved-to link may
   * lead to live work); `undefined` when there is no such row.
   */
  detail(kind: HostKind, id: Id): HistoryWorkDetail | undefined {
    const work = this.workOf(kind, id);
    if (!work) return undefined;
    const events = this.lifecycles([id]).get(id) ?? [];
    const promoted = work.kind === 'task' ? this.promotedInto([id]).get(id) : undefined;
    const idsOf = (sql: string, arg: unknown) =>
      (this.stmt(sql).all(arg) as { id: Id }[]).map((r) => r.id);
    const rowsOf = <T>(ids: Id[], get: (id: Id) => T | undefined) =>
      ids.map(get).filter((x): x is T => x !== undefined);

    const parentId = work.kind === 'task' ? work.item.projectId : work.item.parentProjectId;
    const project = parentId ? this.tables.projects.get(parentId) : undefined;
    const tasks =
      work.kind === 'project'
        ? rowsOf(
            idsOf('SELECT id FROM tasks WHERE project_id = ? ORDER BY created_at, id', id),
            (t) => this.tables.tasks.get(t),
          )
        : [];
    const subProjects =
      work.kind === 'project'
        ? rowsOf(
            idsOf(
              'SELECT id FROM projects WHERE parent_project_id = ? ORDER BY created_at, id',
              id,
            ),
            (p) => this.tables.projects.get(p),
          )
        : [];
    const agents: Agent[] = rowsOf(
      idsOf(
        work.kind === 'project'
          ? 'SELECT id FROM agents WHERE project_id = ? ORDER BY created_at, id'
          : 'SELECT id FROM agents WHERE task_id = ? ORDER BY created_at, id',
        id,
      ),
      (a) => this.tables.agents.get(a),
    );
    const asked =
      agents.length === 0
        ? []
        : (
            this.stmt(
              `SELECT id FROM questions WHERE origin_agent_id IN ${IDS}
                ORDER BY updated_at DESC, id DESC LIMIT ?`,
            ).all(JSON.stringify(agents.map((a) => a.id)), DETAIL_QUESTIONS + 1) as { id: Id }[]
          ).map((r) => r.id);
    const bodyName = this.tables.bodies.get(work.item.bodyId)?.name;
    return {
      work,
      ...(bodyName ? { bodyName } : {}),
      trail: this.trail(work, events, promoted),
      states: HistoryView.states(work, events),
      ...(project ? { project } : {}),
      tasks,
      subProjects,
      agents,
      questions: this.pastQuestions(asked.slice(0, DETAIL_QUESTIONS)),
      moreQuestions: asked.length > DETAIL_QUESTIONS,
    };
  }

  private workOf(kind: HostKind, id: Id): Work | undefined {
    if (kind === 'project') {
      const item = this.tables.projects.get(id);
      return item ? { kind, item } : undefined;
    }
    const item = this.tables.tasks.get(id);
    return item ? { kind, item } : undefined;
  }

  /** These questions as the history shows them: with the cancel reason and the holder chain. */
  private pastQuestions(ids: Id[]): HistoryQuestion[] {
    const questions = ids
      .map((id) => this.tables.questions.get(id))
      .filter((q): q is Question => q !== undefined);
    const reasons = this.cancelReasons(questions.map((q) => q.id));
    const chains = this.holderChains(questions);
    return questions.map((question) => {
      const reason = question.status === 'cancelled' ? reasons.get(question.id) : undefined;
      return {
        question,
        ...(reason ? { reason } : {}),
        cursor: encode({ at: question.updatedAt, k: 'q', id: question.id }),
        holders: chains.get(question.id) ?? [],
      };
    });
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
          AND json_extract(payload, '$.questionId') IN ${IDS}
        ORDER BY id`,
    ).all(JSON.stringify(ids)) as { id: Id; reason: string | null }[];
    const out = new Map<Id, string>();
    for (const r of rows) if (r.reason) out.set(r.id, r.reason);
    return out;
  }

  /**
   * Who held each question, in order (P5-03): the holder it was routed to when asked, then one
   * step per `question.escalated` / `question.reassigned`. Each of those names the holder before
   * it (`from`), so the first one's `from` is the first holder; with none, the row's holder is.
   * One read for all of them, by (`type`, `questionId`) through `events_type_question`.
   */
  private holderChains(questions: Question[]): Map<Id, HolderStep[]> {
    const out = new Map<Id, HolderStep[]>();
    if (questions.length === 0) return out;
    const rows = this.stmt(
      `SELECT id, at, payload FROM events
        WHERE type IN ('question.escalated', 'question.reassigned')
          AND json_extract(payload, '$.questionId') IN ${IDS}`,
    ).all(JSON.stringify(questions.map((q) => q.id))) as {
      id: number;
      at: string;
      payload: string;
    }[];
    rows.sort((a, b) => a.id - b.id);
    const steps = new Map<Id, HolderStep[]>();
    const firsts = new Map<Id, HolderStep['holder']>();
    for (const r of rows) {
      const event = JSON.parse(r.payload) as Event;
      if (event.type !== 'question.escalated' && event.type !== 'question.reassigned') continue;
      const list = steps.get(event.questionId) ?? [];
      if (list.length === 0) firsts.set(event.questionId, event.from);
      list.push(
        event.type === 'question.escalated'
          ? { holder: event.to, at: r.at, via: 'escalated' }
          : { holder: event.to, at: r.at, via: 'reassigned', reason: event.reason },
      );
      steps.set(event.questionId, list);
    }
    for (const q of questions) {
      out.set(q.id, [
        { holder: firsts.get(q.id) ?? q.holder, at: q.createdAt, via: 'asked' },
        ...(steps.get(q.id) ?? []),
      ]);
    }
    return out;
  }

  /**
   * The lifecycle events of these projects and tasks — their state changes, moves and a task's
   * updates — oldest first, by the id they are about (migration 0009's `events_work_subject`).
   */
  private lifecycles(ids: Id[]): Map<Id, LogRow[]> {
    const out = new Map<Id, LogRow[]>();
    if (ids.length === 0) return out;
    const rows = this.stmt(
      `SELECT id, at, payload, ${SUBJECT} AS subject FROM events INDEXED BY events_work_subject
        WHERE ${SUBJECT_TYPES} AND ${SUBJECT} IN ${IDS}`,
    ).all(JSON.stringify(ids)) as { id: number; at: string; payload: string; subject: Id }[];
    rows.sort((a, b) => a.id - b.id);
    for (const r of rows) {
      const list = out.get(r.subject) ?? [];
      list.push({ at: r.at, event: JSON.parse(r.payload) as Event });
      out.set(r.subject, list);
    }
    return out;
  }

  /** The project each of these tasks was promoted into (`meta.promotedFrom.taskId`), the first. */
  private promotedInto(taskIds: Id[]): Map<Id, HistoryWorkRef> {
    const out = new Map<Id, HistoryWorkRef>();
    if (taskIds.length === 0) return out;
    const rows = this.stmt(
      `SELECT id, name, created_at, json_extract(meta, '$.promotedFrom.taskId') AS taskId
         FROM projects WHERE json_extract(meta, '$.promotedFrom.taskId') IN ${IDS}`,
    ).all(JSON.stringify(taskIds)) as { id: Id; name: string; created_at: string; taskId: Id }[];
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    for (const r of rows)
      if (!out.has(r.taskId)) out.set(r.taskId, { kind: 'project', id: r.id, name: r.name });
    return out;
  }

  /** The state changes of a piece of work, oldest first, from its lifecycle events. */
  private static states(work: Work, events: LogRow[]): HistoryStateStep[] {
    const steps: HistoryStateStep[] = [];
    for (const { at, event } of events) {
      if (
        (work.kind === 'project' && event.type === 'project.state_changed') ||
        (work.kind === 'task' && event.type === 'task.state_changed')
      ) {
        steps.push({ at, from: event.from, to: event.to, ...(event.by ? { by: event.by } : {}) });
      }
    }
    return steps;
  }

  /** A piece of work's trail: its dates, its moves and its promotion links. */
  private trail(
    work: Work,
    events: LogRow[],
    promotedTo: HistoryWorkRef | undefined,
  ): HistoryWorkTrail {
    const { item } = work;
    const states = HistoryView.states(work, events);
    const last = (ok: (s: HistoryStateStep) => boolean) => states.filter(ok).at(-1)?.at;
    const closedAt = FINISHED.has(item.state) ? last((s) => CLOSED.has(s.to)) : undefined;
    const archivedAt = item.state === 'archived' ? last((s) => ARCHIVED.has(s.to)) : undefined;
    const reopenedAt = last((s) => FINISHED.has(s.from) && !FINISHED.has(s.to));

    const moves: HistoryMove[] = [];
    for (const { at, event } of events) {
      if (event.type === 'body.moved' && event.host.kind === work.kind) {
        // A standalone task joining a project also has a `task.updated` in the same command.
        const twin = moves.findIndex(
          (m) =>
            m.fromBodyId === undefined && m.at === at && m.intoProjectId === event.intoProjectId,
        );
        if (twin >= 0) moves.splice(twin, 1);
        moves.push({
          at,
          fromBodyId: event.fromBodyId,
          toBodyId: event.toBodyId,
          ...(event.intoProjectId ? { intoProjectId: event.intoProjectId } : {}),
        });
      } else if (
        event.type === 'task.updated' &&
        work.kind === 'task' &&
        typeof event.changes.projectId === 'string'
      ) {
        const into = event.changes.projectId;
        if (moves.some((m) => m.at === at && m.intoProjectId === into)) continue;
        moves.push({
          at,
          intoProjectId: into,
          ...(event.changes.bodyId ? { toBodyId: event.changes.bodyId } : {}),
        });
      }
    }

    const from = item.meta?.['promotedFrom'] as { taskId?: unknown } | undefined;
    const fromTask =
      work.kind === 'project' && typeof from?.taskId === 'string'
        ? this.tables.tasks.get(from.taskId)
        : undefined;
    return {
      ...(closedAt ? { closedAt } : {}),
      ...(archivedAt ? { archivedAt } : {}),
      ...(reopenedAt ? { reopenedAt } : {}),
      moves: moves.map((m) => this.named(m)),
      ...(promotedTo ? { promotedTo } : {}),
      ...(fromTask
        ? { promotedFrom: { kind: 'task' as const, id: fromTask.id, name: fromTask.description } }
        : {}),
    };
  }

  /** A move with the names of its bodies and project, as they are now. */
  private named(m: HistoryMove): HistoryMove {
    const fromBodyName = m.fromBodyId ? this.tables.bodies.get(m.fromBodyId)?.name : undefined;
    const toBodyName = m.toBodyId ? this.tables.bodies.get(m.toBodyId)?.name : undefined;
    const intoProjectName = m.intoProjectId
      ? this.tables.projects.get(m.intoProjectId)?.name
      : undefined;
    return {
      ...m,
      ...(fromBodyName ? { fromBodyName } : {}),
      ...(toBodyName ? { toBodyName } : {}),
      ...(intoProjectName ? { intoProjectName } : {}),
    };
  }
}
