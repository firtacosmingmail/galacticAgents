import { afterEach, describe, expect, it } from 'vitest';
import {
  ClearJobValuesResponse,
  DashboardResponse,
  RefreshJobResponse,
  type Actor,
  type JobDraft,
  type PanelDraft,
} from '@galactic/protocol';
import type { FakeScenario } from '../adapters/fake/scenario.js';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { endJobRun, startJobRun } from '../domain/job-runs.js';
import { createPanel } from '../domain/panels.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/**
 * P15-04 — the dashboard's REST routes: a project's panel data, a job's refresh, a panel's clear
 * history, a job's clear stored values and the layout. All four writes are the user's own
 * dashboard actions, so a remote client (the phone) may make them too (decision 90 style).
 */

const USER: Actor = { type: 'user' };
const REMOTE = { origin: 'https://mymac.tail1234.ts.net' };
const DRAFT: JobDraft = {
  name: 'Count churn',
  instructions: 'Count the churn.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};
/** A run that waits on a clarification, so it is still going when refresh is pressed again. */
const ASKS: FakeScenario = { steps: [{ kind: 'ask', text: 'Which month?' }] };
const tile: (jobId: string) => PanelDraft = (jobId) => ({
  type: 'tile',
  title: 'Churn',
  source: { kind: 'job', jobId, values: ['churn'] },
  display: {},
  limits: [],
});

const lives: { stop(): Promise<void> }[] = [];
const runtimes: ComposedRuntime[] = [];
afterEach(async () => {
  for (const t of lives.splice(0)) await t.stop();
  for (const c of runtimes.splice(0)) await c.dispose().catch(() => {});
});

async function start() {
  const adapter = new FakeAdapter({
    speed: 0,
    scenarioFor: () => ({ name: 'job', scenario: ASKS }),
  });
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    flushMs: 10,
    stewardRuntimeOverride: () => 'fake' as const,
  });
  runtimes.push(c);
  const project = (
    await c.commands.createProject(
      { name: 'Shop', workspace: '/w/shop', longTerm: { purpose: 'Run the shop', goals: [] } },
      { origin: 'local' },
    )
  ).value;
  c.log.runCommand((ctx) =>
    createAgent(ctx, {
      role: 'waykeeper',
      runtime: 'fake',
      caps: { maxWallClockMs: 60_000, maxToolCalls: 10 },
      projectId: project.id,
    }),
  );
  const { job } = (
    await c.commands.createJob({
      projectId: project.id,
      area: { name: 'Billing' },
      draft: DRAFT,
      by: USER,
    })
  ).value;
  const run = c.log.runCommand((ctx) =>
    startJobRun(ctx, { jobId: job.id, purpose: 'scheduled', dueAt: ctx.now }),
  ).value;
  c.log.runCommand((ctx) =>
    endJobRun(ctx, { runId: run.id, outcome: 'quiet', numbers: { churn: 4.2 } }),
  );
  const churn = c.log.runCommand((ctx) => createPanel(ctx, project.id, tile(job.id), USER)).value;
  const board = c.log.runCommand((ctx) =>
    createPanel(
      ctx,
      project.id,
      { type: 'status', title: 'Work', source: { kind: 'tasks' }, display: {}, limits: [] },
      USER,
    ),
  ).value;
  const t = await startTestApp({ log: c.log, commands: c.commands, jobs: c.jobs });
  lives.push(t);
  const call = (
    method: string,
    path: string,
    {
      body,
      headers = {},
      token = TEST_TOKEN,
    }: { body?: unknown; headers?: Record<string, string>; token?: string } = {},
  ) =>
    fetch(`${t.baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { c, project, job, run, churn, board, call };
}

describe('GET /api/projects/:id/dashboard (P15-04)', () => {
  it('gives every panel’s data in dashboard order', async () => {
    const { project, churn, board, job, call } = await start();
    const res = await call('GET', `/api/projects/${project.id}/dashboard`);
    expect(res.status).toBe(200);
    const body = DashboardResponse.parse(await res.json());
    expect(body.panels.map((p) => p.panelId)).toEqual([churn.id, board.id]);
    expect(body.panels[0]).toMatchObject({
      status: 'ok',
      tile: { value: 4.2 },
      sourceLine: `from job “${job.name}”`,
    });
    expect(body.panels[1]?.statusBoard?.columns.map((col) => col.name)).toEqual([
      'In progress',
      'Next',
      'Done this week',
    ]);
  });

  it('refuses an unknown project and a missing token', async () => {
    const { project, call } = await start();
    expect((await call('GET', '/api/projects/p-nope/dashboard')).status).toBe(404);
    expect((await call('GET', `/api/projects/${project.id}/dashboard`, { token: '' })).status).toBe(
      401,
    );
  });
});

describe('POST /api/jobs/:id/refresh (P15-04)', () => {
  it('a remote client may refresh; a second press returns the run going', async () => {
    const { c, job, call } = await start();
    const first = await call('POST', `/api/jobs/${job.id}/refresh`, { headers: REMOTE });
    expect(first.status).toBe(200);
    const started = RefreshJobResponse.parse(await first.json());
    expect(started.started).toBe(true);
    expect(c.log.tables.jobRuns.get(started.runId)?.purpose).toBe('refresh');
    const again = RefreshJobResponse.parse(
      await (await call('POST', `/api/jobs/${job.id}/refresh`)).json(),
    );
    expect(again).toEqual({ runId: started.runId, started: false });
  });

  it('a paused job is refused (400 invalid); an unknown job is 404', async () => {
    const { c, job, call } = await start();
    await c.commands.setJobState({ jobId: job.id, state: 'paused', by: USER });
    const res = await call('POST', `/api/jobs/${job.id}/refresh`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid' });
    expect((await call('POST', '/api/jobs/j-nope/refresh')).status).toBe(404);
  });
});

describe('clearing (P15-04)', () => {
  it('a remote client may clear a panel’s history: it then reads no run', async () => {
    const { c, project, churn, call } = await start();
    const res = await call('POST', `/api/panels/${churn.id}/clear-history`, { headers: REMOTE });
    expect(res.status).toBe(204);
    expect(c.log.tables.panels.get(churn.id)?.historyFrom).toBeDefined();
    const body = DashboardResponse.parse(
      await (await call('GET', `/api/projects/${project.id}/dashboard`)).json(),
    );
    expect(body.panels[0]?.status).toBe('empty');
    expect((await call('POST', '/api/panels/pn-nope/clear-history')).status).toBe(404);
  });

  it('clearing a job’s stored values lists the panels reading it', async () => {
    const { c, job, run, churn, call } = await start();
    const res = await call('POST', `/api/jobs/${job.id}/clear-values`, { headers: REMOTE });
    expect(res.status).toBe(200);
    expect(ClearJobValuesResponse.parse(await res.json())).toEqual({ panels: [churn.id] });
    expect(c.log.tables.jobRuns.get(run.id)?.numbers).toBeUndefined();
  });

  it('a run ended with its report stores it once; clearing leaves no numbers, data or report', async () => {
    const { c, job, churn, call } = await start();
    const run = c.log.runCommand((ctx) =>
      startJobRun(ctx, { jobId: job.id, purpose: 'refresh', dueAt: ctx.now }),
    ).value;
    const report = {
      outcome: 'quiet',
      summary: 'Counted.',
      numbers: { churn: 5 },
      data: { texts: { note: 'steady' } },
    };
    c.log.runCommand((ctx) =>
      ctx.tables.jobRuns.upsert({ ...ctx.tables.jobRuns.get(run.id)!, meta: { report } }),
    );
    c.log.runCommand((ctx) =>
      endJobRun(ctx, {
        runId: run.id,
        outcome: 'quiet',
        summary: 'Counted.',
        numbers: { churn: 5 },
        data: { texts: { note: 'steady' } },
      }),
    );
    const ended = c.log.tables.jobRuns.get(run.id)!;
    expect(ended.numbers).toEqual({ churn: 5 });
    expect(ended.meta?.['report']).toBeUndefined();

    const res = await call('POST', `/api/jobs/${job.id}/clear-values`);
    expect(ClearJobValuesResponse.parse(await res.json())).toEqual({ panels: [churn.id] });
    const listed = (await (await call('GET', `/api/jobs/${job.id}/runs`)).json()) as {
      runs: Record<string, unknown>[];
    };
    expect(listed.runs).toHaveLength(2);
    for (const r of listed.runs) {
      expect(r['numbers']).toBeUndefined();
      expect(r['data']).toBeUndefined();
      expect((r['meta'] as Record<string, unknown> | undefined)?.['report']).toBeUndefined();
    }
  });
});

describe('PUT /api/projects/:id/dashboard/layout (P15-04)', () => {
  it('a remote client may arrange the dashboard', async () => {
    const { c, project, churn, board, call } = await start();
    const res = await call('PUT', `/api/projects/${project.id}/dashboard/layout`, {
      headers: REMOTE,
      body: {
        layouts: [
          { panelId: board.id, layout: { order: 0, w: 4, h: 1 } },
          { panelId: churn.id, layout: { order: 1, w: 1, h: 1, hidden: true } },
        ],
      },
    });
    expect(res.status).toBe(204);
    expect(c.log.tables.panels.get(churn.id)?.layout).toEqual({
      order: 1,
      w: 1,
      h: 1,
      hidden: true,
    });
  });

  it('refuses a malformed body (invalid_body) and a layout missing a panel (invalid)', async () => {
    const { project, churn, call } = await start();
    const path = `/api/projects/${project.id}/dashboard/layout`;
    const bad = await call('PUT', path, { body: { layouts: [{ panelId: churn.id }] } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'invalid_body' });
    const missing = await call('PUT', path, {
      body: { layouts: [{ panelId: churn.id, layout: { order: 0, w: 1, h: 1 } }] },
    });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid' });
  });
});
