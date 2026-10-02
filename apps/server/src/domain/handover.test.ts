import { describe, expect, it } from 'vitest';
import type { Actor, AgentRole, Id } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { EARTH_ID } from './catalogue.js';
import { createProject, updateProject } from './projects.js';
import { createTask, moveTask } from './tasks.js';

/**
 * Hand-overs in the same command (P2-12; SPEC decision 32, wave-3 review finding 5): a moved
 * task's Stewards get the project and its Waykeeper; a detached sub-project's Waykeeper the
 * Harmonizer, an attached one the parent's Waykeeper.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

function setup() {
  const w = world();
  const agent = (
    role: AgentRole,
    place: { supervisorId?: Id; taskId?: Id; projectId?: Id; bodyId?: Id },
  ) =>
    w.run((ctx) =>
      createAgent(ctx, {
        role,
        runtime: 'fake',
        caps: CAPS,
        ...(role === 'harmonizer' ? { bodyId: EARTH_ID } : {}),
        ...Object.fromEntries(Object.entries(place).filter(([, v]) => v)),
      }),
    ).value;
  const project = w.run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w/csv' })).value;
  const harmonizer = agent('harmonizer', {});
  return { ...w, agent, project, harmonizer };
}

describe('moveTask hands the Stewards over', () => {
  it('to the project and its Waykeeper, ended rows too, in the same command', () => {
    const { run, tables, agent, project, harmonizer } = setup();
    const waykeeper = agent('waykeeper', { projectId: project.id, supervisorId: harmonizer.id });
    const task = run((ctx) => createTask(ctx, { description: 'flaky test' })).value;
    const on = { taskId: task.id, supervisorId: harmonizer.id, bodyId: task.bodyId };
    const first = agent('steward', on);
    const second = agent('steward', on);
    const { types } = run((ctx) => moveTask(ctx, task.id, project.id, USER));
    expect(types.filter((t) => t === 'agent.updated')).toHaveLength(4); // 2 flights, 2 hand-overs
    for (const s of [first, second]) {
      expect(tables.agents.get(s.id)).toMatchObject({
        projectId: project.id,
        supervisorId: waykeeper.id,
        bodyId: project.bodyId,
      });
    }
  });

  it('prefers a living Waykeeper over a newer ended one', () => {
    const { log, tables, agent, project, harmonizer } = setup();
    const living = agent('waykeeper', { projectId: project.id, supervisorId: harmonizer.id });
    agent('waykeeper', { projectId: project.id, supervisorId: harmonizer.id }); // ended
    const task = log.runCommand((ctx) => createTask(ctx, { description: 'x' })).value;
    const steward = agent('steward', { taskId: task.id, supervisorId: harmonizer.id });
    log.runCommand((ctx) =>
      moveTask(ctx, task.id, project.id, USER, { isLiving: (id) => id === living.id }),
    );
    expect(tables.agents.get(steward.id)?.supervisorId).toBe(living.id);
  });

  it('is refused, with nothing written, while the project has no Waykeeper', () => {
    const { run, log, tables, agent, project, harmonizer } = setup();
    const task = run((ctx) => createTask(ctx, { description: 'x' })).value;
    const steward = agent('steward', { taskId: task.id, supervisorId: harmonizer.id });
    const seq = log.currentSeq();
    expect(() => run((ctx) => moveTask(ctx, task.id, project.id, USER))).toThrow(
      /has no Waykeeper to take over/,
    );
    expect(log.currentSeq()).toBe(seq);
    expect(tables.tasks.get(task.id)?.projectId).toBeUndefined();
    expect(tables.agents.get(steward.id)?.supervisorId).toBe(harmonizer.id);
  });
});

describe('attaching and detaching a sub-project hands its Waykeeper over', () => {
  it('detached: to the Harmonizer; attached again: to the parent project’s Waykeeper', () => {
    const { run, tables, agent, project, harmonizer } = setup();
    const parentWk = agent('waykeeper', { projectId: project.id, supervisorId: harmonizer.id });
    const sub = run((ctx) =>
      createProject(ctx, { name: 'Writer', workspace: '/w/w', parentProjectId: project.id }),
    ).value;
    const subWk = agent('waykeeper', { projectId: sub.id, supervisorId: parentWk.id });

    const detached = run((ctx) => updateProject(ctx, sub.id, { parentProjectId: null }));
    expect(detached.events.at(-1)).toEqual({
      type: 'agent.updated',
      agentId: subWk.id,
      changes: { supervisorId: harmonizer.id },
    });
    expect(tables.agents.get(subWk.id)?.supervisorId).toBe(harmonizer.id);

    run((ctx) => updateProject(ctx, sub.id, { parentProjectId: project.id }));
    expect(tables.agents.get(subWk.id)?.supervisorId).toBe(parentWk.id);
    // Nothing changes, nothing is handed over.
    expect(run((ctx) => updateProject(ctx, sub.id, { name: 'Writer 2' })).types).toEqual([
      'project.updated',
    ]);
  });

  it('attaching under a parent without a Waykeeper is refused', () => {
    const { run, tables, agent, harmonizer } = setup();
    const planet = run((ctx) =>
      createProject(ctx, { name: 'Host', workspace: '/w/h', bodyId: 'b-saturn' }),
    ).value;
    const moon = run((ctx) =>
      createProject(ctx, { name: 'Moon', workspace: '/w/m', bodyId: 'b-titan' }),
    ).value;
    const wk = agent('waykeeper', { projectId: moon.id, supervisorId: harmonizer.id });
    expect(() => run((ctx) => updateProject(ctx, moon.id, { parentProjectId: planet.id }))).toThrow(
      /has no Waykeeper to supervise/,
    );
    expect(tables.projects.get(moon.id)?.parentProjectId).toBeUndefined();
    expect(tables.agents.get(wk.id)?.supervisorId).toBe(harmonizer.id);
  });
});
