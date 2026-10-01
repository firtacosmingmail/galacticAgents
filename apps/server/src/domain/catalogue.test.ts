import { afterEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { loadMigrations, migrate } from '../db/migrate.js';
import { tables as openTables } from '../db/tables.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { spawnHarmonizer, spawnWaykeeper } from '../test/hierarchy.js';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { assignBody, freeBody, moveHost, sweepMarkers, DEFAULT_RETENTION_MS } from './bodies.js';
import {
  EARTH_ID,
  MOON_ID,
  SUN_ID,
  asteroidSpec,
  chooseBody,
  freeMoons,
  freePlanets,
  isReserved,
} from './catalogue.js';
import { archiveProject, closeProject, createProject } from './projects.js';
import { createTask, moveTask } from './tasks.js';

/**
 * P2-02 — the body catalogue: the seeded Sun, planets and moons, decision 10's choice, the
 * "no free planet" refusal, procedural asteroids and the "moved to …" marker with retention.
 */

const USER = { type: 'user' } as const;
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const DAY = 24 * 60 * 60 * 1000;
const ids = (bodies: { id: string }[]) => bodies.map((b) => b.id);

describe('the seeded catalogue (migration 0005)', () => {
  it('holds the Sun, eight planets in orbit order and their major moons', () => {
    const { tables } = world();
    const all = tables.bodies.all();
    expect(all).toHaveLength(31);
    expect(all.filter((b) => b.kind === 'star').map((b) => b.name)).toEqual(['Sun']);
    expect(all.filter((b) => b.kind === 'planet').map((b) => b.name)).toEqual([
      'Mercury',
      'Venus',
      'Earth',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ]);
    const moonsOf = (planet: string) =>
      all.filter((b) => b.kind === 'moon' && b.parentId === `b-${planet}`).map((b) => b.name);
    expect(moonsOf('earth')).toEqual(['Moon']);
    expect(moonsOf('mars')).toEqual(['Phobos', 'Deimos']);
    expect(moonsOf('jupiter')).toEqual(['Io', 'Europa', 'Ganymede', 'Callisto']);
    expect(moonsOf('saturn')).toHaveLength(7);
    expect(moonsOf('uranus')).toHaveLength(5);
    expect(moonsOf('neptune')).toEqual(['Proteus', 'Triton', 'Nereid']);
    expect(moonsOf('mercury')).toEqual([]);
    // every moon orbits a planet of the catalogue; nothing else has a parent
    const planets = new Set(all.filter((b) => b.kind === 'planet').map((b) => b.id));
    for (const b of all) {
      if (b.kind === 'moon') expect(planets.has(b.parentId!), b.name).toBe(true);
      else expect(b.parentId, b.name).toBeUndefined();
    }
  });

  it('reserves exactly the Sun, Earth and Earth’s Moon', () => {
    const { tables } = world();
    expect(ids(tables.bodies.all().filter(isReserved))).toEqual([SUN_ID, EARTH_ID, MOON_ID]);
  });

  it('keeps existing bodies and their hosts through the table rebuild, with foreign keys back on', () => {
    const db = openDatabase(':memory:', { migrate: false });
    const all = loadMigrations();
    migrate(db, all.slice(0, 4));
    db.prepare(
      "INSERT INTO bodies (id, kind, name, host_kind, host_id) VALUES ('b-demo', 'planet', 'Demo', 'project', 'p-1')",
    ).run();
    db.prepare(
      "INSERT INTO projects (id, name, workspace, body_id, state, created_at, updated_at) VALUES ('p-1', 'Demo', '/w', 'b-demo', 'approved', 't', 't')",
    ).run();
    expect(migrate(db, all).applied).toEqual([5]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const t = openTables(db);
    expect(t.bodies.get('b-demo')).toEqual({
      id: 'b-demo',
      kind: 'planet',
      name: 'Demo',
      host: { kind: 'project', id: 'p-1' },
    });
    expect(t.bodies.all()[0]?.id).toBe('b-demo'); // existing rows keep their place
    expect(t.bodies.all()).toHaveLength(32);
    // the projects' reference to bodies still holds after the rename
    expect(() =>
      db
        .prepare(
          "INSERT INTO projects (id, name, workspace, body_id, state, created_at, updated_at) VALUES ('p-2', 'X', '/w', 'b-nowhere', 'approved', 't', 't')",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(() => t.bodies.insert({ id: 'b-x', kind: 'star', name: 'Vega' })).not.toThrow();
  });
});

describe('freePlanets / freeMoons', () => {
  it('list the free, unreserved bodies in catalogue order', () => {
    const { log } = world();
    expect(ids(freePlanets(log))).toEqual([
      'b-mercury',
      'b-venus',
      'b-mars',
      'b-jupiter',
      'b-saturn',
      'b-uranus',
      'b-neptune',
    ]);
    expect(ids(freeMoons(log)).slice(0, 6)).toEqual([
      'b-phobos',
      'b-deimos',
      'b-io',
      'b-europa',
      'b-ganymede',
      'b-callisto',
    ]);
    expect(ids(freeMoons(log))).not.toContain(MOON_ID);
    expect(ids(freeMoons(log))).toHaveLength(21);
    expect(ids(freeMoons(log, 'b-mars'))).toEqual(['b-phobos', 'b-deimos']);
    expect(freeMoons(log, EARTH_ID)).toEqual([]);
  });

  it('leave out taken and marked bodies, and return the same order every time', () => {
    const { log, run } = world();
    const p = run((ctx) => createProject(ctx, { name: 'A', workspace: '/w', bodyId: 'b-mars' }));
    run((ctx) => createProject(ctx, { name: 'B', workspace: '/w', bodyId: 'b-io' }));
    run((ctx) => moveHost(ctx, { kind: 'project', id: p.value.id }, 'b-saturn'));
    // Mars shows "moved to Saturn": neither free nor taken
    expect(ids(freePlanets(log))).toEqual([
      'b-mercury',
      'b-venus',
      'b-jupiter',
      'b-uranus',
      'b-neptune',
    ]);
    expect(ids(freeMoons(log, 'b-jupiter'))).toEqual(['b-europa', 'b-ganymede', 'b-callisto']);
    expect(freePlanets(log)).toEqual(freePlanets(log));
  });
});

describe('chooseBody (decision 10)', () => {
  it('gives a planet with free moons first, room for sub-projects', () => {
    const { log, run } = world();
    expect(chooseBody(log, { kind: 'planet' })).toMatchObject({ ok: true, body: { id: 'b-mars' } });
    run((ctx) => createProject(ctx, { name: 'A', workspace: '/w' })); // Mars
    expect(chooseBody(log, { kind: 'planet' })).toMatchObject({ body: { id: 'b-jupiter' } });
  });

  it('refuses when no planet is free, listing every occupied planet and its occupant', () => {
    const { log, run } = world();
    const made = Array.from(
      { length: 7 },
      (_, i) => run((ctx) => createProject(ctx, { name: `P${i}`, workspace: '/w' })).value,
    );
    run((ctx) => closeProject(ctx, made[0]!.id, USER)); // completed, still on Mars
    const choice = chooseBody(log, { kind: 'planet' });
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.reason).toBe('no_free_planet');
    expect(choice.occupied.map((o) => o.bodyName)).toEqual([
      'Mercury',
      'Venus',
      'Mars',
      'Jupiter',
      'Saturn',
      'Uranus',
      'Neptune',
    ]);
    expect(choice.occupied[2]).toEqual({
      bodyId: 'b-mars',
      bodyName: 'Mars',
      host: { kind: 'project', id: made[0]!.id },
      occupant: 'P0',
      state: 'completed',
    });
    expect(choice.occupied.map((o) => o.bodyId)).not.toContain(EARTH_ID);
    expect(() => run((ctx) => createProject(ctx, { name: 'X', workspace: '/w' }))).toThrow(
      /no free planet — occupied: Mercury: P5 \(approved\);.*Mars: P0 \(completed\)/,
    );
  });

  it('lists a planet that only shows a "moved to" marker among the occupied ones', () => {
    const { log, run } = world();
    const made = Array.from(
      { length: 6 },
      (_, i) => run((ctx) => createProject(ctx, { name: `P${i}`, workspace: '/w' })).value,
    );
    const mercuryProject = made.find((p) => p.bodyId === 'b-mercury')!;
    run((ctx) => moveHost(ctx, { kind: 'project', id: mercuryProject.id }, 'b-venus'));
    const choice = chooseBody(log, { kind: 'planet' });
    if (choice.ok) throw new Error('expected no free planet');
    expect(choice.occupied[0]).toEqual({
      bodyId: 'b-mercury',
      bodyName: 'Mercury',
      movedTo: {
        bodyId: 'b-venus',
        host: { kind: 'project', id: mercuryProject.id },
        at: expect.any(String),
      },
    });
  });

  it('puts a sub-project on a free moon of its parent’s planet, or says there is none', () => {
    const { log, run } = world();
    const planet = run((ctx) => createProject(ctx, { name: 'A', workspace: '/w' })).value; // Mars
    const req = { kind: 'moon', parentProjectId: planet.id } as const;
    expect(chooseBody(log, req)).toMatchObject({ body: { id: 'b-phobos' } });
    const sub = (name: string) =>
      run((ctx) => createProject(ctx, { name, workspace: '/w', parentProjectId: planet.id })).value;
    expect(sub('S1').bodyId).toBe('b-phobos');
    expect(sub('S2').bodyId).toBe('b-deimos');
    const none = chooseBody(log, req);
    expect(none).toMatchObject({ ok: false, reason: 'no_free_moon', planetId: 'b-mars' });
    if (!none.ok) expect(none.occupied.map((o) => o.occupant)).toEqual(['S1', 'S2']);
    // the other planets' moons are never used for a sub-project: it stays a task on the planet
    expect(() => sub('S3')).toThrow(/no free moon/);
  });

  it('refuses a sub-project whose parent does not live on a planet', () => {
    const { log, run } = world();
    const onMoon = run((ctx) =>
      createProject(ctx, { name: 'Small', workspace: '/w', kind: 'moon' }),
    ).value;
    expect(() => chooseBody(log, { kind: 'moon', parentProjectId: onMoon.id })).toThrow(
      /moon of its parent's planet; Small is on Phobos/,
    );
    expect(() => chooseBody(log, { kind: 'moon', parentProjectId: 'p-x' })).toThrow(/no project/);
  });

  it('puts an independent project on a moon of a Waykeeper-less planet first', () => {
    const { log, run } = world();
    const mars = run((ctx) => createProject(ctx, { name: 'A', workspace: '/w' })).value;
    // Mars hosts a project but no Waykeeper yet: its moons are still preferred
    expect(chooseBody(log, { kind: 'moon' })).toMatchObject({ body: { id: 'b-phobos' } });
    const wk = run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: CAPS,
        bodyId: mars.bodyId,
        projectId: mars.id,
      }),
    ).value;
    expect(chooseBody(log, { kind: 'moon' })).toMatchObject({ body: { id: 'b-io' } });
    // a Waykeeper that no longer runs does not count (the status store says so)
    expect(chooseBody(log, { kind: 'moon' }, { isRunning: (id) => id !== wk.id })).toMatchObject({
      body: { id: 'b-phobos' },
    });
    // nor does the Waykeeper of a finished project
    run((ctx) => closeProject(ctx, mars.id, USER));
    expect(chooseBody(log, { kind: 'moon' })).toMatchObject({ body: { id: 'b-phobos' } });
  });

  it('takes any free moon when every planet with a free moon has a Waykeeper', () => {
    const { log, run } = world();
    for (const bodyId of ['b-mars', 'b-jupiter', 'b-saturn', 'b-uranus', 'b-neptune']) {
      const p = run((ctx) => createProject(ctx, { name: bodyId, workspace: '/w', bodyId })).value;
      run((ctx) =>
        createAgent(ctx, {
          role: 'waykeeper',
          runtime: 'fake',
          caps: CAPS,
          bodyId,
          projectId: p.id,
        }),
      );
    }
    expect(chooseBody(log, { kind: 'moon' })).toMatchObject({ body: { id: 'b-phobos' } });
  });

  it('never assigns a reserved body, even when nothing else is left', () => {
    const { log, run } = world();
    for (const moon of freeMoons(log)) {
      run((ctx) => createProject(ctx, { name: moon.name, workspace: '/w', bodyId: moon.id }));
    }
    expect(chooseBody(log, { kind: 'moon' })).toMatchObject({ ok: false, reason: 'no_free_moon' });
    const t = run((ctx) => createTask(ctx, { description: 'x' })).value;
    for (const id of [SUN_ID, EARTH_ID, MOON_ID]) {
      expect(() =>
        run((ctx) => createProject(ctx, { name: 'X', workspace: '/w', bodyId: id })),
      ).toThrow(/reserved/);
      expect(() => run((ctx) => moveHost(ctx, { kind: 'task', id: t.id }, id))).toThrow(/reserved/);
    }
  });
});

