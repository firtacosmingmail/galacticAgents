import { describe, expect, it } from 'vitest';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { DomainError } from './errors.js';
import {
  archiveProject,
  closeProject,
  createProject,
  pinProject,
  reopenProject,
  updateProject,
} from './projects.js';
import { setProjectState } from './states.js';
import { createTask } from './tasks.js';

const USER = { type: 'user' } as const;
const input = { name: 'CSV to Parquet', workspace: '/w/csv' };

describe('createProject', () => {
  it('inserts the project on a free planet and emits project.created then body.assigned', () => {
    const { run, tables } = world();
    const { value, events } = run((ctx) => createProject(ctx, input));
    expect(value).toMatchObject({ name: 'CSV to Parquet', bodyId: 'b-mars', state: 'approved' });
    expect(tables.projects.get(value.id)).toEqual(value);
    expect(tables.bodies.get('b-mars')?.host).toEqual({ kind: 'project', id: value.id });
    expect(events).toEqual([
      { type: 'project.created', project: value },
      { type: 'body.assigned', bodyId: 'b-mars', host: { kind: 'project', id: value.id } },
    ]);
  });

  it('stamps the row with the command clock that the events carry', () => {
    const { log, run } = world();
    const { value } = run((ctx) => createProject(ctx, input));
    const [env] = log.eventsSince(0);
    expect(value.createdAt).toBe(env!.at);
    expect(value.updatedAt).toBe(env!.at);
  });

  it('takes a named body or the next free one of a kind, never a reserved or taken body', () => {
    const { run } = world();
    expect(run((ctx) => createProject(ctx, { ...input, kind: 'moon' })).value.bodyId).toBe(
      'b-phobos',
    );
    expect(run((ctx) => createProject(ctx, { ...input, bodyId: 'b-jupiter' })).value.bodyId).toBe(
      'b-jupiter',
    );
    expect(() => run((ctx) => createProject(ctx, { ...input, bodyId: 'b-earth' }))).toThrow(
      /reserved/,
    );
    expect(() => run((ctx) => createProject(ctx, { ...input, bodyId: 'b-jupiter' }))).toThrow(
      /already hosts/,
    );
    run((ctx) => createProject(ctx, input)); // Mars
    expect(() => run((ctx) => createProject(ctx, input))).toThrow(/no free planet/);
  });

  it('stores a valid permission policy and refuses an invalid one, leaving nothing behind', () => {
    const { run, tables, log } = world();
    const policy = { rules: { network: 'allow' as const } };
    const { value } = run((ctx) => createProject(ctx, { ...input, permissionPolicy: policy }));
    expect(tables.projects.get(value.id)?.permissionPolicy).toEqual(policy);
    const seq = log.currentSeq();
    expect(() =>
      run((ctx) =>
        createProject(ctx, {
          ...input,
          kind: 'moon',
          permissionPolicy: { rules: { network: 'sure' } } as never,
        }),
      ),
    ).toThrow(DomainError);
    expect(log.currentSeq()).toBe(seq);
    expect(tables.bodies.get('b-phobos')?.host).toBeUndefined();
  });

  it('refuses an unknown parent, an empty workspace and an asteroid', () => {
    const { run } = world();
    expect(() => run((ctx) => createProject(ctx, { ...input, parentProjectId: 'p-x' }))).toThrow(
      /no project p-x/,
    );
    expect(() => run((ctx) => createProject(ctx, { ...input, workspace: ' ' }))).toThrow(
      /workspace/,
    );
    expect(() =>
      run((ctx) => createProject(ctx, { ...input, kind: 'asteroid' as never })),
    ).toThrow();
  });
});

describe('updateProject', () => {
  it('changes fields and emits project.updated with exactly the changes', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    const { value, events } = run((ctx) =>
      updateProject(ctx, p.id, { workspace: '/w/csv2', name: undefined } as never),
    );
    expect(value.workspace).toBe('/w/csv2');
    expect(tables.projects.get(p.id)?.workspace).toBe('/w/csv2');
    expect(events).toEqual([
      { type: 'project.updated', projectId: p.id, changes: { workspace: '/w/csv2' } },
    ]);
  });

  it('is a no-op without changes and refuses body changes, self-parenting and bad policies', () => {
    const { run } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    expect(run((ctx) => updateProject(ctx, p.id, {})).events).toEqual([]);
    expect(() => run((ctx) => updateProject(ctx, p.id, { bodyId: 'b-jupiter' }))).toThrow(
      /moving/,
    );
    expect(() => run((ctx) => updateProject(ctx, p.id, { parentProjectId: p.id }))).toThrow(
      /own parent/,
    );
    expect(() =>
      run((ctx) => updateProject(ctx, p.id, { permissionPolicy: { rules: 'all' } as never })),
    ).toThrow(/policy/);
    expect(() => run((ctx) => updateProject(ctx, 'p-x', { name: 'x' }))).toThrow(/no project/);
  });
});

