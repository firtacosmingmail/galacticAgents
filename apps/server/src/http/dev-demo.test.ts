import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRetiredBody,
  type DemoClearResponse,
  type HarnessScenarioResponse,
  type Project,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * P7-07 — "Clear demo projects" (`POST /dev/demo/clear`): development only, local only; archives
 * every seeded demo project and retires its planet, never touching real work or harness items.
 */

let composed: ComposedRuntime;
let t: Awaited<ReturnType<typeof startTestApp>>;

beforeEach(async () => {
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
    stallThresholdMs: () => 50,
    tickMs: 20,
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
});

const post = async (path: string, headers: Record<string, string> = {}, baseUrl = t.baseUrl) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_TOKEN}`, ...headers },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const seed = async () => {
  const res = await post('/dev/seed');
  expect(res.status).toBe(200);
  return composed.log.tables.projects.get(res.body['projectId'] as string)!;
};
/** A demo planet + project as `/dev/seed` made them before P7-07 (no `meta`), already archived
 * with its planet freed — the leftovers in Cosmin's database. */
const legacyLeftover = (n: number): Project =>
  composed.log.runCommand((ctx) => {
    const project: Project = {
      id: `p-legacy-${n}`,
      name: `Demo project ${n}`,
      workspace: `/tmp/galactic-demo-${n}`,
      bodyId: `b-legacy-${n}`,
      state: 'archived',
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    const body = { id: project.bodyId, kind: 'planet', name: `Demo planet ${n}` } as const;
    ctx.tables.bodies.insert(body);
    ctx.tables.projects.insert(project);
    ctx.emit({ type: 'body.created', body });
    ctx.emit({ type: 'project.created', project });
    return project;
  }).value;

describe('/dev/demo/clear guards (P7-07)', () => {
  it('does not exist without GALACTIC_DEV', async () => {
    const prod = await startTestApp({
      log: composed.log,
      statuses: composed.statuses,
      commands: composed.commands,
      runtime: composed.runtime,
      config: testConfig({ dev: false }),
    });
    try {
      expect((await post('/dev/demo/clear', {}, prod.baseUrl)).status).toBe(404);
    } finally {
      await prod.stop();
    }
  });

  it('needs the token', async () => {
    const res = await fetch(`${t.baseUrl}/dev/demo/clear`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('is refused for remote clients, nothing archived', async () => {
    const demo = await seed();
    const forwarded = await post('/dev/demo/clear', { 'x-forwarded-for': '100.64.0.7' });
    expect(forwarded).toMatchObject({ status: 403, body: { error: 'remote_dev' } });
    const tailnet = await post('/dev/demo/clear', { origin: 'https://box.tail1234.ts.net' });
    expect(tailnet).toMatchObject({ status: 403, body: { error: 'remote_dev' } });
    expect(composed.log.tables.projects.get(demo.id)!.state).toBe('in_progress');
    expect(composed.log.eventsSince(0).map((e) => e.event.type)).not.toContain('body.retired');
  });
});

describe('/dev/demo/clear (P7-07)', () => {
  it('archives every demo project and retires its planet; real projects and harness items untouched', async () => {
    const { commands, log } = composed;
    const { tables } = log;
    const a = await seed();
    const b = await seed();
    const leftover = legacyLeftover(9);
    const task = (await commands.createTask({ description: 'demo task', projectId: b.id })).value;
    const real = (await commands.createProject({ name: 'Real', workspace: '/w/real' })).value;
    const scenario = (await post('/dev/harness/scenario'))
      .body as unknown as HarnessScenarioResponse;
    const harnessProject = tables.projects.get(scenario.projectId)!;
    const harnessStates = new Map(tables.tasks.all().map((x) => [x.id, x.state]));

    const res = await post('/dev/demo/clear');
    expect(res.status).toBe(200);
    const out = res.body as unknown as DemoClearResponse;
    expect(out.projects.sort()).toEqual([a.id, b.id].sort());
    expect(out.tasks).toEqual([task.id]);
    expect(out.retired.sort()).toEqual([a.bodyId, b.bodyId, leftover.bodyId].sort());
    expect(out.skipped).toEqual([]);

    for (const p of [a, b]) expect(tables.projects.get(p.id)!.state).toBe('archived');
    expect(tables.tasks.get(task.id)!.state).toBe('archived');
    for (const id of out.retired) expect(isRetiredBody(tables.bodies.get(id)!)).toBe(true);
    const snapshotBodies = log.snapshot().bodies.map((x) => x.id);
    for (const id of out.retired) expect(snapshotBodies).not.toContain(id);

    // Real work and the harness's are exactly as they were.
    expect(tables.projects.get(real.id)).toEqual(real);
    expect(tables.bodies.get(real.bodyId)!.host).toEqual({ kind: 'project', id: real.id });
    expect(tables.projects.get(harnessProject.id)).toEqual(harnessProject);
    for (const x of tables.tasks.all()) {
      if (x.id !== task.id) expect(x.state).toBe(harnessStates.get(x.id));
    }

    // Nothing comes back when new projects need planets: every one is a catalogue planet.
    const placed: string[] = [];
    for (;;) {
      try {
        const p = (await commands.createProject({ name: `P${placed.length}`, workspace: '/w/p' }))
          .value;
        placed.push(p.bodyId);
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as Error).message).toMatch(/no free planet/);
        break;
      }
    }
    expect(placed.length).toBeGreaterThan(0);
    for (const id of placed)
      expect(tables.bodies.get(id)!.meta?.['orbit']).toEqual(expect.any(Number));

    // A second clear has nothing left to do.
    const again = (await post('/dev/demo/clear')).body as unknown as DemoClearResponse;
    expect(again).toMatchObject({ projects: [], tasks: [], retired: [], skipped: [] });
  });

  it('skips a demo planet still hosting real work and names it', async () => {
    const { log } = composed;
    // Before P7-07 a real project could land on a free demo planet.
    log.runCommand((ctx) => {
      const body = { id: 'b-leak', kind: 'planet', name: 'Demo planet 4' } as const;
      ctx.tables.bodies.insert({ ...body, host: { kind: 'project', id: 'p-real' } });
      ctx.tables.projects.insert({
        id: 'p-real',
        name: 'csv2parquet',
        workspace: '/w/csv',
        bodyId: 'b-leak',
        state: 'in_progress',
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      ctx.emit({ type: 'body.created', body });
    });
    const out = (await post('/dev/demo/clear')).body as unknown as DemoClearResponse;
    expect(out.projects).toEqual([]);
    expect(out.retired).toEqual([]);
    expect(out.skipped).toEqual([
      { id: 'b-leak', reason: 'Demo planet 4 still holds project p-real' },
    ]);
    expect(log.tables.projects.get('p-real')!.state).toBe('in_progress');
  });
});