describe('procedural asteroids', () => {
  it('derive id, name and orbit from their number alone', () => {
    expect(asteroidSpec(7)).toEqual(asteroidSpec(7));
    const belt = Array.from({ length: 200 }, (_, i) => asteroidSpec(i + 1));
    expect(new Set(belt.map((a) => a.id)).size).toBe(200);
    expect(new Set(belt.map((a) => a.name)).size).toBe(200);
    expect(belt[0]!.name).toMatch(/^\(1\) [A-Z][a-z]+$/);
    for (const a of belt) {
      expect(a.meta.orbit.radius).toBeGreaterThanOrEqual(2.2);
      expect(a.meta.orbit.radius).toBeLessThanOrEqual(3.3);
    }
  });

  it('are created on demand for standalone tasks, numbered in order, announced with body.created', () => {
    const { run, tables } = world();
    const a = run((ctx) => createTask(ctx, { description: 'a' }));
    const b = run((ctx) => createTask(ctx, { description: 'b' }));
    expect(a.value.bodyId).toBe('b-asteroid-1');
    expect(b.value.bodyId).toBe('b-asteroid-2');
    const spec = asteroidSpec(1);
    expect(a.events[0]).toEqual({
      type: 'body.created',
      body: { id: spec.id, kind: 'asteroid', name: spec.name, meta: spec.meta },
    });
    expect(tables.bodies.get('b-asteroid-2')?.host).toEqual({ kind: 'task', id: b.value.id });
    // an agent spawned without a body gets one too (the Phase 1 console)
    const agent = run((ctx) =>
      createAgent(ctx, { role: 'steward', runtime: 'fake', caps: CAPS }),
    ).value;
    expect(agent.bodyId).toBe('b-asteroid-3');
  });
});

