import { describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { openDatabase } from './database.js';
import { exportMap } from './map-export.js';
import { loadMigrations, migrate } from './migrate.js';
import { tables, type Tables } from './tables.js';

function seed(t: Tables): void {
  t.bodies.insert(fx.body);
  t.bodies.insert(fx.moon);
  t.projects.insert(fx.project);
  t.tasks.insert(fx.task);
  t.tasks.insert({ ...fx.task, id: 't-job-1', meta: { jobId: 'j-1' } });
  t.agents.insert({ ...fx.agent, supervisorId: undefined });
  t.areas.insert(fx.area);
}

const indexNames = (db: Database, table: string): string[] =>
  (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map((r) => r.name);

describe('provider columns (P11-02)', () => {
  it('round-trips a task with a provider, a model and the publish flags', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    const task = {
      ...fx.task,
      id: 't-gem',
      provider: 'gemini' as const,
      model: 'gemini-3.8-flash-low',
      publishes: false,
      makesImages: true,
    };
    t.tasks.insert(task);
    // The flags are stored 0/1: false reads back as absent, true as true.
    const { publishes: _no, ...stored } = task;
    expect(t.tasks.get('t-gem')).toEqual(stored);
    const publishing = { ...task, id: 't-pub', provider: 'chatgpt' as const, publishes: true };
    t.tasks.insert(publishing);
    expect(t.tasks.get('t-pub')).toEqual(publishing);
    // A task without them reads back without them.
    expect(t.tasks.get(fx.task.id)).toEqual(fx.task);
  });

  it('round-trips a project default provider', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    const project = { ...fx.project, id: 'p-gpt', defaultProvider: 'chatgpt' as const };
    t.projects.insert(project);
    expect(t.projects.get('p-gpt')).toEqual(project);
  });

  it('round-trips a job with its model, follow-up provider, follow-up model and limit question', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    const job = {
      ...fx.job,
      id: 'j-2',
      provider: 'gemini' as const,
      model: 'gemini-3.8-flash-low',
      followUpProvider: 'chatgpt' as const,
      followUpModel: 'gpt-5.5',
      limitQuestionId: 'q-limit',
    };
    t.jobs.insert(job);
    expect(t.jobs.get('j-2')).toEqual(job);
    expect(t.jobs.get(fx.job.id)).toBeUndefined();
  });

  it('accepts a publish question and a limited job run', () => {
    const t = tables(openDatabase(':memory:'));
    seed(t);
    t.jobs.insert(fx.job);
    const publish: Question = { ...fx.question, id: 'q-pub', kind: 'publish' };
    t.questions.insert(publish);
    expect(t.questions.get('q-pub')?.kind).toBe('publish');
    t.jobRuns.insert({ ...fx.jobRun, id: 'jr-lim', outcome: 'limited' });
    expect(t.jobRuns.get('jr-lim')?.outcome).toBe('limited');
  });

  it('refuses an unknown provider in the database', () => {
    const db = openDatabase(':memory:');
    const t = tables(db);
    seed(t);
    expect(() => db.prepare("UPDATE tasks SET provider = 'openai'").run()).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => t.tasks.insert({ ...fx.task, id: 't-x', provider: 'openai' as never })).toThrow();
    expect(() =>
      db.prepare("UPDATE projects SET default_provider = 'openai' WHERE id = 'p-1'").run(),
    ).toThrow(/CHECK constraint failed/);
    t.jobs.insert(fx.job);
    expect(() => db.prepare("UPDATE jobs SET follow_up_provider = 'openai'").run()).toThrow(
      /CHECK constraint failed/,
    );
  });

  it('rejects a stored job provider that is not a provider when reading', () => {
    const db = openDatabase(':memory:');
    const t = tables(db);
    seed(t);
    t.jobs.insert(fx.job);
    db.prepare("UPDATE jobs SET provider = 'openai'").run();
    expect(() => t.jobs.get(fx.job.id)).toThrow();
  });

  it('migrates a database at 0016 keeping its questions, job runs and their indexes', () => {
    const db = openDatabase(':memory:', { migrate: false });
    const all = loadMigrations();
    expect(all[16]?.name).toBe('ai_providers');
    migrate(db, all.slice(0, 16));
    const t = tables(db);
    // The 0016 projects and tasks tables have no provider columns: written by hand.
    t.bodies.insert(fx.body);
    t.bodies.insert(fx.moon);
    db.prepare(
      `INSERT INTO projects (id, name, workspace, body_id, state, created_at, updated_at)
       VALUES ('p-1', 'Auth refactor', '/w', 'b-luna', 'in_progress', ?, ?)`,
    ).run(fx.NOW, fx.NOW);
    for (const id of ['t-1', 't-job-1']) {
      db.prepare(
        `INSERT INTO tasks (id, project_id, body_id, description, priority, blocked_by, state,
           created_at, updated_at)
         VALUES (?, 'p-1', 'b-luna', 'x', 'normal', '[]', 'approved', ?, ?)`,
      ).run(id, fx.NOW, fx.NOW);
    }
    t.agents.insert({ ...fx.agent, supervisorId: undefined });
    t.areas.insert(fx.area);
    t.questions.insert(fx.question);
    db.prepare(
      `INSERT INTO jobs (id, project_id, area_id, task_id, name, instructions, schedule, state,
         created_at, updated_at)
       VALUES ('j-1', 'p-1', 'ar-1', 't-job-1', 'Reviews', 'x', '{"kind":"daily","at":"09:00"}',
         'active', ?, ?)`,
    ).run(fx.NOW, fx.NOW);
    t.jobRuns.insert(fx.jobRun);
    const before = { questions: t.questions.all(), runs: t.jobRuns.all() };

    expect(migrate(db, all).applied).toEqual([17]);
    const after = tables(db);
    expect(after.questions.all()).toEqual(before.questions);
    expect(after.jobRuns.all()).toEqual(before.runs);
    expect(indexNames(db, 'questions')).toEqual(
      expect.arrayContaining(['questions_status', 'questions_history', 'questions_origin']),
    );
    expect(indexNames(db, 'job_runs')).toEqual(expect.arrayContaining(['job_runs_job']));
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(after.jobs.get('j-1')).toMatchObject({ provider: 'claude' });
    after.questions.insert({ ...fx.question, id: 'q-pub', kind: 'publish' });
    after.jobRuns.insert({ ...fx.jobRun, id: 'jr-lim', outcome: 'limited' });
  });

  it('keeps the new fields in a map export', () => {
    const db = openDatabase(':memory:');
    const t = tables(db);
    seed(t);
    t.projects.insert({ ...fx.project, id: 'p-gpt', defaultProvider: 'chatgpt' });
    t.tasks.insert({ ...fx.task, id: 't-gem', provider: 'gemini', makesImages: true });
    const rows = exportMap(db).rows;
    expect(rows.projects.find((p) => p.id === 'p-gpt')?.defaultProvider).toBe('chatgpt');
    expect(rows.tasks.find((x) => x.id === 't-gem')).toMatchObject({
      provider: 'gemini',
      makesImages: true,
    });
  });
});
