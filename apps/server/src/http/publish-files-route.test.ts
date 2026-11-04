import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Actor, JobDraft } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { createAgent } from '../domain/agents.js';
import { attachJobRunAgent, startJobRun } from '../domain/job-runs.js';
import { createJob } from '../domain/jobs.js';
import { createProject } from '../domain/projects.js';
import { createTask } from '../domain/tasks.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, TEST_TOKEN } from '../test/harness.js';

/**
 * P11-09 (ruling R24): the route is behind the bearer guard and answers 404 for no such file.
 * P11-12: a listed image of a real publish question is served through HTTP, and an ended job
 * run's Steward's folder is the one it ran in (`meta.cwd`).
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const DRAFT: JobDraft = {
  name: 'Post the news',
  instructions: 'Post the weekly news.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;
const folders: string[] = [];

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
  });
  t = await startTestApp({
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
  });
});
afterEach(async () => {
  await composed.dispose();
  await t.stop();
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
});

const folder = () => {
  const f = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-pubroute-')));
  folders.push(f);
  return f;
};
const cmd = <T>(fn: Parameters<typeof composed.log.runCommand<T>>[0]): T =>
  composed.log.runCommand(fn).value;
const get = (questionId: string, index = '0') =>
  fetch(`${t.baseUrl}/api/questions/${questionId}/publish-files/${index}`, {
    headers: { authorization: `Bearer ${TEST_TOKEN}` },
  });

function projectWithWaykeeper(workspace: string) {
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace,
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    }),
  );
  const wk = cmd((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  );
  return { project, wk };
}

describe('GET /api/questions/:id/publish-files/:index', () => {
  it('needs the token', async () => {
    const res = await fetch(`${t.baseUrl}/api/questions/q-x/publish-files/0`);
    expect(res.status).toBe(401);
  });

  it('is 404 for a question that does not exist', async () => {
    const res = await get('q-x');
    expect(res.status).toBe(404);
  });

  it('serves the listed image of a publishing step’s request (P11-12)', async () => {
    const workspace = folder();
    writeFileSync(join(workspace, 'post.png'), PNG);
    const { project, wk } = projectWithWaykeeper(workspace);
    const task = cmd((ctx) =>
      createTask(ctx, { projectId: project.id, description: 'Post', publishes: true }),
    );
    const steward = cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        taskId: task.id,
        supervisorId: wk.id,
      }),
    );
    const { questionId } = (
      await composed.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'X',
        account: '@shop',
        text: 'We launched!',
        files: ['post.png'],
      })
    ).value;

    const res = await get(questionId);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await get(questionId, '1')).status).toBe(404);
  });

  it('reads an ended job run’s Steward’s files from the folder it ran in (meta.cwd, P11-12)', async () => {
    const workspace = folder();
    const ranIn = folder();
    writeFileSync(join(workspace, 'post.png'), PNG);
    writeFileSync(join(ranIn, 'post.png'), PNG);
    const { project, wk } = projectWithWaykeeper(workspace);
    const { job } = cmd((ctx) =>
      createJob(ctx, { projectId: project.id, area: { name: 'News' }, draft: DRAFT, by: USER }),
    );
    const run = cmd((ctx) =>
      startJobRun(ctx, { jobId: job.id, purpose: 'scheduled', dueAt: '2026-10-01T09:00:00.000Z' }),
    );
    const steward = cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        taskId: job.taskId,
        projectId: project.id,
        supervisorId: wk.id,
        meta: { cwd: ranIn },
      }),
    );
    cmd((ctx) => attachJobRunAgent(ctx, { runId: run.id, agentId: steward.id }));
    const { questionId } = (
      await composed.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'X',
        account: '@shop',
        text: 'This week',
        files: ['post.png'],
      })
    ).value;
    // The workspace's file of the same name is another file now; the run's is the approved one.
    writeFileSync(join(workspace, 'post.png'), Buffer.from('another image'));

    const res = await get(questionId);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });
});