describe('"moved to …" markers (decision 15)', () => {
  it('a moved project leaves a marker; the body is not assignable until the sweep frees it', () => {
    const { run, tables, clock } = world();
    const p = run((ctx) => createProject(ctx, { name: 'A', workspace: '/w' })).value; // Mars
    run((ctx) => moveHost(ctx, { kind: 'project', id: p.id }, 'b-jupiter'));
    const at = tables.projects.get(p.id)!.updatedAt; // the move's clock reading
    expect(tables.bodies.get('b-mars')?.movedTo).toEqual({
      bodyId: 'b-jupiter',
      host: { kind: 'project', id: p.id },
      at,
    });
    const other = run((ctx) => createTask(ctx, { description: 'x' })).value;
    expect(() =>
      run((ctx) => createProject(ctx, { name: 'B', workspace: '/w', bodyId: 'b-mars' })),
    ).toThrow(/moved to b-jupiter/);
    expect(() => run((ctx) => assignBody(ctx, 'b-mars', { kind: 'task', id: other.id }))).toThrow();

    // the sweep frees nothing before the retention period has passed …
    clock.advance(DEFAULT_RETENTION_MS - 60_000);
    expect(run((ctx) => sweepMarkers(ctx)).events).toEqual([]);
    // … and the marked body once it has
    clock.advance(120_000);
    const swept = run((ctx) => sweepMarkers(ctx));
    expect(swept.events).toEqual([{ type: 'body.freed', bodyId: 'b-mars' }]);
    expect(tables.bodies.get('b-mars')).toEqual({
      id: 'b-mars',
      kind: 'planet',
      name: 'Mars',
      meta: { orbit: 4 },
    });
    expect(run((ctx) => sweepMarkers(ctx)).events).toEqual([]);
    expect(
      run((ctx) => createProject(ctx, { name: 'B', workspace: '/w', bodyId: 'b-mars' })).value
        .bodyId,
    ).toBe('b-mars');
  });

  it('a configurable retention, and freeBody clears a marker early', () => {
    const { run, tables, clock } = world();
    const p = run((ctx) => createProject(ctx, { name: 'A', workspace: '/w' })).value;
    const t = run((ctx) => createTask(ctx, { description: 'joins' })).value;
    const s = run((ctx) => createTask(ctx, { description: 'joins too' })).value;
    run((ctx) => moveTask(ctx, t.id, p.id, USER));
    run((ctx) => moveTask(ctx, s.id, p.id, USER));
    expect(tables.bodies.get(t.bodyId)?.movedTo?.bodyId).toBe(p.bodyId);
    expect(run((ctx) => freeBody(ctx, t.bodyId)).types).toEqual(['body.freed']);
    expect(tables.bodies.get(t.bodyId)?.movedTo).toBeUndefined();
    clock.advance(2 * DAY);
    expect(run((ctx) => sweepMarkers(ctx, 3 * DAY)).events).toEqual([]);
    expect(run((ctx) => sweepMarkers(ctx, DAY)).events).toEqual([
      { type: 'body.freed', bodyId: s.bodyId },
    ]);
  });

  it('archiving the work that moved does not touch the marker it left', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, { name: 'A', workspace: '/w' })).value;
    run((ctx) => moveHost(ctx, { kind: 'project', id: p.id }, 'b-jupiter'));
    run((ctx) => closeProject(ctx, p.id, USER));
    expect(run((ctx) => archiveProject(ctx, p.id, USER)).types).toEqual([
      'project.state_changed',
      'body.freed',
    ]);
    expect(tables.bodies.get('b-jupiter')?.host).toBeUndefined();
    expect(tables.bodies.get('b-mars')?.movedTo?.bodyId).toBe('b-jupiter');
  });
});