describe('project states', () => {
  it('follows the transition table and records who asked', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    const { events } = run((ctx) => setProjectState(ctx, p.id, 'in_progress', USER));
    expect(events).toEqual([
      { type: 'project.state_changed', projectId: p.id, from: 'approved', to: 'in_progress', by: USER },
    ]);
    expect(tables.projects.get(p.id)?.state).toBe('in_progress');
    expect(run((ctx) => setProjectState(ctx, p.id, 'in_progress')).events).toEqual([]);
    expect(() => run((ctx) => setProjectState(ctx, p.id, 'proposed'))).toThrow(
      /cannot go from in_progress to proposed/,
    );
  });

  it('closes, archives (freeing the body), and refuses doing either twice', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    const closed = run((ctx) => closeProject(ctx, p.id, USER));
    expect(closed.value.state).toBe('completed');
    expect(closed.types).toEqual(['project.state_changed']);
    expect(tables.bodies.get('b-mars')?.host).toBeDefined(); // visible for the retention period
    expect(() => run((ctx) => closeProject(ctx, p.id, USER))).toThrow(/already completed/);

    const archived = run((ctx) => archiveProject(ctx, p.id, USER));
    expect(archived.types).toEqual(['project.state_changed', 'body.freed']);
    expect(tables.bodies.get('b-mars')?.host).toBeUndefined();
    expect(() => run((ctx) => archiveProject(ctx, p.id, USER))).toThrow(/already archived/);
  });

  it('refuses to close a planet while one of its sub-projects is active', () => {
    const { run } = world();
    const planet = run((ctx) => createProject(ctx, input)).value;
    const sub = run((ctx) =>
      createProject(ctx, { ...input, name: 'Writer', kind: 'moon', parentProjectId: planet.id }),
    ).value;
    expect(() => run((ctx) => closeProject(ctx, planet.id, USER))).toThrow(/sub-projects: Writer/);
    run((ctx) => closeProject(ctx, sub.id, USER));
    expect(run((ctx) => closeProject(ctx, planet.id, USER)).value.state).toBe('completed');
  });

  it('pins through project.updated', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    expect(run((ctx) => pinProject(ctx, p.id, true)).events).toEqual([
      { type: 'project.updated', projectId: p.id, changes: { pinned: true } },
    ]);
    expect(tables.projects.get(p.id)?.pinned).toBe(true);
  });
});

describe('reopenProject', () => {
  it('reopens on the old body when it is still free', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    run((ctx) => closeProject(ctx, p.id, USER));
    run((ctx) => archiveProject(ctx, p.id, USER));
    const { value, types } = run((ctx) => reopenProject(ctx, p.id, USER));
    expect(value).toMatchObject({ state: 'approved', bodyId: 'b-mars' });
    expect(types).toEqual(['body.assigned', 'project.state_changed']);
    expect(tables.bodies.get('b-mars')?.host).toEqual({ kind: 'project', id: p.id });
  });

  it('needs another body when the old one was taken, and moves tasks and agents there', () => {
    const { run, tables } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    const t = run((ctx) => createTask(ctx, { description: 'parse', projectId: p.id })).value;
    const wk = run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
        bodyId: p.bodyId,
        projectId: p.id,
      }),
    ).value;
    run((ctx) => closeProject(ctx, p.id, USER));
    run((ctx) => archiveProject(ctx, p.id, USER));
    run((ctx) => createProject(ctx, { ...input, name: 'Other' })); // takes Mars
    expect(() => run((ctx) => reopenProject(ctx, p.id, USER))).toThrow(/Mars is taken/);
    const { value, types } = run((ctx) => reopenProject(ctx, p.id, USER, { bodyId: 'b-jupiter' }));
    expect(value).toMatchObject({ state: 'approved', bodyId: 'b-jupiter' });
    expect(types).toEqual([
      'body.assigned',
      'project.updated',
      'task.updated',
      'agent.updated',
      'project.state_changed',
    ]);
    expect(tables.tasks.get(t.id)?.bodyId).toBe('b-jupiter');
    expect(tables.agents.get(wk.id)?.bodyId).toBe('b-jupiter');
  });

  it('refuses work that is not finished', () => {
    const { run } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    expect(() => run((ctx) => reopenProject(ctx, p.id, USER))).toThrow(/not finished/);
  });
});
