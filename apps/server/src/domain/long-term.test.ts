import { describe, expect, it } from 'vitest';
import { proposalParking, type Actor, type CreateProposalInput, type Id } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { moveHost } from './bodies.js';
import { EARTH_ID, chooseBody, freeBigPlanets, isBigPlanet } from './catalogue.js';
import { DomainError } from './errors.js';
import { archiveProject, closeProject, createProject, setLongTerm } from './projects.js';
import { createProposal, decideProposal } from './proposals.js';
import { openQuestion } from './questions.js';
import { createTask } from './tasks.js';

/**
 * P10-02 — long-term projects (SPEC decision 142): placed on a big planet (else a planet with
 * moons, never a moonless one), converted with `setLongTerm` (moving when needed, satellites
 * following, in one transaction), never moved away from their areas, and created or converted by
 * approving a `meta.longTerm` card.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const LONG_TERM = { purpose: 'Grow the app', goals: ['1000 users', 'weekly releases'] };

function setup() {
  const w = world();
  const make = (name: string, bodyId?: Id, extra: Record<string, unknown> = {}) =>
    w.run((ctx) =>
      createProject(ctx, {
        name,
        workspace: `/w/${name}`,
        ...(bodyId ? { bodyId } : {}),
        ...extra,
      }),
    ).value;
  const err = (fn: () => unknown): DomainError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  return { ...w, make, err };
}

describe('big planets (BIG_PLANET_MIN_MOONS)', () => {
  it('are Jupiter, Saturn and Uranus, counted from the catalogue', () => {
    const { log, tables } = setup();
    const big = tables.bodies
      .all()
      .filter((b) => isBigPlanet(log, b))
      .map((b) => b.id)
      .sort();
    expect(big).toEqual(['b-jupiter', 'b-saturn', 'b-uranus']);
    expect(freeBigPlanets(log).map((b) => b.id)).toEqual(['b-jupiter', 'b-saturn', 'b-uranus']);
  });
});

describe('creating a long-term project', () => {
  it('lands on Jupiter on an empty catalogue and stores its purpose and goals', () => {
    const { make, tables, log } = setup();
    expect(chooseBody(log, { kind: 'planet', longTerm: true })).toMatchObject({
      ok: true,
      body: { id: 'b-jupiter' },
    });
    const p = make('App', undefined, { longTerm: LONG_TERM });
    expect(p).toMatchObject({ bodyId: 'b-jupiter', longTerm: true, ...LONG_TERM });
    expect(tables.projects.get(p.id)).toMatchObject({ longTerm: true, ...LONG_TERM });
  });

  it('takes a planet with moons when the big planets are taken — never Mercury or Venus', () => {
    const { make } = setup();
    for (const id of ['b-jupiter', 'b-saturn', 'b-uranus']) make(id, id);
    expect(make('App', undefined, { longTerm: LONG_TERM }).bodyId).toBe('b-mars');
    expect(make('App 2', undefined, { longTerm: LONG_TERM }).bodyId).toBe('b-neptune');
  });

  it('is refused with no_planet_with_moons when every moon-bearing planet is taken', () => {
    const { make, log, err, tables } = setup();
    for (const id of ['b-mars', 'b-jupiter', 'b-saturn', 'b-uranus', 'b-neptune']) make(id, id);
    const choice = chooseBody(log, { kind: 'planet', longTerm: true });
    expect(choice).toMatchObject({ ok: false, reason: 'no_planet_with_moons' });
    if (!choice.ok) expect(choice.occupied.map((o) => o.bodyName)).toContain('Saturn');
    const before = tables.projects.all().length;
    const e = err(() => make('App', undefined, { longTerm: LONG_TERM }));
    expect(e.code).toBe('conflict');
    expect(e.message).toMatch(/^no free planet with moons — occupied: /);
    expect(tables.projects.all()).toHaveLength(before);
    // Mercury and Venus are still free: an ordinary project takes one
    expect(make('Small').bodyId).toBe('b-mercury');
  });

  it('refuses a moon, a moonless planet, a sub-project and limits out of range', () => {
    const { make, err } = setup();
    const parent = make('Parent', 'b-mars');
    expect(err(() => make('M', undefined, { kind: 'moon', longTerm: LONG_TERM })).code).toBe(
      'invalid',
    );
    expect(err(() => make('V', 'b-venus', { longTerm: LONG_TERM })).message).toMatch(
      /planet with moons.*not on Venus/,
    );
    expect(
      err(() => make('S', undefined, { parentProjectId: parent.id, longTerm: LONG_TERM })).message,
    ).toMatch(/sub-project cannot become long-term/);
    expect(err(() => make('E', undefined, { longTerm: { purpose: ' ', goals: [] } })).code).toBe(
      'invalid',
    );
    const goals = Array.from({ length: 11 }, (_, i) => `goal ${i}`);
    expect(err(() => make('G', undefined, { longTerm: { purpose: 'x', goals } })).code).toBe(
      'invalid',
    );
    expect(
      err(() => make('L', undefined, { longTerm: { purpose: 'x', goals: ['y'.repeat(301)] } }))
        .code,
    ).toBe('invalid');
  });
});

describe('setLongTerm (converting a project)', () => {
  /** A project on `bodyId` with its Waykeeper and the Steward of one of its tasks. */
  function staffed(s: ReturnType<typeof setup>, bodyId: Id) {
    const project = s.make('Shop', bodyId);
    const task = s.run((ctx) =>
      createTask(ctx, { description: 'checkout', projectId: project.id }),
    ).value;
    const wk = s.run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: CAPS,
        bodyId,
        projectId: project.id,
      }),
    ).value;
    const st = s.run((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        bodyId,
        projectId: project.id,
        taskId: task.id,
        supervisorId: wk.id,
      }),
    ).value;
    return { project, task, agents: [wk.id, st.id] };
  }

  it('moves a project on Mars to the free big planet, satellites following, in one transaction', () => {
    const s = setup();
    s.make('Taken', 'b-jupiter');
    const { project, task, agents } = staffed(s, 'b-mars');
    const out = s.run((ctx) => setLongTerm(ctx, { projectId: project.id, ...LONG_TERM, by: USER }));
    expect(out.value).toMatchObject({ bodyId: 'b-saturn', longTerm: true, ...LONG_TERM });
    expect(out.events[0]).toEqual({
      type: 'project.updated',
      projectId: project.id,
      changes: { longTerm: true, ...LONG_TERM },
    });
    expect(out.types).toContain('body.moved');
    for (const id of agents) {
      expect(out.events).toContainEqual({
        type: 'agent.updated',
        agentId: id,
        changes: { bodyId: 'b-saturn' },
      });
      expect(s.tables.agents.get(id)?.bodyId).toBe('b-saturn');
    }
    expect(s.tables.tasks.get(task.id)?.bodyId).toBe('b-saturn');
    expect(s.tables.bodies.get('b-saturn')?.host).toEqual({ kind: 'project', id: project.id });
    expect(s.tables.bodies.get('b-mars')?.movedTo?.bodyId).toBe('b-saturn');
  });

  it('stays on Mars when no big planet is free', () => {
    const s = setup();
    for (const id of ['b-jupiter', 'b-saturn', 'b-uranus']) s.make(id, id);
    const { project } = staffed(s, 'b-mars');
    const out = s.run((ctx) => setLongTerm(ctx, { projectId: project.id, ...LONG_TERM, by: USER }));
    expect(out.value).toMatchObject({ bodyId: 'b-mars', longTerm: true });
    expect(out.types).toEqual(['project.updated']);
  });

  it('moves a project on a moon or a moonless planet to the first free planet with moons', () => {
    const s = setup();
    for (const id of ['b-jupiter', 'b-saturn', 'b-uranus']) s.make(id, id);
    const onIo = s.make('Moon work', 'b-io');
    expect(
      s.run((ctx) => setLongTerm(ctx, { projectId: onIo.id, ...LONG_TERM, by: USER })).value.bodyId,
    ).toBe('b-mars');
    const onVenus = s.make('Venus work', 'b-venus');
    expect(
      s.run((ctx) => setLongTerm(ctx, { projectId: onVenus.id, ...LONG_TERM, by: USER })).value
        .bodyId,
    ).toBe('b-neptune');
  });

  it('refuses a project on Venus when no planet with moons is free, leaving it unchanged', () => {
    const s = setup();
    for (const id of ['b-mars', 'b-jupiter', 'b-saturn', 'b-uranus', 'b-neptune']) s.make(id, id);
    const p = s.make('Venus work', 'b-venus');
    const before = s.tables.projects.get(p.id);
    const e = s.err(() =>
      s.run((ctx) => setLongTerm(ctx, { projectId: p.id, ...LONG_TERM, by: USER })),
    );
    expect(e.code).toBe('conflict');
    expect(e.message).toBe('No planet with moons is free; Venus work stays as it is until one is.');
    expect(s.tables.projects.get(p.id)).toEqual(before);
    expect(s.tables.projects.get(p.id)?.longTerm).toBeUndefined();
  });

  it('refuses a sub-project and a finished project', () => {
    const s = setup();
    const parent = s.make('Big app', 'b-mars');
    const sub = s.make('Docs', 'b-phobos', { parentProjectId: parent.id });
    const e = s.err(() =>
      s.run((ctx) => setLongTerm(ctx, { projectId: sub.id, ...LONG_TERM, by: USER })),
    );
    expect(e).toMatchObject({
      code: 'invalid',
      message: 'a part of Big app cannot become long-term on its own',
    });
    const done = s.make('Done', 'b-venus');
    s.run((ctx) => closeProject(ctx, done.id, USER));
    expect(
      s.err(() => s.run((ctx) => setLongTerm(ctx, { projectId: done.id, ...LONG_TERM, by: USER })))
        .code,
    ).toBe('invalid_transition');
  });

  it('keeps a parent with sub-projects on its planet (their moons)', () => {
    const s = setup();
    const parent = s.make('Big app', 'b-mars');
    s.make('Docs', 'b-phobos', { parentProjectId: parent.id });
    const out = s.run((ctx) => setLongTerm(ctx, { projectId: parent.id, ...LONG_TERM, by: USER }));
    expect(out.value.bodyId).toBe('b-mars');
    expect(out.types).toEqual(['project.updated']);
  });

  it('ends a closure flow under way: the open question withdrawn, the request dropped', () => {
    const s = setup();
    for (const id of ['b-jupiter', 'b-saturn', 'b-uranus']) s.make(id, id);
    const p = s.make('Shop', 'b-mars', { meta: { proposalId: 'pr-1' } });
    const hq = s.run((ctx) =>
      createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: CAPS, bodyId: EARTH_ID }),
    ).value;
    s.run((ctx) =>
      openQuestion(ctx, {
        id: 'q-closure',
        kind: 'clarification',
        originAgentId: hq.id,
        context: { text: 'Anything else on Shop?', options: ['Close Shop', 'Something else: …'] },
      }),
    );
    const request = { by: 'a-wk', summary: 'done', tasks: 1, questionId: 'q-closure' };
    s.run((ctx) => {
      const row = ctx.tables.projects.get(p.id)!;
      ctx.tables.projects.upsert({ ...row, meta: { ...row.meta, closureRequest: request } });
    });
    const out = s.run((ctx) => setLongTerm(ctx, { projectId: p.id, ...LONG_TERM, by: USER }));
    expect(s.tables.questions.get('q-closure')?.status).toBe('cancelled');
    expect(out.events).toContainEqual({
      type: 'project.updated',
      projectId: p.id,
      changes: { longTerm: true, ...LONG_TERM, meta: { proposalId: 'pr-1' } },
    });
    expect(s.tables.projects.get(p.id)?.meta).toEqual({ proposalId: 'pr-1' });
  });

  it('only edits the purpose and goals of an already long-term project', () => {
    const s = setup();
    const p = s.make('App', undefined, { longTerm: LONG_TERM });
    s.make('Taken', 'b-saturn');
    const out = s.run((ctx) =>
      setLongTerm(ctx, { projectId: p.id, purpose: 'Grow it more', goals: [], by: USER }),
    );
    expect(out.events).toEqual([
      {
        type: 'project.updated',
        projectId: p.id,
        changes: { purpose: 'Grow it more', goals: [] },
      },
    ]);
    expect(out.value).toMatchObject({ bodyId: 'b-jupiter', longTerm: true, goals: [] });
  });
});

