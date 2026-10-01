import { describe, expect, it } from 'vitest';
import type { Actor, Agent, AgentRole, Event, Id } from '@galactic/protocol';
import { world } from '../test/world.js';
import { agentsOf, concernedSupervisors, retentionDue } from './cascade.js';
import { recordControl } from './control.js';
import { openQuestion } from './questions.js';
import type { CommandContext } from './event-log.js';
import { createProject } from './projects.js';
import { setTaskState } from './states.js';
import { createTask } from './tasks.js';

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

function agent(ctx: CommandContext, id: Id, role: AgentRole, extra: Partial<Agent> = {}): Agent {
  const row: Agent = {
    id,
    role,
    runtime: 'fake',
    bodyId: 'b-earth',
    caps: CAPS,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...extra,
  };
  ctx.tables.agents.insert(row);
  return row;
}

/** A Harmonizer, a project with its Waykeeper, two tasks with a Steward each, an asteroid task. */
function setup() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'CSV', workspace: '/w' })).value;
  const t1 = w.run((ctx) => createTask(ctx, { description: 'a', projectId: project.id })).value;
  const t2 = w.run((ctx) => createTask(ctx, { description: 'b', projectId: project.id })).value;
  const solo = w.run((ctx) => createTask(ctx, { description: 'solo' })).value;
  w.run((ctx) => {
    agent(ctx, 'a-h', 'harmonizer');
    agent(ctx, 'a-w', 'waykeeper', { projectId: project.id, supervisorId: 'a-h' });
    agent(ctx, 'a-s1', 'steward', { taskId: t1.id, projectId: project.id, supervisorId: 'a-w' });
    agent(ctx, 'a-s2', 'steward', { taskId: t2.id, projectId: project.id, supervisorId: 'a-w' });
    agent(ctx, 'a-s3', 'steward', { taskId: solo.id, supervisorId: 'a-h' });
  });
  w.run((ctx) => setTaskState(ctx, t1.id, 'in_progress'));
  return { ...w, project, t1, t2, solo };
}

const control = (type: Event['type'], kind: 'agent' | 'task' | 'project', id: Id, by = USER) =>
  ({ type, target: { kind, id }, by }) as Event;

describe('applyControlState (through recordControl)', () => {
  it('pausing a task pauses it; resuming goes back to in_progress with a live agent, else approved', () => {
    const { run, tables, t1 } = setup();
    const target = { kind: 'task', id: t1.id } as const;
    expect(run((ctx) => recordControl(ctx, target, { action: 'pause' }, USER)).events).toEqual([
      { type: 'control.pause', target, by: USER },
      { type: 'task.state_changed', taskId: t1.id, from: 'in_progress', to: 'paused', by: USER },
    ]);
    run((ctx) =>
      recordControl(ctx, target, { action: 'resume' }, USER, { isLive: (id) => id === 'a-s1' }),
    );
    expect(tables.tasks.get(t1.id)?.state).toBe('in_progress');
    run((ctx) => recordControl(ctx, target, { action: 'stop' }, USER));
    expect(tables.tasks.get(t1.id)?.state).toBe('paused');
    run((ctx) => recordControl(ctx, target, { action: 'resume' }, USER));
    expect(tables.tasks.get(t1.id)?.state).toBe('approved');
  });

  it('pausing a task blocked on the user keeps it paused, and resume brings it back blocked', () => {
    const { run, tables, t1 } = setup();
    run((ctx) =>
      openQuestion(ctx, {
        id: 'q-u',
        kind: 'permission',
        originAgentId: 'a-s1',
        context: { text: 'May I push?' },
      }),
    );
    run((ctx) => setTaskState(ctx, t1.id, 'blocked_on_user'));
    const target = { kind: 'task', id: t1.id } as const;
    run((ctx) => recordControl(ctx, target, { action: 'pause' }, USER));
    expect(tables.tasks.get(t1.id)?.state).toBe('paused');
    run((ctx) => recordControl(ctx, target, { action: 'resume' }, USER));
    expect(tables.tasks.get(t1.id)?.state).not.toBe('paused');
  });

  it('cancelling a task fails it by the user; a proposed one is archived; finished work refuses', () => {
    const { run, tables, t1, log } = setup();
    const target = { kind: 'task', id: t1.id } as const;
    expect(run((ctx) => recordControl(ctx, target, { action: 'cancel' }, USER)).types).toEqual([
      'control.cancel',
      'task.state_changed',
    ]);
    expect(tables.tasks.get(t1.id)?.state).toBe('failed');
    const seq = log.currentSeq();
    for (const action of ['cancel', 'pause', 'stop', 'resume'] as const) {
      expect(() => run((ctx) => recordControl(ctx, target, { action }, USER))).toThrow();
    }
    expect(log.currentSeq()).toBe(seq);
    const draft = run((ctx) => createTask(ctx, { description: 'd', state: 'proposed' })).value;
    run((ctx) => recordControl(ctx, { kind: 'task', id: draft.id }, { action: 'cancel' }, USER));
    expect(tables.tasks.get(draft.id)?.state).toBe('archived');
    expect(tables.bodies.get(draft.bodyId)?.host).toBeUndefined();
  });

  it('pausing a project pauses it and its running tasks; resume brings both back', () => {
    const { run, tables, project, t1, t2 } = setup();
    const target = { kind: 'project', id: project.id } as const;
    run((ctx) => recordControl(ctx, target, { action: 'pause' }, USER));
    expect(tables.projects.get(project.id)?.state).toBe('paused');
    expect([tables.tasks.get(t1.id)?.state, tables.tasks.get(t2.id)?.state]).toEqual([
      'paused',
      'paused',
    ]);
    run((ctx) =>
      recordControl(ctx, target, { action: 'resume' }, USER, { isLive: (id) => id === 'a-s1' }),
    );
    expect(tables.projects.get(project.id)?.state).toBe('in_progress');
    expect([tables.tasks.get(t1.id)?.state, tables.tasks.get(t2.id)?.state]).toEqual([
      'in_progress',
      'approved',
    ]);
  });

  it('cancelling a project fails it and its unfinished tasks; the body stays until archival', () => {
    const { run, tables, project, t1, t2 } = setup();
    const target = { kind: 'project', id: project.id } as const;
    run((ctx) => recordControl(ctx, target, { action: 'cancel' }, USER));
    expect(tables.projects.get(project.id)?.state).toBe('failed');
    expect([tables.tasks.get(t1.id)?.state, tables.tasks.get(t2.id)?.state]).toEqual([
      'failed',
      'failed',
    ]);
    expect(tables.bodies.get(project.bodyId)?.host).toEqual({ kind: 'project', id: project.id });
    expect(retentionDue(tables).map((r) => r.projectId)).toEqual([project.id]);
    expect(() => run((ctx) => recordControl(ctx, target, { action: 'cancel' }, USER))).toThrow(
      /already failed/,
    );
  });

  it('refuses to cancel a project with an active sub-project', () => {
    const { run, project } = setup();
    run((ctx) =>
      createProject(ctx, {
        name: 'sub',
        workspace: '/w/sub',
        parentProjectId: project.id,
        kind: 'moon',
      }),
    );
    expect(() =>
      run((ctx) =>
        recordControl(ctx, { kind: 'project', id: project.id }, { action: 'cancel' }, USER),
      ),
    ).toThrow(/sub-projects/);
  });

  it('a pinned finished project is not due for retention', () => {
    const { run, tables, project } = setup();
    const target = { kind: 'project', id: project.id } as const;
    run((ctx) => recordControl(ctx, target, { action: 'cancel' }, USER));
    run((ctx) => recordControl(ctx, target, { action: 'pin', pinned: true }, USER));
    expect(retentionDue(tables)).toEqual([]);
  });
});

