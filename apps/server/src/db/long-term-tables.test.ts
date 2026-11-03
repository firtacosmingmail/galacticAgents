import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { EventLog } from '../domain/event-log.js';
import { openDatabase } from './database.js';
import { loadMigrations, migrate } from './migrate.js';
import { tables, type Tables } from './tables.js';

/** The rows an area, a job and a run hang from: a project on Luna, the job's hidden task. */
function seed(t: Tables): void {
  t.bodies.insert(fx.body);
  t.bodies.insert(fx.moon);
  t.projects.insert(fx.project);
  t.tasks.insert(fx.task);
  t.tasks.insert({ ...fx.task, id: 't-job-1', meta: { jobId: 'j-1' } });
  t.agents.insert({ ...fx.agent, supervisorId: undefined });
}

const spendQuestion: Question = {
  ...fx.question,
  id: 'q-spend',
  kind: 'spend',
  holder: { type: 'user' },
  context: {
    text: 'Buy 100 email credits?',
    spend: { amount: 12.5, currency: 'USD', purpose: 'Email credits', jobId: 'j-1' },
  },
};

const indexNames = (db: Database): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe('long-term tables (P10-01)', () => {
  it('round-trips an area, a job and a job run', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    t.areas.insert(fx.area);
    t.jobs.insert(fx.job);
    t.jobRuns.insert(fx.jobRun);
    const followUps = [
      { questionId: 'q-1', kind: 'send' as const, text: 'Thanks, fixed in 1.2.' },
      { questionId: 'q-2', kind: 'spend' as const, amount: 5, currency: 'EUR', purpose: 'Ads' },
    ];
    const weekly = {
      ...fx.job,
      id: 'j-2',
      schedule: { kind: 'weekly' as const, days: [1, 3, 5], at: '07:30' },
      state: 'paused' as const,
      pausedReason: 'The API key expired.',
      failureQuestionId: 'q-1',
      runningRunId: 'jr-2',
      followUps,
      meta: { note: 'x' },
    };
    t.jobs.insert(weekly);
    const ended = {
      ...fx.jobRun,
      id: 'jr-3',
      endedAt: '2026-10-01T09:10:00.000Z',
      outcome: 'findings' as const,
      summary: 'Two suggestions.',
      numbers: { messages: 14, complaints: 2 },
      followUp: followUps[0],
      note: 'The key is renewed.',
    };
    t.jobRuns.insert(ended);

    expect(t.areas.get('ar-1')).toEqual(fx.area);
    expect(t.jobs.get('j-1')).toEqual(fx.job);
    expect(t.jobs.get('j-2')).toEqual(weekly);
    expect(t.jobRuns.get('jr-2')).toEqual(fx.jobRun);
    expect(t.jobRuns.get('jr-3')).toEqual(ended);
    expect(t.jobs.all().map((j) => j.id)).toEqual(['j-1', 'j-2']);
  });

  it('refuses a job in an unknown state and an area on an unknown body', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    expect(() => t.areas.insert({ ...fx.area, bodyId: 'b-nowhere' })).toThrow(/FOREIGN KEY/);
    t.areas.insert(fx.area);
    expect(() => t.jobs.insert({ ...fx.job, state: 'sleeping' as never })).toThrow();
  });

  it('stores a spend question and a body hosting areas', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    t.questions.insert(spendQuestion);
    expect(t.questions.get('q-spend')).toEqual(spendQuestion);
    const titan = t.bodies.get('b-titan')!;
    t.bodies.upsert({ ...titan, host: { kind: 'areas', id: 'p-1' } });
    expect(t.bodies.get('b-titan')?.host).toEqual({ kind: 'areas', id: 'p-1' });
  });

  it('round-trips a long-term project', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    const longTerm = {
      ...fx.project,
      id: 'p-lt',
      longTerm: true,
      purpose: 'Run my app as a small business.',
      goals: ['100 paying users', 'Answer every review within a day'],
    };
    t.projects.insert(longTerm);
    expect(t.projects.get('p-lt')).toEqual(longTerm);
    // An ordinary project reads back without the long-term fields.
    expect(t.projects.get('p-1')).toEqual(fx.project);
  });

  it('migrates a database at 0015 with its bodies, questions and projects intact', () => {
    const db = openDatabase(':memory:', { migrate: false });
    const all = loadMigrations();
    expect(all[15]?.name).toBe('long_term_projects');
    migrate(db, all.slice(0, 15));
    const t = tables(db);
    t.bodies.insert(fx.body);
    t.bodies.insert(fx.moon);
    // The 0015 projects table has no long-term columns: written by hand.
    db.prepare(
      `INSERT INTO projects (id, name, workspace, repo_path, body_id, state, created_at, updated_at,
         permission_rules, budget_usd)
       VALUES ('p-1', 'Auth refactor', '/w', '/w', 'b-luna', 'in_progress', ?, ?, NULL, 25)`,
    ).run(fx.NOW, fx.NOW);
    t.bodies.upsert({ ...fx.moon, host: { kind: 'project', id: 'p-1' } });
    // The 0015 tasks table has no provider columns: written by hand.
    db.prepare(
      `INSERT INTO tasks (id, project_id, body_id, description, priority, blocked_by, state,
         created_at, updated_at)
       VALUES (?, 'p-1', 'b-luna', ?, ?, '[]', ?, ?, ?)`,
    ).run(fx.task.id, fx.task.description, fx.task.priority, fx.task.state, fx.NOW, fx.NOW);
    t.agents.insert({ ...fx.agent, supervisorId: undefined });
    t.questions.insert(fx.question);
    t.questions.insert({ ...fx.permissionQuestion, status: 'answered', answer: 'yes' });
    const before = {
      bodies: t.bodies.all(),
      questions: t.questions.all(),
      tasks: t.tasks.all(),
      agents: t.agents.all(),
    };

    expect(migrate(db, all).applied).toEqual([16, 17]);
    const after = tables(db);
    expect(after.bodies.all()).toEqual(before.bodies);
    expect(after.questions.all()).toEqual(before.questions);
    expect(after.tasks.all()).toEqual(before.tasks);
    expect(after.agents.all()).toEqual(before.agents);
    expect(after.projects.get('p-1')).toMatchObject({ id: 'p-1', budgetUsd: 25 });
    expect(after.projects.get('p-1')?.longTerm).toBeUndefined();
    expect(
      db.prepare("SELECT long_term FROM projects WHERE id = 'p-1'").get() as { long_term: number },
    ).toEqual({ long_term: 0 });
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'bodies_host',
        'questions_status',
        'questions_history',
        'questions_origin',
        'areas_project',
        'areas_body',
        'jobs_due',
        'job_runs_job',
      ]),
    );
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // The widened checks take the new values.
    after.questions.insert(spendQuestion);
    after.bodies.upsert({ ...after.bodies.get('b-titan')!, host: { kind: 'areas', id: 'p-1' } });
  });

  it('puts the areas and jobs in the snapshot', () => {
    const log = new EventLog(openDatabase(':memory:'));
    expect(log.snapshot()).toMatchObject({ areas: [], jobs: [] });
    seed(log.tables);
    log.tables.areas.insert(fx.area);
    log.tables.jobs.insert(fx.job);
    const snap = log.snapshot();
    expect(snap.areas).toEqual([fx.area]);
    expect(snap.jobs).toEqual([fx.job]);
  });
});