describe('moveHost and areas', () => {
  it('refuses moving a long-term project that has an area', () => {
    const s = setup();
    const p = s.make('App', undefined, { longTerm: LONG_TERM });
    // Ruling R1: the area row is inserted directly (domain area creation comes in P10-03).
    s.tables.areas.insert({
      id: 'ar-1',
      projectId: p.id,
      name: 'Feedback',
      bodyId: 'b-io',
      createdAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    });
    const e = s.err(() => s.run((ctx) => moveHost(ctx, { kind: 'project', id: p.id }, 'b-saturn')));
    expect(e).toMatchObject({
      code: 'invalid',
      message: 'a long-term project with areas stays on its planet',
    });
    expect(s.tables.projects.get(p.id)?.bodyId).toBe('b-jupiter');
    // without areas it moves like any project
    const q = s.make('Other', undefined, { longTerm: LONG_TERM });
    s.run((ctx) => moveHost(ctx, { kind: 'project', id: q.id }, 'b-uranus'));
    expect(s.tables.projects.get(q.id)?.bodyId).toBe('b-uranus');
  });
});

describe('long-term cards (Proposal.meta.longTerm)', () => {
  const card = (name: string, extra: Record<string, unknown> = {}): CreateProposalInput => ({
    requestText: `Build ${name}`,
    kind: 'planet',
    proposedBody: { kind: 'planet', name },
    workspace: `/w/${name.toLowerCase()}`,
    rationale: 'looked after over months',
    meta: { request: { type: 'new_project', name }, longTerm: LONG_TERM, ...extra },
  });

  it('approving a new long-term card creates a long-term project on a big planet', () => {
    const s = setup();
    const p = s.run((ctx) => createProposal(ctx, card('App'))).value;
    s.run((ctx) => decideProposal(ctx, p.id, { decision: 'approve' }, USER));
    const [project] = s.tables.projects.all();
    expect(project).toMatchObject({
      name: 'App',
      bodyId: 'b-jupiter',
      longTerm: true,
      ...LONG_TERM,
    });
  });

  it('approving a card with a projectId converts that project', () => {
    const s = setup();
    const shop = s.make('Shop', 'b-mars');
    const p = s.run((ctx) =>
      createProposal(ctx, {
        requestText: 'Make Shop long-term',
        kind: 'planet',
        proposedBody: { kind: 'planet', name: 'Shop' },
        workspace: '/w/Shop',
        rationale: 'looked after over months',
        meta: { longTerm: { projectId: shop.id, ...LONG_TERM } },
      }),
    ).value;
    expect(p.state).toBe('pending');
    s.run((ctx) => decideProposal(ctx, p.id, { decision: 'approve' }, USER));
    expect(s.tables.projects.all()).toHaveLength(1);
    expect(s.tables.projects.get(shop.id)).toMatchObject({
      bodyId: 'b-jupiter',
      longTerm: true,
      ...LONG_TERM,
    });
    expect(s.tables.proposals.get(p.id)?.state).toBe('approved');
  });

  it('parks a new long-term card when no planet with moons is free, and un-parks when one frees', () => {
    const s = setup();
    const taken = ['b-mars', 'b-jupiter', 'b-saturn', 'b-uranus', 'b-neptune'].map((id) =>
      s.make(id, id),
    );
    const p = s.run((ctx) => createProposal(ctx, card('App'))).value;
    expect(p.state).toBe('parked');
    expect(proposalParking(p)).toMatchObject({ waitingFor: 'planet' });
    expect(proposalParking(p)?.reason).toMatch(/no free planet with moons/);
    // A free moonless planet does not let it in
    const venus = s.make('Venus work', 'b-venus');
    s.run((ctx) => closeProject(ctx, venus.id, USER));
    s.run((ctx) => archiveProject(ctx, venus.id, USER));
    expect(s.tables.proposals.get(p.id)?.state).toBe('parked');
    // Neptune frees: the card proposes it
    const neptune = taken[4]!;
    s.run((ctx) => closeProject(ctx, neptune.id, USER));
    s.run((ctx) => archiveProject(ctx, neptune.id, USER));
    expect(s.tables.proposals.get(p.id)).toMatchObject({
      state: 'pending',
      proposedBody: { bodyId: 'b-neptune' },
    });
    s.run((ctx) => decideProposal(ctx, p.id, { decision: 'approve' }, USER));
    expect(s.tables.projects.all().find((x) => x.name === 'App')).toMatchObject({
      bodyId: 'b-neptune',
      longTerm: true,
    });
  });
});
