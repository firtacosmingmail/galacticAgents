import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applySnapshot,
  type EventEnvelope,
  type RecordedApproval,
  type Snapshot,
} from '@galactic/protocol';
import { recordControl } from './control.js';
import { world } from '../test/world.js';
import { DomainError } from './errors.js';
import { createProject, closeProject } from './projects.js';
import { setProjectState } from './states.js';
import {
  addStandingApproval,
  endStandingApprovals,
  recordApproval,
  removeStandingApproval,
  setWaykeeperApprovals,
} from './waykeeper-approvals.js';

/** P13-01: Waykeeper approvals on the project row, each change with its event. */

const USER = { type: 'user' } as const;
const SYSTEM = { type: 'system' } as const;
const MADE = { by: USER, origin: 'local' } as const;
const draft = { kind: 'run the test suite', examples: ['pnpm test'] };

function setup() {
  const w = world();
  const project = w.run((ctx) => createProject(ctx, { name: 'App', workspace: '/w/app' })).value;
  const get = () => w.tables.projects.get(project.id)!;
  return { ...w, project, get };
}

const rec = (i: number): RecordedApproval => ({
  kind: 'run the test suite',
  summary: `pnpm test ${i}`,
  agentId: 'a-1',
  questionId: `q-${i}`,
  at: '2026-11-09T10:00:00.000Z',
});

describe('setWaykeeperApprovals', () => {
  it('turns it on with an event, off by deleting the field', () => {
    const { run, project, get } = setup();
    const on = run((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER));
    expect(on.events).toEqual([
      { type: 'waykeeper_approvals.set', projectId: project.id, on: true, by: USER },
    ]);
    expect(get().waykeeperApprovals).toBe(true);
    expect(get().updatedAt).toBe(project.updatedAt);
    const off = run((ctx) => setWaykeeperApprovals(ctx, project.id, false, USER));
    expect(off.types).toEqual(['waykeeper_approvals.set']);
    expect('waykeeperApprovals' in get()).toBe(false);
  });

  it('refuses a closed project for on, not for off', () => {
    const { run, project, get } = setup();
    run((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER));
    run((ctx) => setProjectState(ctx, project.id, 'completed'));
    expect(get().state).toBe('completed');
    expect(() => run((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER))).toThrow(
      DomainError,
    );
    expect(() => run((ctx) => setWaykeeperApprovals(ctx, project.id, false, USER))).not.toThrow();
  });
});

describe('addStandingApproval / removeStandingApproval', () => {
  it('appends and emits standing_approval.added', () => {
    const { run, project, get } = setup();
    const { value, events } = run((ctx) => addStandingApproval(ctx, project.id, draft, MADE));
    expect(value).toMatchObject({ projectId: project.id, kind: draft.kind, origin: 'local' });
    expect(events).toEqual([{ type: 'standing_approval.added', approval: value }]);
    expect(get().standingApprovals).toEqual([value]);
  });

  it('is refused for a project that ended', () => {
    const { run, project } = setup();
    run((ctx) => setProjectState(ctx, project.id, 'completed'));
    expect(() => run((ctx) => addStandingApproval(ctx, project.id, draft, MADE))).toThrow(
      /takes no/,
    );
  });

  it('removes one, dropping the field with the last, not_found otherwise', () => {
    const { run, project, get } = setup();
    const a = run((ctx) => addStandingApproval(ctx, project.id, draft, MADE)).value;
    const { events } = run((ctx) => removeStandingApproval(ctx, project.id, a.id, USER, 'no'));
    expect(events).toEqual([
      {
        type: 'standing_approval.removed',
        projectId: project.id,
        approvalId: a.id,
        by: USER,
        reason: 'no',
      },
    ]);
    expect('standingApprovals' in get()).toBe(false);
    expect(() => run((ctx) => removeStandingApproval(ctx, project.id, a.id, USER, 'x'))).toThrow(
      /no standing approval/,
    );
  });
});

