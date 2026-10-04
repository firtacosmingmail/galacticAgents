import { afterEach, describe, expect, it } from 'vitest';
import {
  HistoryQuestionsResponse,
  HistoryWorkDetail,
  HistoryWorkResponse,
  type Agent,
  type Event,
  type Project,
  type Question,
  type Task,
} from '@galactic/protocol';
import { openDatabase } from '../db/database.js';
import { EventLog } from '../domain/event-log.js';
import { moveTask } from '../domain/tasks.js';
import { DETAIL_QUESTIONS, HistoryView } from '../runtime/history-view.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/**
 * P5-03: the history's trails (closure, archive and reopen dates, moves, promotion links), the
 * holder chain of a past question, and `GET /api/history/work/:kind/:id` — one item inspected.
 */

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 4, 10, minute)).toISOString();
const caps = { maxWallClockMs: 60_000, maxToolCalls: 10 };

/** A log on a settable clock, with helpers that write rows and emit events at a given minute. */
async function detailApp() {
  let minute = 0;
  const db = openDatabase(':memory:');
  const log = new EventLog(db, { now: () => at(minute) });
  const when = (m: number, fn: () => void) => {
    minute = m;
    fn();
  };
  const emit = (m: number, ...events: Event[]) =>
    when(m, () => log.runCommand((ctx) => events.forEach((e) => ctx.emit(e))));
  log.tables.bodies.insert({ id: 'b-ast-7', kind: 'asteroid', name: 'Asteroid 7' });
  const project = (p: Partial<Project> & { id: string; name: string }) =>
    log.tables.projects.insert({
      workspace: `/tmp/${p.id}`,
      bodyId: 'b-mars',
      state: 'archived',
      createdAt: at(0),
      updatedAt: at(50),
      ...p,
    });
  const task = (t: Partial<Task> & { id: string; description: string }) =>
    log.tables.tasks.insert({
      bodyId: 'b-mars',
      priority: 'normal',
      blockedBy: [],
      state: 'completed',
      createdAt: at(0),
      updatedAt: at(40),
      ...t,
    });
  const agent = (a: Partial<Agent> & { id: string; role: Agent['role'] }) =>
    log.tables.agents.insert({
      runtime: 'fake',
      bodyId: 'b-mars',
      caps,
      createdAt: at(1),
      updatedAt: at(1),
      ...a,
    });
  const question = (q: Partial<Question> & { id: string; originAgentId: string }) =>
    log.tables.questions.insert({
      kind: 'clarification',
      holder: { type: 'user' },
      status: 'answered',
      context: { text: `question ${q.id}` },
      answeredBy: { type: 'user' },
      answer: `answer ${q.id}`,
      version: 2,
      createdAt: at(10),
      updatedAt: at(20),
      ...q,
    });
  const t = await startTestApp({ log });
  cleanups.push(() => t.stop());
  const get = async (path: string, token = TEST_TOKEN) => {
    const res = await fetch(`${t.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };
  return { log, t, get, when, emit, project, task, agent, question };
}

/**
 * An archived project on Mars that was promoted from a standalone task on an asteroid, closed,
 * reopened, closed again and archived; its Waykeeper and a Steward; a question the Steward asked
 * that went Waykeeper → Harmonizer → user and was answered by the user.
 */
async function archivedProject() {
  const app = await detailApp();
  const { emit, project, task, agent, question } = app;
  task({ id: 't-seed', description: 'a CSV exporter', bodyId: 'b-ast-7', state: 'moved' });
  project({
    id: 'p1',
    name: 'CSV tool',
    meta: { promotedFrom: { kind: 'task', taskId: 't-seed', bodyId: 'b-ast-7' } },
  });
  task({ id: 't1', description: 'write the parser', projectId: 'p1' });
  agent({ id: 'h1', role: 'harmonizer', bodyId: 'b-earth' });
  agent({ id: 'w1', role: 'waykeeper', projectId: 'p1', supervisorId: 'h1' });
  agent({
    id: 's1',
    role: 'steward',
    projectId: 'p1',
    taskId: 't1',
    supervisorId: 'w1',
    createdAt: at(2),
  });
  question({ id: 'q1', originAgentId: 's1', context: { text: 'Which delimiter?' } });
  emit(5, { type: 'project.state_changed', projectId: 'p1', from: 'approved', to: 'in_progress' });
  emit(11, {
    type: 'question.escalated',
    questionId: 'q1',
    from: { type: 'agent', id: 'w1' },
    to: { type: 'agent', id: 'h1' },
    version: 1,
  });
  emit(12, {
    type: 'question.escalated',
    questionId: 'q1',
    from: { type: 'agent', id: 'h1' },
    to: { type: 'user' },
    version: 2,
  });
  emit(20, {
    type: 'project.state_changed',
    projectId: 'p1',
    from: 'awaiting_closure',
    to: 'completed',
    by: { type: 'user' },
  });
  emit(25, {
    type: 'project.state_changed',
    projectId: 'p1',
    from: 'completed',
    to: 'approved',
    by: { type: 'user' },
  });
  emit(30, {
    type: 'project.state_changed',
    projectId: 'p1',
    from: 'awaiting_closure',
    to: 'completed',
    by: { type: 'user' },
  });
  emit(50, { type: 'project.state_changed', projectId: 'p1', from: 'completed', to: 'archived' });
  // Another project's events never leak into this one's trail.
  project({ id: 'p2', name: 'Other', state: 'completed' });
  emit(51, { type: 'project.state_changed', projectId: 'p2', from: 'approved', to: 'completed' });
  return app;
}

describe('history trails and holder chains (P5-03)', () => {
  it('gives each work row its body name, closure / archive / reopen dates and promotion link', async () => {
    const { get } = await archivedProject();
    const page = HistoryWorkResponse.parse((await get('/api/history/work?kind=project')).body);
    const p1 = page.items.find((i) => i.item.id === 'p1')!;
    expect(p1.bodyName).toBe('Mars');
    expect(p1.trail).toEqual({
      closedAt: at(30),
      archivedAt: at(50),
      reopenedAt: at(25),
      moves: [],
      promotedFrom: { kind: 'task', id: 't-seed', name: 'a CSV exporter' },
    });
    const p2 = page.items.find((i) => i.item.id === 'p2')!;
    expect(p2.trail).toEqual({ closedAt: at(51), moves: [] });
  });

  it('gives each past question its holder chain: asker’s supervisor, each escalation, the user', async () => {
    const { get, emit, question } = await archivedProject();
    // A question whose holder ended: reassigned, with the reason.
    question({ id: 'q2', originAgentId: 's1', holder: { type: 'agent', id: 'h1' } });
    emit(13, {
      type: 'question.reassigned',
      questionId: 'q2',
      from: { type: 'agent', id: 'w1' },
      to: { type: 'agent', id: 'h1' },
      reason: 'holder w1 ended',
      version: 1,
    });
    // One never escalated: its holder is its only step.
    question({ id: 'q3', originAgentId: 'w1', holder: { type: 'agent', id: 'h1' } });
    const page = HistoryQuestionsResponse.parse((await get('/api/history/questions')).body);
    const chain = (id: string) => page.items.find((i) => i.question.id === id)!.holders;
    expect(chain('q1')).toEqual([
      { holder: { type: 'agent', id: 'w1' }, at: at(10), via: 'asked' },
      { holder: { type: 'agent', id: 'h1' }, at: at(11), via: 'escalated' },
      { holder: { type: 'user' }, at: at(12), via: 'escalated' },
    ]);
    expect(page.items.find((i) => i.question.id === 'q1')!.question.answeredBy).toEqual({
      type: 'user',
    });
    expect(chain('q2')).toEqual([
      { holder: { type: 'agent', id: 'w1' }, at: at(10), via: 'asked' },
      {
        holder: { type: 'agent', id: 'h1' },
        at: at(13),
        via: 'reassigned',
        reason: 'holder w1 ended',
      },
    ]);
    expect(chain('q3')).toEqual([
      { holder: { type: 'agent', id: 'h1' }, at: at(10), via: 'asked' },
    ]);
  });

  it('records a standalone task joining a project once, with both bodies and the project', async () => {
    const { log, get, when, project, task, agent } = await detailApp();
    project({ id: 'p1', name: 'Site', state: 'in_progress' });
    agent({ id: 'h1', role: 'harmonizer', bodyId: 'b-earth' });
    agent({ id: 'w1', role: 'waykeeper', projectId: 'p1', supervisorId: 'h1' });
    log.tables.bodies.upsert({
      id: 'b-ast-7',
      kind: 'asteroid',
      name: 'Asteroid 7',
      host: { kind: 'task', id: 't1' },
    });
    task({ id: 't1', description: 'fix the footer', bodyId: 'b-ast-7', state: 'in_progress' });
    when(7, () => log.runCommand((ctx) => moveTask(ctx, 't1', 'p1', { type: 'user' })));
    const detail = HistoryWorkDetail.parse((await get('/api/history/work/task/t1')).body);
    expect(detail.trail.moves).toEqual([
      {
        at: at(7),
        fromBodyId: 'b-ast-7',
        fromBodyName: 'Asteroid 7',
        toBodyId: 'b-mars',
        toBodyName: 'Mars',
        intoProjectId: 'p1',
        intoProjectName: 'Site',
      },
    ]);
    expect(detail.project?.id).toBe('p1');
    // Still running: no closure date.
    expect(detail.trail.closedAt).toBeUndefined();
  });

  it('lists a moved task’s Steward among its new project’s agents (wave-1 review)', async () => {
    const { log, get, when, project, task, agent } = await detailApp();
    project({ id: 'p1', name: 'Site', state: 'in_progress' });
    agent({ id: 'h1', role: 'harmonizer', bodyId: 'b-earth' });
    agent({ id: 'w1', role: 'waykeeper', projectId: 'p1', supervisorId: 'h1', createdAt: at(3) });
    log.tables.bodies.upsert({
      id: 'b-ast-7',
      kind: 'asteroid',
      name: 'Asteroid 7',
      host: { kind: 'task', id: 't1' },
    });
    task({ id: 't1', description: 'fix the footer', bodyId: 'b-ast-7', state: 'in_progress' });
    // A Steward row from before the hand-over rules (no supervisor): the move leaves its
    // `project_id` empty, so only its task links it to the project.
    agent({ id: 's-old', role: 'steward', taskId: 't1', bodyId: 'b-ast-7', createdAt: at(2) });
    when(7, () => log.runCommand((ctx) => moveTask(ctx, 't1', 'p1', { type: 'user' })));
    expect(log.tables.agents.get('s-old')?.projectId).toBeUndefined();
    const d = HistoryWorkDetail.parse((await get('/api/history/work/project/p1')).body);
    expect(d.agents.map((a) => a.id)).toEqual(['s-old', 'w1']);
  });

  it('links a promoted task to the project it became', async () => {
    const { get } = await archivedProject();
    const detail = HistoryWorkDetail.parse((await get('/api/history/work/task/t-seed')).body);
    expect(detail.trail.promotedTo).toEqual({ kind: 'project', id: 'p1', name: 'CSV tool' });
    expect(detail.bodyName).toBe('Asteroid 7');
  });
});

describe('GET /api/history/work/:kind/:id (P5-03)', () => {
  it('inspects an archived project: states, tasks, agents, questions with holders', async () => {
    const { get, project } = await archivedProject();
    project({ id: 'p-sub', name: 'Docs moon', parentProjectId: 'p1', bodyId: 'b-phobos' });
    const res = await get('/api/history/work/project/p1');
    expect(res.status).toBe(200);
    const d = HistoryWorkDetail.parse(res.body);
    expect(d.work.kind).toBe('project');
    expect(d.work.kind === 'project' && d.work.item.name).toBe('CSV tool');
    expect(d.states.map((s) => `${s.to}@${s.at}`)).toEqual([
      `in_progress@${at(5)}`,
      `completed@${at(20)}`,
      `approved@${at(25)}`,
      `completed@${at(30)}`,
      `archived@${at(50)}`,
    ]);
    expect(d.states[1]!.by).toEqual({ type: 'user' });
    expect(d.trail.archivedAt).toBe(at(50));
    expect(d.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(d.subProjects.map((p) => p.id)).toEqual(['p-sub']);
    expect(d.agents.map((a) => a.id)).toEqual(['w1', 's1']);
    expect(d.questions.map((q) => q.question.id)).toEqual(['q1']);
    expect(d.questions[0]!.holders!.map((h) => h.holder)).toEqual([
      { type: 'agent', id: 'w1' },
      { type: 'agent', id: 'h1' },
      { type: 'user' },
    ]);
    expect(d.moreQuestions).toBe(false);
  });

  it('caps the questions at the newest ones and says there are more', async () => {
    const { get, question } = await archivedProject();
    for (let i = 0; i < DETAIL_QUESTIONS + 2; i++)
      question({ id: `qx${String(i).padStart(3, '0')}`, originAgentId: 'w1', updatedAt: at(30) });
    const d = HistoryWorkDetail.parse((await get('/api/history/work/project/p1')).body);
    expect(d.questions).toHaveLength(DETAIL_QUESTIONS);
    expect(d.moreQuestions).toBe(true);
  });

  it('answers 404 for unknown work, 400 for a bad kind, 401 without the token', async () => {
    const { get } = await archivedProject();
    expect((await get('/api/history/work/project/nope')).status).toBe(404);
    expect((await get('/api/history/work/task/p1')).status).toBe(404);
    expect((await get('/api/history/work/body/p1')).status).toBe(400);
    expect((await get('/api/history/work/project/p1', 'wrong')).status).toBe(401);
  });

  it('returns rows as the snapshot holds them (redaction parity)', async () => {
    const { get, log } = await archivedProject();
    const d = HistoryWorkDetail.parse((await get('/api/history/work/project/p1')).body);
    const snap = log.snapshot();
    expect(d.work.item).toEqual(snap.projects.find((p) => p.id === 'p1'));
    for (const q of d.questions)
      expect(q.question).toEqual(snap.questions.find((s) => s.id === q.question.id));
    for (const a of d.agents) expect(a).toEqual(snap.agents.find((s) => s.id === a.id));
  });
});

describe('history trail reads (P5-03)', () => {
  it('reads through indexes: migration 0009’s, by key, never a scan of events or a table', async () => {
    const { log } = await archivedProject();
    const view = new HistoryView(log.db, log.tables);
    view.work({ limit: 5 });
    view.questions({ limit: 5 });
    view.detail('project', 'p1');
    view.detail('task', 't1');
    view.detail('task', 't-seed');
    const sqls = [...(view as unknown as { stmts: Map<string, unknown> }).stmts.keys()].filter(
      (sql) => !/INDEXED BY \w+_history/.test(sql),
    );
    const plan = (sql: string) =>
      (
        log.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all(...(sql.match(/\?/g) ?? []).map(() => 'x')) as { detail: string }[]
      )
        .map((p) => p.detail)
        .join(' | ');
    const expected: [RegExp, RegExp][] = [
      [/coalesce/, /SEARCH events USING INDEX events_work_subject \(<expr>=\?\)/],
      [
        /question\.escalated/,
        /SEARCH events USING INDEX events_type_question \(type=\? AND <expr>=\?\)/,
      ],
      [
        /question\.cancelled/,
        /SEARCH events USING INDEX events_type_question \(type=\? AND <expr>=\?\)/,
      ],
      [/promotedFrom/, /SEARCH projects USING INDEX projects_promoted_from \(<expr>=\?\)/],
      [/FROM tasks WHERE project_id/, /SEARCH tasks USING INDEX tasks_project \(project_id=\?\)/],
      [/parent_project_id/, /SEARCH projects USING INDEX projects_parent \(parent_project_id=\?\)/],
      [/agents WHERE project_id/, /SEARCH agents USING INDEX agents_project \(project_id=\?\)/],
      [/agents WHERE task_id/, /SEARCH agents USING INDEX agents_task \(task_id=\?\)/],
      [/origin_agent_id/, /SEARCH questions USING INDEX questions_origin \(origin_agent_id=\?\)/],
    ];
    for (const [which, uses] of expected) {
      const sql = sqls.find((s) => which.test(s));
      expect(sql, String(which)).toBeDefined();
      const p = plan(sql!);
      expect(p, sql).toMatch(uses);
      expect(p, sql).not.toMatch(/SCAN (events|projects|tasks|agents|questions)\b/);
    }
  });
});
