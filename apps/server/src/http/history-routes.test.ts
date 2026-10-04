import { afterEach, describe, expect, it } from 'vitest';
import {
  HistoryQuestionsResponse,
  HistoryWorkResponse,
  type Project,
  type Question,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { EventLog } from '../domain/event-log.js';
import { CursorError } from '../runtime/cursor-error.js';
import { HistoryView } from '../runtime/history-view.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

type TestApp = Awaited<ReturnType<typeof startTestApp>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const get = async (t: TestApp, path: string, headers: Record<string, string> = {}) => {
  const res = await fetch(`${t.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 10, minute)).toISOString();

/** A log with a Harmonizer and a Steward, and helpers that write history rows straight to the tables. */
async function historyApp() {
  const db = openDatabase(':memory:');
  const log = new EventLog(db);
  for (const [id, role] of [
    ['h1', 'harmonizer'],
    ['s1', 'steward'],
  ] as const) {
    log.runCommand((ctx) =>
      createAgent(ctx, {
        agentId: id,
        role,
        runtime: 'fake',
        caps: { maxWallClockMs: 60_000, maxToolCalls: 10 },
      }),
    );
  }
  const project = (id: string, name: string, state: WorkState, minute: number, extra = {}) =>
    log.tables.projects.insert({
      id,
      name,
      workspace: `/tmp/${id}`,
      bodyId: 'b-mars',
      state,
      createdAt: at(0),
      updatedAt: at(minute),
      ...extra,
    } satisfies Project);
  const task = (id: string, description: string, state: WorkState, minute: number, extra = {}) =>
    log.tables.tasks.insert({
      id,
      description,
      bodyId: 'b-mars',
      priority: 'normal',
      blockedBy: [],
      state,
      createdAt: at(0),
      updatedAt: at(minute),
      ...extra,
    } satisfies Task);
  const question = (id: string, minute: number, over: Partial<Question> = {}) =>
    log.tables.questions.insert({
      id,
      kind: 'clarification',
      originAgentId: 's1',
      holder: { type: 'user' },
      status: 'answered',
      context: { text: `question ${id}` },
      answeredBy: { type: 'user' },
      answer: `answer ${id}`,
      version: 1,
      createdAt: at(0),
      updatedAt: at(minute),
      ...over,
    } satisfies Question);
  const t = await startTestApp({ log });
  cleanups.push(() => t.stop());
  return { t, log, project, task, question };
}

/** Pages through a list with `before` until `hasMore` is false; every id once. */
async function pageAll(
  t: TestApp,
  path: string,
  limit: number,
): Promise<{ ids: string[]; pages: number }> {
  const ids: string[] = [];
  let before: string | undefined;
  let pages = 0;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${path}${sep}limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const { status, body } = await get(t, url);
    expect(status).toBe(200);
    pages++;
    const items = body['items'] as {
      cursor: string;
      item?: { id: string };
      question?: { id: string };
    }[];
    ids.push(...items.map((i) => (i.item ?? i.question)!.id));
    if (!body['hasMore']) break;
    before = items.at(-1)!.cursor;
    expect(pages).toBeLessThan(50);
  }
  return { ids, pages };
}

describe('GET /api/history/work (P25-10)', () => {
  it('lists finished and archived projects and tasks newest first, never open work', async () => {
    const { t, project, task } = await historyApp();
    project('p-open', 'Running project', 'in_progress', 9);
    project('p-done', 'CSV tool', 'completed', 3);
    project('p-arch', 'Old site', 'archived', 1, { pinned: false });
    task('t-open', 'still going', 'in_progress', 8);
    task('t-fail', 'fix the parser', 'failed', 4, { projectId: 'p-done' });
    task('t-arch', 'rename the repo', 'archived', 2);
    const page = HistoryWorkResponse.parse((await get(t, '/api/history/work')).body);
    expect(page.items.map((i) => `${i.kind}:${i.item.id}`)).toEqual([
      'task:t-fail',
      'project:p-done',
      'task:t-arch',
      'project:p-arch',
    ]);
    expect(page.hasMore).toBe(false);
    const fail = page.items[0]!;
    expect(fail.kind === 'task' && fail.item.projectId).toBe('p-done');
  });

  it('pages back without gaps or duplicates, across ties of the two tables at one instant', async () => {
    const { t, project, task } = await historyApp();
    const expected: string[] = [];
    // Five instants, each with two projects and two tasks: ties inside a table and across both.
    for (let m = 5; m >= 1; m--) {
      for (const n of [2, 1]) task(`t${m}-${n}`, `task ${m}.${n}`, 'completed', m);
      for (const n of [2, 1]) project(`p${m}-${n}`, `project ${m}.${n}`, 'archived', m);
      expected.push(`t${m}-2`, `t${m}-1`, `p${m}-2`, `p${m}-1`);
    }
    for (const limit of [1, 2, 3, 7, 50]) {
      const { ids } = await pageAll(t, '/api/history/work', limit);
      expect(ids, `limit ${limit}`).toEqual(expected);
    }
  });

  it('searches names and descriptions, filters by kind and state', async () => {
    const { t, project, task } = await historyApp();
    project('p1', 'Parser rewrite', 'completed', 5);
    project('p2', 'Docs site', 'archived', 4);
    task('t1', 'write the PARSER tests', 'archived', 3);
    task('t2', 'deploy 100%_done', 'failed', 2);
    const ids = async (qs: string) =>
      HistoryWorkResponse.parse((await get(t, `/api/history/work?${qs}`)).body).items.map(
        (i) => i.item.id,
      );
    expect(await ids('q=parser')).toEqual(['p1', 't1']);
    expect(await ids('q=parser&kind=task')).toEqual(['t1']);
    expect(await ids('state=archived')).toEqual(['p2', 't1']);
    expect(await ids('state=completed,failed&kind=task')).toEqual(['t2']);
    // `%` and `_` are literal, not wildcards.
    expect(await ids(`q=${encodeURIComponent('0%_d')}`)).toEqual(['t2']);
    expect(await ids(`q=${encodeURIComponent('%')}`)).toEqual(['t2']);
    expect(await ids('q=nothing-like-it')).toEqual([]);
  });

  it('refuses a malformed query or cursor, and needs the token', async () => {
    const { t } = await historyApp();
    expect((await get(t, '/api/history/work?state=in_progress')).status).toBe(400);
    expect((await get(t, '/api/history/work?limit=0')).status).toBe(400);
    const bad = await get(t, '/api/history/work?before=nonsense');
    expect(bad.status).toBe(400);
    expect(bad.body['error']).toBe('invalid_query');
    // A question cursor is not a work cursor.
    expect(
      (await get(t, `/api/history/work?before=${encodeURIComponent(`${at(1)}~qq1`)}`)).status,
    ).toBe(400);
    for (const path of ['/api/history/work', '/api/history/questions']) {
      expect((await get(t, path, { authorization: 'Bearer nope' })).status).toBe(401);
      const res = await fetch(`${t.baseUrl}${path}`);
      expect(res.status).toBe(401);
    }
  });
});

describe('GET /api/history/questions (P25-10)', () => {
  it('lists answered and cancelled questions newest first with who answered and why cancelled', async () => {
    const { t, log, question } = await historyApp();
    question('q-open', 9, { status: 'open', answeredBy: undefined, answer: undefined });
    question('q-user', 3);
    question('q-sup', 5, { answeredBy: { type: 'agent', id: 'h1' }, answer: 'use CSV' });
    question('q-gone', 4, { status: 'cancelled', answeredBy: undefined, answer: undefined });
    log.runCommand((ctx) =>
      ctx.emit({
        type: 'question.cancelled',
        questionId: 'q-gone',
        agentId: 's1',
        reason: 'no longer needed',
        version: 1,
      }),
    );
    const page = HistoryQuestionsResponse.parse((await get(t, '/api/history/questions')).body);
    expect(page.items.map((i) => i.question.id)).toEqual(['q-sup', 'q-gone', 'q-user']);
    expect(page.items[0]!.question.answeredBy).toEqual({ type: 'agent', id: 'h1' });
    expect(page.items[0]!.question.answer).toBe('use CSV');
    expect(page.items[1]!.reason).toBe('no longer needed');
    expect(page.items[2]!.reason).toBeUndefined();
    // Redaction parity: each question is exactly the row the stream's snapshot carries.
    const snapshot = log.snapshot().questions;
    for (const { question: q } of page.items)
      expect(q).toEqual(snapshot.find((s) => s.id === q.id));
  });

  it('pages back without gaps or duplicates, ties included', async () => {
    const { t, question } = await historyApp();
    const expected: string[] = [];
    for (let m = 6; m >= 1; m--) {
      for (const n of [3, 2, 1]) question(`q${m}-${n}`, m);
      expected.push(`q${m}-3`, `q${m}-2`, `q${m}-1`);
    }
    for (const limit of [1, 2, 4, 5, 200]) {
      const { ids } = await pageAll(t, '/api/history/questions', limit);
      expect(ids, `limit ${limit}`).toEqual(expected);
    }
  });

  it('searches the question and its answer, filters by kind and status', async () => {
    const { t, question } = await historyApp();
    question('q1', 4, { context: { text: 'Which date format?' }, answer: 'ISO' });
    question('q2', 3, {
      kind: 'permission',
      context: { text: 'Run npm install?' },
      answer: 'allow',
    });
    question('q3', 2, {
      status: 'cancelled',
      context: { text: 'Which FORMAT for logs?' },
      answeredBy: undefined,
      answer: undefined,
    });
    const ids = async (qs: string) =>
      HistoryQuestionsResponse.parse((await get(t, `/api/history/questions?${qs}`)).body).items.map(
        (i) => i.question.id,
      );
    expect(await ids('q=format')).toEqual(['q1', 'q3']);
    expect(await ids('q=iso')).toEqual(['q1']); // the answer
    expect(await ids('kind=permission')).toEqual(['q2']);
    expect(await ids('status=cancelled')).toEqual(['q3']);
    expect(await ids('q=format&status=answered')).toEqual(['q1']);
    expect((await get(t, '/api/history/questions?status=open')).status).toBe(400);
    expect(
      (await get(t, `/api/history/questions?before=${encodeURIComponent(`${at(1)}~pp1`)}`)).status,
    ).toBe(400);
  });
});

describe('history reads (P25-10)', () => {
  it('reads each page through migration 0008’s partial indexes: no sort, no table scan', async () => {
    const { log, project, task, question } = await historyApp();
    project('p1', 'a', 'completed', 2);
    task('t1', 'b', 'archived', 1);
    question('q1', 1);
    const view = new HistoryView(log.db, log.tables);
    const work = view.work({ limit: 1 });
    const qs = view.questions({ limit: 1 });
    for (const before of [work.items[0]!.cursor, `${at(1)}~p p`]) {
      view.work({ before, limit: 5 });
      view.work({ before, limit: 5, q: 'x', kind: 'task', state: ['archived', 'failed'] });
    }
    view.questions({ before: qs.items[0]!.cursor, limit: 5, q: 'x', kind: 'permission' });
    view.questions({ limit: 5, status: 'answered' });
    const sqls = [...(view as unknown as { stmts: Map<string, unknown> }).stmts.keys()].filter(
      (sql) => /INDEXED BY \w+_history/.test(sql),
    );
    expect(sqls.length).toBeGreaterThanOrEqual(8);
    for (const sql of sqls) {
      const params = (sql.match(/\?/g) ?? []).map(() => 'x');
      const plan = (
        log.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
      )
        .map((p) => p.detail)
        .join(' | ');
      expect(plan, sql).not.toMatch(/TEMP B-TREE/);
      expect(plan, sql).toMatch(/USING INDEX (projects_history|tasks_history|questions_history)/);
      // The page size is bound, so one statement serves every limit.
      expect(sql).toMatch(/LIMIT \?$/);
    }
    // A cancelled question's reason: a lookup by (type, questionId), not a walk of the type range.
    const reasons = [...(view as unknown as { stmts: Map<string, unknown> }).stmts.keys()].filter(
      (sql) => sql.includes('question.cancelled'),
    );
    expect(reasons.length).toBeGreaterThanOrEqual(1);
    for (const sql of reasons) {
      const params = (sql.match(/\?/g) ?? []).map(() => 'x');
      const plan = (
        log.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]
      )
        .map((p) => p.detail)
        .join(' | ');
      expect(plan, sql).toMatch(
        /SEARCH events USING INDEX events_type_question \(type=\? AND <expr>=\?\)/,
      );
      expect(plan, sql).not.toMatch(/SCAN events/);
    }
  });

  it('refuses a foreign cursor with a CursorError (the routes map only that to 400)', async () => {
    const { log } = await historyApp();
    const view = new HistoryView(log.db, log.tables);
    expect(() => view.work({ before: 'nope', limit: 1 })).toThrow(CursorError);
    expect(() => view.questions({ before: `${at(1)}~pp1`, limit: 1 })).toThrow(CursorError);
  });
});
