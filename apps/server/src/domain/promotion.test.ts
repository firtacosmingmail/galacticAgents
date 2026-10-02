import { describe, expect, it } from 'vitest';
import { proposalPromotion, type AgentRole, type Id } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { EARTH_ID } from './catalogue.js';
import { createProject } from './projects.js';
import { createProposal } from './proposals.js';
import { carriedOut, isPromotion, moveProject, recordPromotion, transferTask } from './promotion.js';
import { createTask } from './tasks.js';

/** The transactional steps of a promotion (P2-12). */

const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

function setup() {
  const w = world();
  const agent = (role: AgentRole, place: Record<string, Id | undefined>) =>
    w.run((ctx) =>
      createAgent(ctx, {
        role,
        runtime: 'fake',
        caps: CAPS,
        ...(role === 'harmonizer' ? { bodyId: EARTH_ID } : {}),
        ...Object.fromEntries(Object.entries(place).filter(([, v]) => v)),
      }),
    ).value;
  const harmonizer = agent('harmonizer', {});
  const planet = w.run((ctx) =>
    createProject(ctx, { name: 'App', workspace: '/w/app', bodyId: 'b-saturn' }),
  ).value;
  const planetWk = agent('waykeeper', { projectId: planet.id, supervisorId: harmonizer.id });
  return { ...w, agent, harmonizer, planet, planetWk };
}

describe('transferTask', () => {
  it("moves a project task into another project and hands its Steward to that project's Waykeeper", () => {
    const { run, tables, agent, planet, planetWk } = setup();
    const task = run((ctx) => createTask(ctx, { projectId: planet.id, description: 'auth' })).value;
    const steward = agent('steward', {
      taskId: task.id,
      projectId: planet.id,
      supervisorId: planetWk.id,
      bodyId: planet.bodyId,
    });
    const sub = run((ctx) =>
      createProject(ctx, { name: 'Auth', workspace: '/w/app', parentProjectId: planet.id }),
    ).value;
    const subWk = agent('waykeeper', { projectId: sub.id, supervisorId: planetWk.id });
    const { events } = run((ctx) => transferTask(ctx, task.id, sub.id));
    expect(events).toEqual([
      {
        type: 'task.updated',
        taskId: task.id,
        changes: { projectId: sub.id, bodyId: sub.bodyId },
      },
      { type: 'agent.updated', agentId: steward.id, changes: { bodyId: sub.bodyId } },
      {
        type: 'agent.updated',
        agentId: steward.id,
        changes: { supervisorId: subWk.id, projectId: sub.id },
      },
    ]);
    // The planet still hosts its project: no marker.
    expect(tables.bodies.get(planet.bodyId)).toMatchObject({
      host: { kind: 'project', id: planet.id },
    });
    expect(tables.bodies.get(planet.bodyId)?.movedTo).toBeUndefined();
    // Again: nothing to do.
    expect(run((ctx) => transferTask(ctx, task.id, sub.id)).events).toEqual([]);
  });

  it('refuses a standalone task and a target without a Waykeeper for its Steward', () => {
    const { run, tables, agent, planet, planetWk } = setup();
    const loose = run((ctx) => createTask(ctx, { description: 'x' })).value;
    expect(() => run((ctx) => transferTask(ctx, loose.id, planet.id))).toThrow(/move it instead/);
    const task = run((ctx) => createTask(ctx, { projectId: planet.id, description: 'auth' })).value;
    agent('steward', { taskId: task.id, projectId: planet.id, supervisorId: planetWk.id });
    const other = run((ctx) => createProject(ctx, { name: 'Other', workspace: '/w/o' })).value;
    expect(() => run((ctx) => transferTask(ctx, task.id, other.id))).toThrow(/has no Waykeeper/);
    expect(tables.tasks.get(task.id)?.projectId).toBe(planet.id);
  });
});

describe('moveProject', () => {
  it('detaches a sub-project leaving its planet and hands its Waykeeper to the Harmonizer', () => {
    const { run, tables, agent, harmonizer, planet, planetWk } = setup();
    const sub = run((ctx) =>
      createProject(ctx, { name: 'Docs', workspace: '/w/docs', parentProjectId: planet.id }),
    ).value;
    const subWk = agent('waykeeper', {
      projectId: sub.id,
      supervisorId: planetWk.id,
      bodyId: sub.bodyId,
    });
    const { types } = run((ctx) => moveProject(ctx, sub.id, 'b-jupiter'));
    expect(types).toEqual([
      'project.updated', // parentProjectId: null
      'agent.updated', // the Waykeeper → the Harmonizer
      'body.moved',
      'project.updated', // bodyId
      'agent.updated', // the Waykeeper flies
    ]);
    expect(tables.projects.get(sub.id)).toMatchObject({ bodyId: 'b-jupiter' });
    expect(tables.projects.get(sub.id)?.parentProjectId).toBeUndefined();
    expect(tables.agents.get(subWk.id)).toMatchObject({
      supervisorId: harmonizer.id,
      bodyId: 'b-jupiter',
    });
    expect(tables.bodies.get(sub.bodyId)?.movedTo?.bodyId).toBe('b-jupiter');
  });

  it('keeps a project with sub-project moons where it is', () => {
    const { run, planet } = setup();
    run((ctx) =>
      createProject(ctx, { name: 'Docs', workspace: '/w/docs', parentProjectId: planet.id }),
    );
    expect(() => run((ctx) => moveProject(ctx, planet.id, 'b-jupiter'))).toThrow(/sub-projects/);
  });
});

describe('promotion cards', () => {
  it('reads both card shapes and records the outcome once', () => {
    const { run, tables } = setup();
    const base = {
      requestText: 'promote',
      kind: 'moon' as const,
      proposedBody: { kind: 'moon' as const, name: 'x' },
      workspace: '/w/x',
      rationale: 'r',
    };
    const harmonizerCard = run((ctx) =>
      createProposal(ctx, {
        ...base,
        meta: {
          request: {
            type: 'promotion',
            name: 'X',
            target: { kind: 'task', id: 't-1' },
            fromBodyId: 'b-asteroid-1',
          },
        },
      }),
    ).value;
    const waykeeperCard = run((ctx) =>
      createProposal(ctx, {
        ...base,
        meta: { promotion: { taskId: 't-2', fromProjectId: 'p-1', requestedBy: 'a-1' } },
      }),
    ).value;
    const plain = run((ctx) => createProposal(ctx, base)).value;
    expect(proposalPromotion(harmonizerCard)).toEqual({
      target: { kind: 'task', id: 't-1' },
      name: 'X',
      fromBodyId: 'b-asteroid-1',
    });
    expect(proposalPromotion(waykeeperCard)).toEqual({
      target: { kind: 'task', id: 't-2' },
      fromProjectId: 'p-1',
      requestedBy: 'a-1',
    });
    expect(isPromotion(plain)).toBe(false);

    const outcome = { ok: true, target: { kind: 'task' as const, id: 't-1' } };
    expect(run((ctx) => recordPromotion(ctx, harmonizerCard.id, outcome)).events).toEqual([
      { type: 'promotion.carried_out', proposalId: harmonizerCard.id, outcome },
    ]);
    expect(carriedOut(tables.proposals.get(harmonizerCard.id))).toEqual(outcome);
    expect(
      run((ctx) => recordPromotion(ctx, harmonizerCard.id, { ...outcome, ok: false })).events,
    ).toEqual([]);
    expect(() => run((ctx) => recordPromotion(ctx, plain.id, outcome))).toThrow(/not a promotion/);
  });
});