describe('recordApproval', () => {
  it('emits approval.recorded and keeps the newest 100', () => {
    const { run, project, get } = setup();
    const first = run((ctx) => recordApproval(ctx, project.id, rec(0)));
    expect(first.events).toEqual([
      { type: 'approval.recorded', projectId: project.id, approval: rec(0) },
    ]);
    for (let i = 1; i <= 100; i++) run((ctx) => recordApproval(ctx, project.id, rec(i)));
    const list = get().recordedApprovals!;
    expect(list).toHaveLength(100);
    expect(list[0]!.summary).toBe('pnpm test 1');
    expect(list[99]!.summary).toBe('pnpm test 100');
  });
});

describe('endStandingApprovals', () => {
  it('removes each approval as the system and clears recorded approvals', () => {
    const { run, project, get } = setup();
    const a = run((ctx) => addStandingApproval(ctx, project.id, draft, MADE)).value;
    const b = run((ctx) => addStandingApproval(ctx, project.id, draft, MADE)).value;
    run((ctx) => recordApproval(ctx, project.id, rec(1)));
    const { events } = run((ctx) => endStandingApprovals(ctx, project.id, 'completed'));
    expect(events).toEqual(
      [a, b].map((x) => ({
        type: 'standing_approval.removed',
        projectId: project.id,
        approvalId: x.id,
        by: SYSTEM,
        reason: 'the project was closed',
      })),
    );
    expect('standingApprovals' in get()).toBe(false);
    expect('recordedApprovals' in get()).toBe(false);
  });

  it('is wired to closing and archiving a project', () => {
    const { run, project, get } = setup();
    run((ctx) => addStandingApproval(ctx, project.id, draft, MADE));
    run((ctx) => recordApproval(ctx, project.id, rec(1)));
    run((ctx) => setProjectState(ctx, project.id, 'in_progress'));
    const { types } = run((ctx) => closeProject(ctx, project.id, USER));
    expect(types).toContain('standing_approval.removed');
    expect(get().standingApprovals).toBeUndefined();
    expect(get().recordedApprovals).toBeUndefined();
  });
});

describe('recordApproval on a project that ended', () => {
  it('is refused', () => {
    const { run, project } = setup();
    run((ctx) => setProjectState(ctx, project.id, 'completed'));
    expect(() => run((ctx) => recordApproval(ctx, project.id, rec(1)))).toThrow(DomainError);
  });
});

describe('folding the log matches the rows when a project ends with records', () => {
  /** Folds every committed event over the empty snapshot and compares with the live rows. */
  function check(end: (w: ReturnType<typeof setup>) => void) {
    const w = setup();
    const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
    const recorded: EventEnvelope[] = [];
    w.log.subscribe((e) => recorded.push(e));
    w.run((ctx) => addStandingApproval(ctx, w.project.id, draft, MADE));
    w.run((ctx) => recordApproval(ctx, w.project.id, rec(1)));
    expect(w.get().recordedApprovals).toHaveLength(1);
    end(w);
    let world = applySnapshot(start);
    for (const e of recorded) world = applyEvent(world, e);
    expect(world.projects[w.project.id]).toEqual(w.get());
    expect(world.projects[w.project.id]!.recordedApprovals).toBeUndefined();
    expect(w.get().recordedApprovals).toBeUndefined();
  }

  it('closed', () => {
    check((w) => w.run((ctx) => closeProject(ctx, w.project.id, USER)));
  });

  it('archived', () => {
    check((w) => {
      w.run((ctx) => setProjectState(ctx, w.project.id, 'completed'));
      w.run((ctx) => setProjectState(ctx, w.project.id, 'archived'));
    });
  });

  it('cancelled', () => {
    check((w) =>
      w.run((ctx) =>
        recordControl(ctx, { kind: 'project', id: w.project.id }, { action: 'cancel' }, USER),
      ),
    );
  });

  it('a project that merely failed keeps its records, in the row and in the fold', () => {
    const w = setup();
    const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
    const recorded: EventEnvelope[] = [];
    w.log.subscribe((e) => recorded.push(e));
    w.run((ctx) => recordApproval(ctx, w.project.id, rec(1)));
    w.run((ctx) => setProjectState(ctx, w.project.id, 'failed'));
    let world = applySnapshot(start);
    for (const e of recorded) world = applyEvent(world, e);
    expect(world.projects[w.project.id]).toEqual(w.get());
    expect(w.get().recordedApprovals).toHaveLength(1);
  });
});
