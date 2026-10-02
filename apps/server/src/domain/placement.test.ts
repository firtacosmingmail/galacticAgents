import { describe, expect, it } from 'vitest';
import type { Actor, AgentRole, Id } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent, updateAgent } from './agents.js';
import { EARTH_ID } from './catalogue.js';
import { createProject } from './projects.js';
import { createTask, moveTask } from './tasks.js';

/**
 * The placement invariants `updateAgent` keeps (P2-20; SPEC §2, decision 6): the Harmonizer has
 * no supervisor and stays on Earth; a Waykeeper answers to the Harmonizer, or to the parent
 * project's Waykeeper for a sub-project; a project Steward to its project's Waykeeper, an asteroid
 * Steward to the Harmonizer; a Steward's project is its task's.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

function hierarchy() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w/csv' })).value;
  const sub = w.run((ctx) =>
    createProject(ctx, { name: 'Sub', workspace: '/w/sub', parentProjectId: project.id }),
  ).value;
  const other = w.run((ctx) => createProject(ctx, { name: 'Other', workspace: '/w/o' })).value;
  const task = (projectId?: Id) =>
    w.run((ctx) => createTask(ctx, { description: 'work', ...(projectId ? { projectId } : {}) }))
      .value;
  const tasks = { a: task(project.id), b: task(project.id), sub: task(sub.id), asteroid: task() };
  const agent = (
    role: AgentRole,
    place: { supervisorId?: Id; taskId?: Id; projectId?: Id; bodyId?: Id } = {},
  ) =>
    w.run((ctx) =>
      createAgent(ctx, {
        role,
        runtime: 'fake',
        caps: CAPS,
        ...Object.fromEntries(Object.entries(place).filter(([, v]) => v)),
      }),
    ).value;
  const harmonizer = agent('harmonizer', { bodyId: EARTH_ID });
  const waykeeper = agent('waykeeper', { projectId: project.id, supervisorId: harmonizer.id });
  const subWaykeeper = agent('waykeeper', { projectId: sub.id, supervisorId: waykeeper.id });
  const otherWaykeeper = agent('waykeeper', { projectId: other.id, supervisorId: harmonizer.id });
  const steward = agent('steward', {
    taskId: tasks.a.id,
    projectId: project.id,
    supervisorId: waykeeper.id,
  });
  const asteroidSteward = agent('steward', {
    taskId: tasks.asteroid.id,
    supervisorId: harmonizer.id,
  });
  return {
    ...w,
    agent,
    project,
    sub,
    other,
    tasks,
    harmonizer,
    waykeeper,
    subWaykeeper,
    otherWaykeeper,
    steward,
    asteroidSteward,
  };
}

describe('updateAgent', () => {
  it('re-parents an agent with agent.updated, dropping unchanged fields', () => {
    const { run, tables, agent, project, harmonizer, waykeeper, subWaykeeper, steward } =
      hierarchy();
    // A second Waykeeper of the same project (a replacement) takes the Steward over.
    const next = agent('waykeeper', { projectId: project.id, supervisorId: harmonizer.id });
    const { events } = run((ctx) =>
      updateAgent(ctx, steward.id, { supervisorId: next.id, bodyId: steward.bodyId }),
    );
    expect(events).toEqual([
      { type: 'agent.updated', agentId: steward.id, changes: { supervisorId: next.id } },
    ]);
    expect(tables.agents.get(steward.id)?.supervisorId).toBe(next.id);
    expect(run((ctx) => updateAgent(ctx, steward.id, { supervisorId: next.id })).events).toEqual(
      [],
    );
    expect(() =>
      run((ctx) => updateAgent(ctx, waykeeper.id, { supervisorId: subWaykeeper.id })),
    ).toThrow(/supervise itself/);
    expect(() => run((ctx) => updateAgent(ctx, steward.id, { bodyId: 'b-x' }))).toThrow(/no body/);
  });

  it('never gives the Harmonizer a supervisor, a task or a project, nor moves it off Earth', () => {
    const { run, tables, project, tasks, harmonizer, otherWaykeeper } = hierarchy();
    expect(() =>
      run((ctx) => updateAgent(ctx, harmonizer.id, { supervisorId: otherWaykeeper.id })),
    ).toThrow(/supervise itself|no supervisor/);
    expect(() => run((ctx) => updateAgent(ctx, harmonizer.id, { projectId: project.id }))).toThrow(
      /no task or project/,
    );
    expect(() => run((ctx) => updateAgent(ctx, harmonizer.id, { taskId: tasks.a.id }))).toThrow(
      /no task or project/,
    );
    expect(() =>
      run((ctx) => updateAgent(ctx, harmonizer.id, { bodyId: tasks.asteroid.bodyId })),
    ).toThrow(/lives on Earth/);
    expect(run((ctx) => updateAgent(ctx, harmonizer.id, { bodyId: EARTH_ID })).events).toEqual([]);
    expect(tables.agents.get(harmonizer.id)).toEqual(harmonizer);
  });

  it('keeps every Waykeeper and Steward under the supervisor the hierarchy prescribes', () => {
    const { run, harmonizer, waykeeper, subWaykeeper, otherWaykeeper, steward, asteroidSteward } =
      hierarchy();
    const to = (agentId: Id, supervisorId: Id) =>
      run((ctx) => updateAgent(ctx, agentId, { supervisorId }));
    // A project Steward answers to its project's Waykeeper: not the Harmonizer, not another one.
    expect(() => to(steward.id, harmonizer.id)).toThrow(/answers to the Waykeeper of project/);
    expect(() => to(steward.id, otherWaykeeper.id)).toThrow(/answers to the Waykeeper of project/);
    // An asteroid Steward answers to the Harmonizer (decision 6).
    expect(() => to(asteroidSteward.id, waykeeper.id)).toThrow(/answers to the Harmonizer/);
    // A Waykeeper to the Harmonizer; a sub-project's to the parent project's Waykeeper.
    expect(() => to(otherWaykeeper.id, waykeeper.id)).toThrow(/answers to the Harmonizer/);
    expect(() => to(otherWaykeeper.id, steward.id)).toThrow(/answers to the Harmonizer/);
    expect(() => to(subWaykeeper.id, harmonizer.id)).toThrow(/answers to the Waykeeper of project/);
    expect(() => to(subWaykeeper.id, otherWaykeeper.id)).toThrow(/Waykeeper of project/);
  });

  it("keeps a Steward's task and project in agreement", () => {
    const { run, tables, project, other, tasks, waykeeper, steward } = hierarchy();
    // Another task of the same project: fine.
    expect(run((ctx) => updateAgent(ctx, steward.id, { taskId: tasks.b.id })).types).toEqual([
      'agent.updated',
    ]);
    // A standalone task while the row still names the project, or a project the task is not in.
    expect(() => run((ctx) => updateAgent(ctx, steward.id, { taskId: tasks.asteroid.id }))).toThrow(
      /standalone task/,
    );
    expect(() => run((ctx) => updateAgent(ctx, steward.id, { projectId: other.id }))).toThrow(
      /belongs to project/,
    );
    expect(() => run((ctx) => updateAgent(ctx, steward.id, { taskId: tasks.sub.id }))).toThrow(
      /belongs to project/,
    );
    expect(tables.agents.get(steward.id)).toMatchObject({
      taskId: tasks.b.id,
      projectId: project.id,
      supervisorId: waykeeper.id,
    });
  });

  it('hands a promoted Steward over in one update: project and supervisor together', () => {
    const { run, tables, project, tasks, waykeeper, asteroidSteward } = hierarchy();
    // Half a hand-over is refused: the Harmonizer does not supervise a project Steward.
    expect(() =>
      run((ctx) => updateAgent(ctx, asteroidSteward.id, { supervisorId: waykeeper.id })),
    ).toThrow(/answers to the Harmonizer/);
    // `moveTask` hands the Steward over itself, in the same command (P2-12, decision 32).
    const { events } = run((ctx) => moveTask(ctx, tasks.asteroid.id, project.id, USER));
    expect(events.at(-1)).toEqual({
      type: 'agent.updated',
      agentId: asteroidSteward.id,
      changes: { supervisorId: waykeeper.id, projectId: project.id },
    });
    expect(tables.agents.get(asteroidSteward.id)).toMatchObject({
      projectId: project.id,
      supervisorId: waykeeper.id,
    });
  });

  it('refuses a Waykeeper a task, and a project it does not run with its old supervisor', () => {
    const { run, tasks, sub, waykeeper } = hierarchy();
    expect(() => run((ctx) => updateAgent(ctx, waykeeper.id, { taskId: tasks.a.id }))).toThrow(
      /runs a project, not a task/,
    );
    // Moving a Waykeeper onto the sub-project needs the parent's Waykeeper above it.
    expect(() => run((ctx) => updateAgent(ctx, waykeeper.id, { projectId: sub.id }))).toThrow(
      /supervise itself|answers to the Waykeeper/,
    );
  });

  it('lets a body-only move through for a row from before the rules (Phase 1 ops console)', () => {
    const { run, agent, tasks } = hierarchy();
    const loose = agent('steward');
    expect(
      run((ctx) => updateAgent(ctx, loose.id, { bodyId: tasks.asteroid.bodyId })).types,
    ).toEqual(['agent.updated']);
    expect(() => run((ctx) => updateAgent(ctx, loose.id, { taskId: tasks.asteroid.id }))).toThrow(
      /needs a supervisor: the Harmonizer/,
    );
  });
});
