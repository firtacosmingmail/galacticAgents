import { describe, expect, it } from 'vitest';
import { isDemoBody, isRetiredBody, type Body, type Project } from '@galactic/protocol';
import { world } from '../test/world.js';
import { assignBody, retireBody } from './bodies.js';
import { chooseBody, freePlanets, occupiedPlanets } from './catalogue.js';
import { retireFreeDemoBodies, seedDemoProject } from './demo.js';
import { archiveProject, closeProject, createProject, reopenProject } from './projects.js';
import { archiveTask, closeTask, createTask } from './tasks.js';

/**
 * P7-07 — demo planets go away for good: a `/dev/seed` planet is never chosen or assigned for real
 * work, and is retired (`body.retired`) when its project is archived.
 */

const USER = { type: 'user' } as const;

/** A demo planet + project as `/dev/seed` made them before P7-07: no `meta` at all. */
function legacySeed(run: ReturnType<typeof world>['run'], n: number) {
  return run((ctx) => {
    const body: Body = { id: `b-legacy-${n}`, kind: 'planet', name: `Demo planet ${n}` };
    const project: Project = {
      id: `p-legacy-${n}`,
      name: `Demo project ${n}`,
      workspace: `/tmp/galactic-demo-${n}`,
      bodyId: body.id,
      state: 'in_progress',
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    const host = { kind: 'project', id: project.id } as const;
    ctx.tables.bodies.insert({ ...body, host });
    ctx.tables.projects.insert(project);
    ctx.emit({ type: 'body.created', body });
    ctx.emit({ type: 'project.created', project });
    ctx.emit({ type: 'body.assigned', bodyId: body.id, host });
    return project;
  }).value;
}

/** Takes every free catalogue planet with a real project. */
function fillCatalogue(run: ReturnType<typeof world>['run']) {
  return Array.from(
    { length: 7 },
    (_, i) => run((ctx) => createProject(ctx, { name: `Real ${i}`, workspace: `/w/${i}` })).value,
  );
}

describe('seeded demo work (P7-07)', () => {
  it('flags the planet and the project `meta.demo`', () => {
    const { tables, run } = world();
    const { value: project, types } = run((ctx) => seedDemoProject(ctx));
    expect(types).toEqual(['body.created', 'project.created', 'body.assigned']);
    expect(project.meta).toEqual({ demo: true });
    const body = tables.bodies.get(project.bodyId)!;
    expect(body.meta).toEqual({ demo: true });
    expect(isDemoBody(body)).toBe(true);
    expect(body.host).toEqual({ kind: 'project', id: project.id });
  });
});

describe('demo planets are never chosen for real work (P7-07)', () => {
  it('freePlanets and chooseBody skip a free demo planet, flagged or legacy', () => {
    const { log, run } = world();
    const seeded = run((ctx) => seedDemoProject(ctx)).value;
    const legacy = legacySeed(run, 2);
    // Free both planets the way the bug did: their projects archived before P7-07 (no retire).
    for (const p of [seeded, legacy]) {
      run((ctx) => {
        const body = ctx.tables.bodies.get(p.bodyId)!;
        const { host: _h, ...free } = body;
        ctx.tables.bodies.upsert(free);
        ctx.tables.projects.upsert({ ...ctx.tables.projects.get(p.id)!, state: 'archived' });
      });
    }
    fillCatalogue(run);
    expect(freePlanets(log)).toEqual([]);
    const choice = chooseBody(log, { kind: 'planet' });
    expect(choice).toMatchObject({ ok: false, reason: 'no_free_planet' });
    expect(() => run((ctx) => createProject(ctx, { name: 'X', workspace: '/w/x' }))).toThrow(
      /no free planet/,
    );
  });

  it('never chooses any orbit-less planet, whatever its name', () => {
    const { log, run } = world();
    run((ctx) => {
      ctx.tables.bodies.insert({ id: 'b-handmade', kind: 'planet', name: 'Vulcan' });
    });
    fillCatalogue(run);
    expect(chooseBody(log, { kind: 'planet' })).toMatchObject({ ok: false });
  });

  it('refuses to assign a demo planet to real work, even by name', () => {
    const { log, run, tables } = world();
    const seeded = run((ctx) => seedDemoProject(ctx)).value;
    run((ctx) => closeProject(ctx, seeded.id, USER));
    expect(() =>
      run((ctx) => createProject(ctx, { name: 'Real', workspace: '/w/r', bodyId: seeded.bodyId })),
    ).toThrow(/demo planet/);
    // An occupied demo planet is listed as occupied (it is), never offered.
    expect(occupiedPlanets(log).map((o) => o.bodyId)).toContain(seeded.bodyId);
    const real = run((ctx) => createProject(ctx, { name: 'Real', workspace: '/w/r' })).value;
    expect(() =>
      run((ctx) => assignBody(ctx, seeded.bodyId, { kind: 'project', id: real.id })),
    ).toThrow(/already hosts|demo planet/);
    expect(tables.bodies.get(seeded.bodyId)!.host?.id).toBe(seeded.id);
  });
});

describe('a demo planet retires with its project (P7-07)', () => {
  it('archiving a demo project frees and retires its planet: body.retired, out of the snapshot', () => {
    const { log, run, tables } = world();
    const seeded = run((ctx) => seedDemoProject(ctx)).value;
    run((ctx) => closeProject(ctx, seeded.id, USER));
    const { types } = run((ctx) => archiveProject(ctx, seeded.id, USER));
    expect(types).toEqual(['project.state_changed', 'body.freed', 'body.retired']);
    const body = tables.bodies.get(seeded.bodyId)!;
    expect(isRetiredBody(body)).toBe(true);
    expect(body.host).toBeUndefined();
    // The tombstone keeps archived work's `bodyId` valid, but the world no longer has the body.
    expect(tables.projects.get(seeded.id)!.bodyId).toBe(seeded.bodyId);
    expect(log.snapshot().bodies.map((b) => b.id)).not.toContain(seeded.bodyId);
  });

  it('retires a legacy demo planet too, and one a real project leaked onto', () => {
    const { run, tables } = world();
    const legacy = legacySeed(run, 1);
    run((ctx) => closeProject(ctx, legacy.id, USER));
    expect(run((ctx) => archiveProject(ctx, legacy.id, USER)).types).toContain('body.retired');

    // Before P7-07 a real project could land on a free demo planet: it keeps it while it lives,
    // and the planet retires when that project is archived.
    const other = legacySeed(run, 2);
    run((ctx) => {
      const { host: _h, ...free } = ctx.tables.bodies.get(other.bodyId)!;
      ctx.tables.bodies.upsert(free);
      ctx.tables.projects.upsert({ ...ctx.tables.projects.get(other.id)!, state: 'archived' });
      ctx.tables.projects.insert({
        id: 'p-real',
        name: 'Real',
        workspace: '/w/real',
        bodyId: other.bodyId,
        state: 'in_progress',
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      ctx.tables.bodies.upsert({ ...free, host: { kind: 'project', id: 'p-real' } });
    });
    const busy = run((ctx) => retireFreeDemoBodies(ctx)).value;
    expect(busy.retired).toEqual([]);
    expect(busy.busy.map((b) => b.id)).toEqual([other.bodyId]);
    run((ctx) => closeProject(ctx, 'p-real', USER));
    expect(run((ctx) => archiveProject(ctx, 'p-real', USER)).types).toContain('body.retired');
    expect(isRetiredBody(tables.bodies.get(other.bodyId)!)).toBe(true);
  });

  it('never retires a catalogue planet or an asteroid', () => {
    const { run, tables } = world();
    const real = run((ctx) => createProject(ctx, { name: 'Real', workspace: '/w/r' })).value;
    run((ctx) => closeProject(ctx, real.id, USER));
    expect(run((ctx) => archiveProject(ctx, real.id, USER)).types).not.toContain('body.retired');
    expect(isRetiredBody(tables.bodies.get(real.bodyId)!)).toBe(false);
    const task = run((ctx) => createTask(ctx, { description: 'standalone' })).value;
    run((ctx) => closeTask(ctx, task.id, USER));
    expect(run((ctx) => archiveTask(ctx, task.id, USER)).types).not.toContain('body.retired');
    expect(() => run((ctx) => retireBody(ctx, tables.bodies.get(real.bodyId)!))).toThrow(
      /not a demo body/,
    );
    expect(() => run((ctx) => retireBody(ctx, tables.bodies.get(task.bodyId)!))).toThrow(
      /not a demo body/,
    );
  });

  it('a retired planet is never assigned again; reopening its project takes a catalogue planet', () => {
    const { run, tables } = world();
    const seeded = run((ctx) => seedDemoProject(ctx)).value;
    run((ctx) => closeProject(ctx, seeded.id, USER));
    run((ctx) => archiveProject(ctx, seeded.id, USER));
    const reopened = run((ctx) => reopenProject(ctx, seeded.id, USER)).value;
    expect(reopened.bodyId).toBe('b-mars'); // decision 10: a planet with free moons
    expect(isRetiredBody(tables.bodies.get(seeded.bodyId)!)).toBe(true);
    expect(() =>
      run((ctx) => reopenProject(ctx, seeded.id, USER, { bodyId: seeded.bodyId })),
    ).toThrow();
  });

  it('retireFreeDemoBodies takes the leftovers of earlier archives, once', () => {
    const { run } = world();
    const a = legacySeed(run, 1);
    run((ctx) => {
      const { host: _h, ...free } = ctx.tables.bodies.get(a.bodyId)!;
      ctx.tables.bodies.upsert(free);
    });
    const first = run((ctx) => retireFreeDemoBodies(ctx));
    expect(first.value.retired).toEqual([a.bodyId]);
    expect(first.types).toEqual(['body.retired']);
    expect(run((ctx) => retireFreeDemoBodies(ctx)).types).toEqual([]);
  });
});