describe('agentsOf', () => {
  it("a task's Stewards; a project's Waykeeper and its tasks' Stewards", () => {
    const { tables, project, t1 } = setup();
    const ids = (kind: 'task' | 'project' | 'agent', id: Id) =>
      agentsOf(tables, { kind, id }).map((a) => a.id);
    expect(ids('task', t1.id)).toEqual(['a-s1']);
    expect(ids('project', project.id).sort()).toEqual(['a-s1', 'a-s2', 'a-w']);
    expect(ids('agent', 'a-h')).toEqual(['a-h']);
  });
});

describe('concernedSupervisors', () => {
  it("a task's control concerns its Waykeeper; a standalone task's the Harmonizer", () => {
    const { tables, t1, solo } = setup();
    expect(concernedSupervisors(tables, control('control.pause', 'task', t1.id))).toEqual(['a-w']);
    expect(concernedSupervisors(tables, control('control.stop', 'task', solo.id))).toEqual(['a-h']);
  });

  it("an agent's control concerns its supervisor; a project's its Waykeeper and the Harmonizer", () => {
    const { tables, project } = setup();
    expect(concernedSupervisors(tables, control('control.pause', 'agent', 'a-s2'))).toEqual([
      'a-w',
    ]);
    expect(concernedSupervisors(tables, control('control.stop', 'agent', 'a-w'))).toEqual(['a-h']);
    expect(
      concernedSupervisors(tables, control('control.cancel', 'project', project.id)).sort(),
    ).toEqual(['a-h', 'a-w']);
  });

  it('never the actor itself, only live brains when asked, nothing for other events', () => {
    const { tables, project, t1 } = setup();
    const byHarmonizer = control('control.cancel', 'project', project.id, {
      type: 'agent',
      id: 'a-h',
    });
    expect(concernedSupervisors(tables, byHarmonizer)).toEqual(['a-w']);
    expect(
      concernedSupervisors(tables, control('control.pause', 'project', project.id), {
        isLive: (id) => id === 'a-h',
      }),
    ).toEqual(['a-h']);
    expect(
      concernedSupervisors(tables, {
        type: 'task.state_changed',
        taskId: t1.id,
        from: 'approved',
        to: 'paused',
      }),
    ).toEqual([]);
  });
});