describe('the catalogue through DomainCommands', () => {
  const lives: ComposedRuntime[] = [];
  afterEach(async () => {
    for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  });

  it('answers freePlanets / freeMoons / chooseBody and counts only running Waykeepers', async () => {
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [new FakeAdapter({ speed: 1 })],
      flushMs: 10,
    });
    lives.push(composed);
    const { commands, statuses } = composed;
    expect(ids(await commands.freePlanets())).toContain('b-mars');
    expect(ids(await commands.freeMoons('b-mars'))).toEqual(['b-phobos', 'b-deimos']);
    const mars = (await commands.createProject({ name: 'A', workspace: '/w/a' })).value;
    expect(ids(await commands.freePlanets())).not.toContain('b-mars');
    const harmonizer = await spawnHarmonizer(commands);
    const wk = await spawnWaykeeper(commands, mars.id, harmonizer.id, 'scenario:long');
    expect(await commands.chooseBody({ kind: 'moon' })).toMatchObject({ body: { id: 'b-io' } });
    await commands.stopAgent(wk.id, USER);
    const end = Date.now() + 3000;
    while (statuses.get(wk.id)?.state !== 'stopped' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await commands.chooseBody({ kind: 'moon' })).toMatchObject({
      body: { id: 'b-phobos' },
    });
    // createProject follows the same choice
    const small = (await commands.createProject({ name: 'S', workspace: '/w/s', kind: 'moon' }))
      .value;
    expect(small.bodyId).toBe('b-phobos');
    expect((await commands.sweepMarkers()).events).toEqual([]);
  });
});
