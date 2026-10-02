import { describe, expect, it } from 'vitest';
import { world } from '../test/world.js';
import { moveHost } from './bodies.js';
import { recordControl } from './control.js';
import { closeProject, createProject, reopenProject, updateProject } from './projects.js';
import { retained, sweepRetention } from './retention.js';
import { closeTask, createTask } from './tasks.js';

/**
 * P2-13 acceptance (fake clock): retention of finished work, pin, reopen and the blocked-closure
 * rule. The world's clock ticks a second per reading; `clock.advance` jumps it.
 */

const USER = { type: 'user' } as const;
const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 7 * DAY;
const input = { name: 'CSV to Parquet', workspace: '/w/csv' };

function closed() {
  const w = world();
  const p = w.run((ctx) => createProject(ctx, input)).value;
  const t = w.run((ctx) => createTask(ctx, { projectId: p.id, description: 'parse' })).value;
  w.run((ctx) => closeTask(ctx, t.id, USER));
  w.run((ctx) => recordControl(ctx, { kind: 'project', id: p.id }, { action: 'close' }, USER));
  return { ...w, p, t };
}

describe('retention and archival (P2-13)', () => {
  it('keeps a closed project on its body for the retention period, then archives it and frees the body', () => {
    const { log, tables, clock, p, seen } = closed();
    expect(tables.projects.get(p.id)?.state).toBe('completed');
    expect(retained(log, RETENTION).map((r) => r.id)).toEqual([p.id]);

    clock.advance(RETENTION - 60_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([]);
    expect(tables.bodies.get(p.bodyId)?.host).toEqual({ kind: 'project', id: p.id });

    clock.advance(120_000);
    const since = seen.length;
    expect(sweepRetention(log, RETENTION).archived).toEqual([{ kind: 'project', id: p.id }]);
    expect(tables.projects.get(p.id)?.state).toBe('archived');
    expect(tables.bodies.get(p.bodyId)?.host).toBeUndefined();
    expect(seen.slice(since).map((e) => e.event)).toEqual([
      {
        type: 'project.state_changed',
        projectId: p.id,
        from: 'completed',
        to: 'archived',
        by: { type: 'system' },
      },
      { type: 'body.freed', bodyId: p.bodyId },
    ]);
    // The project's tasks stay as they were, on the project's (now history) record.
    expect(tables.tasks.all().map((t) => t.state)).toEqual(['completed']);
    expect(retained(log, RETENTION)).toEqual([]);
  });

  it('counts from the moment the work finished, not from a later edit', () => {
    const { log, run, tables, clock, p } = closed();
    clock.advance(5 * DAY);
    run((ctx) => updateProject(ctx, p.id, { name: 'Renamed' })); // moves updatedAt, not the clock
    clock.advance(2 * DAY + 60_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([{ kind: 'project', id: p.id }]);
    expect(tables.projects.get(p.id)?.state).toBe('archived');
  });

  it('archives a cancelled project and a finished standalone task the same way', () => {
    const { log, run, tables, clock } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    run((ctx) => recordControl(ctx, { kind: 'project', id: p.id }, { action: 'cancel' }, USER));
    const t = run((ctx) => createTask(ctx, { description: 'fix the typo' })).value;
    run((ctx) => closeTask(ctx, t.id, USER));
    const busy = run((ctx) => createTask(ctx, { description: 'still running' })).value;
    clock.advance(RETENTION + 60_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([
      { kind: 'project', id: p.id },
      { kind: 'task', id: t.id },
    ]);
    expect(tables.bodies.get(p.bodyId)?.host).toBeUndefined();
    expect(tables.bodies.get(t.bodyId)?.host).toBeUndefined();
    expect(tables.tasks.get(busy.id)?.state).toBe('approved');
    expect(tables.bodies.get(busy.bodyId)?.host).toEqual({ kind: 'task', id: busy.id });
  });

  it('a pin suspends the timer; unpinning starts a full period again', () => {
    const { log, run, tables, clock, p } = closed();
    const target = { kind: 'project', id: p.id } as const;
    run((ctx) => recordControl(ctx, target, { action: 'pin', pinned: true }, USER));
    clock.advance(30 * DAY);
    expect(sweepRetention(log, RETENTION).archived).toEqual([]);
    expect(retained(log, RETENTION)).toEqual([]);

    run((ctx) => recordControl(ctx, target, { action: 'pin', pinned: false }, USER));
    const unpinnedAt = tables.projects.get(p.id)!.updatedAt;
    expect(retained(log, RETENTION)[0]).toMatchObject({ id: p.id, since: unpinnedAt });
    clock.advance(RETENTION - 60_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([]);
    clock.advance(120_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([{ kind: 'project', id: p.id }]);
  });

  it('a pinned standalone task is kept too', () => {
    const { log, run, clock } = world();
    const t = run((ctx) => createTask(ctx, { description: 'keep me' })).value;
    run((ctx) => closeTask(ctx, t.id, USER));
    run((ctx) =>
      recordControl(ctx, { kind: 'task', id: t.id }, { action: 'pin', pinned: true }, USER),
    );
    clock.advance(RETENTION * 2);
    expect(sweepRetention(log, RETENTION).archived).toEqual([]);
  });

  it('archive now frees the body at once; the timer has nothing left to do', () => {
    const { log, run, tables, p } = closed();
    run((ctx) => recordControl(ctx, { kind: 'project', id: p.id }, { action: 'archive' }, USER));
    expect(tables.projects.get(p.id)?.state).toBe('archived');
    expect(tables.bodies.get(p.bodyId)?.host).toBeUndefined();
    expect(retained(log, RETENTION)).toEqual([]);
  });

  it('the retention period is a setting', () => {
    const { log, clock, p } = closed();
    clock.advance(DAY + 60_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([]);
    expect(sweepRetention(log, DAY).archived).toEqual([{ kind: 'project', id: p.id }]);
  });

  it('sweeps "moved to …" markers with the same period', () => {
    const { log, run, tables, clock } = world();
    const p = run((ctx) => createProject(ctx, input)).value;
    run((ctx) => moveHost(ctx, { kind: 'project', id: p.id }, 'b-jupiter'));
    expect(tables.bodies.get('b-mars')?.movedTo?.bodyId).toBe('b-jupiter');
    clock.advance(DAY + 60_000);
    expect(sweepRetention(log, DAY)).toEqual({ archived: [], skipped: [], markers: ['b-mars'] });
    expect(tables.bodies.get('b-mars')?.movedTo).toBeUndefined();
  });
});

describe('reopen (P2-13)', () => {
  it('reopens on the same body while it is still held, and stops the timer until closed again', () => {
    const { log, run, tables, clock, p } = closed();
    clock.advance(3 * DAY);
    run((ctx) => recordControl(ctx, { kind: 'project', id: p.id }, { action: 'reopen' }, USER));
    expect(tables.projects.get(p.id)).toMatchObject({ state: 'approved', bodyId: p.bodyId });
    expect(retained(log, RETENTION)).toEqual([]);

    run((ctx) => closeProject(ctx, p.id, USER));
    clock.advance(RETENTION - 60_000); // 3 days already spent would have archived it by now
    expect(sweepRetention(log, RETENTION).archived).toEqual([]);
    clock.advance(120_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([{ kind: 'project', id: p.id }]);
  });

  it('reopens an archived project on its old body when it is free', () => {
    const { log, run, tables, clock, p } = closed();
    clock.advance(RETENTION + 60_000);
    sweepRetention(log, RETENTION);
    run((ctx) => recordControl(ctx, { kind: 'project', id: p.id }, { action: 'reopen' }, USER));
    expect(tables.projects.get(p.id)).toMatchObject({ state: 'approved', bodyId: 'b-mars' });
    expect(tables.bodies.get('b-mars')?.host).toEqual({ kind: 'project', id: p.id });
  });

  it('reopens on a new body when the old one was taken, and keeps the link', () => {
    const { log, run, tables, clock, p, t } = closed();
    clock.advance(RETENTION + 60_000);
    sweepRetention(log, RETENTION);
    const other = run((ctx) => createProject(ctx, { ...input, name: 'Other' })).value;
    expect(other.bodyId).toBe('b-mars');

    run((ctx) => recordControl(ctx, { kind: 'project', id: p.id }, { action: 'reopen' }, USER));
    const reopened = tables.projects.get(p.id)!;
    expect(reopened.state).toBe('approved');
    expect(reopened.bodyId).not.toBe('b-mars');
    expect(tables.bodies.get(reopened.bodyId)).toMatchObject({
      kind: 'planet',
      host: { kind: 'project', id: p.id },
    });
    expect(reopened.meta).toMatchObject({ previousBodyIds: ['b-mars'] });
    expect(tables.tasks.get(t.id)?.bodyId).toBe(reopened.bodyId);
    expect(tables.bodies.get('b-mars')?.host).toEqual({ kind: 'project', id: other.id });
  });

  it('a reopened sub-project goes back to a moon of its parent’s planet', () => {
    const { log, run, tables, clock } = world();
    const planet = run((ctx) => createProject(ctx, input)).value;
    const sub = run((ctx) =>
      createProject(ctx, { ...input, name: 'Docs', kind: 'moon', parentProjectId: planet.id }),
    ).value;
    run((ctx) => closeProject(ctx, sub.id, USER));
    clock.advance(RETENTION + 60_000);
    sweepRetention(log, RETENTION);
    // Someone else takes its moon.
    run((ctx) =>
      createProject(ctx, {
        ...input,
        name: 'Other docs',
        bodyId: sub.bodyId,
        parentProjectId: planet.id,
      }),
    );
    run((ctx) => reopenProject(ctx, sub.id, USER));
    const body = tables.bodies.get(tables.projects.get(sub.id)!.bodyId)!;
    expect(body).toMatchObject({ kind: 'moon', parentId: planet.bodyId });
    expect(body.id).not.toBe(sub.bodyId);
  });
});

describe('sub-project moons block their planet (P2-13, SPEC §3.2)', () => {
  function planetWithSub() {
    const w = world();
    const planet = w.run((ctx) => createProject(ctx, input)).value;
    const sub = w.run((ctx) =>
      createProject(ctx, { ...input, name: 'Docs', kind: 'moon', parentProjectId: planet.id }),
    ).value;
    return { ...w, planet, sub };
  }

  it('a planet cannot be closed or archived while a sub-project moon is active', () => {
    const { run, tables, planet, sub } = planetWithSub();
    const target = { kind: 'project', id: planet.id } as const;
    expect(() => run((ctx) => recordControl(ctx, target, { action: 'close' }, USER))).toThrow(
      /active sub-projects: Docs/,
    );
    expect(tables.projects.get(planet.id)?.state).toBe('approved');
    run((ctx) => closeProject(ctx, sub.id, USER));
    run((ctx) => recordControl(ctx, target, { action: 'close' }, USER));
    expect(tables.projects.get(planet.id)?.state).toBe('completed');

    run((ctx) => reopenProject(ctx, sub.id, USER)); // the sub-project is active again
    expect(() => run((ctx) => recordControl(ctx, target, { action: 'archive' }, USER))).toThrow(
      /active sub-projects: Docs/,
    );
  });

  it('the archival job skips such a planet and archives it once the sub-project is done', () => {
    const { log, run, tables, clock, planet, sub } = planetWithSub();
    run((ctx) => closeProject(ctx, sub.id, USER));
    run((ctx) => closeProject(ctx, planet.id, USER));
    run((ctx) => reopenProject(ctx, sub.id, USER));
    clock.advance(RETENTION + 60_000);
    const report = sweepRetention(log, RETENTION);
    expect(report.archived).toEqual([]);
    expect(report.skipped).toEqual([
      { kind: 'project', id: planet.id, reason: expect.stringMatching(/active sub-projects/) },
    ]);
    expect(tables.bodies.get(planet.bodyId)?.host).toEqual({ kind: 'project', id: planet.id });

    run((ctx) => closeProject(ctx, sub.id, USER));
    expect(sweepRetention(log, RETENTION).archived).toEqual([{ kind: 'project', id: planet.id }]);
    clock.advance(RETENTION + 60_000);
    expect(sweepRetention(log, RETENTION).archived).toEqual([{ kind: 'project', id: sub.id }]);
  });
});
