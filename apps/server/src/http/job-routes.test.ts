import { afterEach, describe, expect, it } from 'vitest';
import { JobRunsResponse, type Actor, type JobDraft } from '@galactic/protocol';
import { endJobRun, startJobRun } from '../domain/job-runs.js';
import { createJob } from '../domain/jobs.js';
import { createProject } from '../domain/projects.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';
import { world } from '../test/world.js';

/**
 * P10-07 — `GET /api/jobs/:id/runs?limit=`: a job's run history for the Jobs tab, newest first,
 * bearer-guarded, `limit` 1–200 (default 20).
 */

const USER: Actor = { type: 'user' };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and summarise them.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

const apps: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
});

async function start(runs: number) {
  const w = world();
  const cmd = <T>(fn: Parameters<typeof w.log.runCommand<T>>[0]): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace: '/w/shop',
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: [] },
    }),
  );
  const { job } = cmd((ctx) =>
    createJob(ctx, { projectId: project.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
  );
  const ids: string[] = [];
  for (let i = 0; i < runs; i++) {
    const run = cmd((ctx) =>
      startJobRun(ctx, { jobId: job.id, purpose: 'scheduled', dueAt: '2026-10-01T09:00:00.000Z' }),
    );
    cmd((ctx) => endJobRun(ctx, { runId: run.id, outcome: 'quiet', summary: `run ${i + 1}` }));
    ids.push(run.id);
  }
  const t = await startTestApp({ config: testConfig(), log: w.log });
  apps.push(t);
  const get = (path: string, token = TEST_TOKEN) =>
    fetch(`${t.baseUrl}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { job, ids, get };
}

describe('GET /api/jobs/:id/runs (P10-07)', () => {
  it('lists the runs newest first, 20 by default, fewer with limit', async () => {
    const { job, ids, get } = await start(23);
    const res = await get(`/api/jobs/${job.id}/runs`);
    expect(res.status).toBe(200);
    const body = JobRunsResponse.parse(await res.json());
    expect(body.runs.map((r) => r.id)).toEqual([...ids].reverse().slice(0, 20));
    expect(body.runs[0]!.summary).toBe('run 23');

    const three = JobRunsResponse.parse(
      await (await get(`/api/jobs/${job.id}/runs?limit=3`)).json(),
    );
    expect(three.runs.map((r) => r.id)).toEqual([...ids].reverse().slice(0, 3));
    const all = JobRunsResponse.parse(
      await (await get(`/api/jobs/${job.id}/runs?limit=200`)).json(),
    );
    expect(all.runs).toHaveLength(23);
  });

  it('refuses a limit outside 1–200, an unknown job and a missing token', async () => {
    const { job, get } = await start(1);
    for (const limit of ['500', '0', 'many']) {
      const res = await get(`/api/jobs/${job.id}/runs?limit=${limit}`);
      expect(res.status, limit).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_query');
    }
    const missing = await get('/api/jobs/j-nope/runs');
    expect(missing.status).toBe(404);
    expect((await get(`/api/jobs/${job.id}/runs`, '')).status).toBe(401);
  });
});
