import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  applySnapshot,
  type Actor,
  type AddDeliverableInput,
  type Snapshot,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { EARTH_ID } from './catalogue.js';
import {
  addDeliverable,
  carryTaskDeliverables,
  recordOpened,
  recordRunEnded,
  recordRunPorts,
  recordRunStarted,
  removeDeliverable,
  restoreDeliverable,
  updateDeliverable,
} from './deliverables.js';
import { DomainError } from './errors.js';
import { createProject } from './projects.js';
import { transferTask } from './promotion.js';
import { createTask, moveTask } from './tasks.js';

/** P9-01 — the deliverable commands under the one write rule (TECHNOLOGY §9.1). */

const USER: Actor = { type: 'user' };
const SYSTEM: Actor = { type: 'system' };
const LOCAL = { origin: 'local' as const };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

function setup() {
  const w = world();
  const project = w.run((ctx) =>
    createProject(ctx, { name: 'App', workspace: '/w/app', bodyId: 'b-saturn' }),
  ).value;
  const other = w.run((ctx) =>
    createProject(ctx, { name: 'Other', workspace: '/w/other', bodyId: 'b-mars' }),
  ).value;
  const task = w.run((ctx) =>
    createTask(ctx, { projectId: project.id, description: 'login' }),
  ).value;
  const harmonizer = w.run((ctx) =>
    createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: CAPS, bodyId: EARTH_ID }),
  ).value;
  const steward: Actor = { type: 'agent', id: 'a-steward' };
  const file = (over: Partial<AddDeliverableInput> = {}): AddDeliverableInput => ({
    taskId: task.id,
    kind: 'file',
    title: 'Report',
    source: 'agent',
    location: { storage: 'worktree', path: '/w/app/.galactic/worktrees/t/report.md' },
    ...over,
  });
  return { ...w, project, other, task, harmonizer, steward, file };
}

function refusal(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('not refused');
}

describe('addDeliverable', () => {
  it("adds a task's deliverable with the task's project, version 1, the whole row in its event", () => {
    const { run, tables, task, project, steward, file } = setup();
    const out = run((ctx) => addDeliverable(ctx, file(), steward));
    expect(out.value).toMatchObject({
      taskId: task.id,
      projectId: project.id,
      kind: 'file',
      source: 'agent',
      addedBy: steward,
      version: 1,
    });
    expect(out.events).toEqual([{ type: 'deliverable.added', deliverable: out.value }]);
    expect(tables.deliverables.get(out.value.id)).toEqual(out.value);
    expect(tables.deliverables.of({ projectId: project.id })).toEqual([out.value]);
    expect(tables.deliverables.of({ taskId: task.id })).toEqual([out.value]);
  });

  it('refuses what does not make sense, writing nothing', () => {
    const { run, seen, tables, task, other, steward, file } = setup();
    const before = seen.length;
    const add = (input: AddDeliverableInput, by: Actor = steward, write = {}) =>
      refusal(() => run((ctx) => addDeliverable(ctx, input, by, write)));
    expect(add(file({ taskId: 't-none' })).code).toBe('not_found');
    expect(add(file({ projectId: other.id })).message).toMatch(/belongs to project/);
    expect(add({ ...file(), taskId: undefined } as AddDeliverableInput).message).toMatch(
      /project or a task/,
    );
    expect(add(file({ location: undefined })).message).toMatch(/needs a path/);
    expect(add(file({ location: { storage: 'in_place', path: 'rel/x.md' } })).message).toMatch(
      /absolute/,
    );
    expect(
      add(file({ kind: 'url', location: undefined, url: 'file:///etc/passwd' })).message,
    ).toMatch(/http or https/);
    expect(add(file({ kind: 'command', location: undefined })).message).toMatch(/command line/);
    expect(add(file({ title: '  ' })).message).toMatch(/title/);
    expect(add(file({ source: 'user' })).message).toMatch(/added by the user/);
    expect(add(file(), USER, LOCAL).message).toMatch(/added by its agent/);
    // The user's own additions come from the Mac unless `autoApproveRemote` (decision 131).
    expect(add(file({ source: 'user' }), USER).message).toMatch(/only from this machine/);
    expect(add(file({ source: 'user' }), USER, { origin: 'remote' }).message).toMatch(
      /only from this machine/,
    );
    expect(
      run((ctx) =>
        addDeliverable(ctx, file({ source: 'user' }), USER, {
          origin: 'remote',
          autoApproveRemote: true,
        }),
      ).value.source,
    ).toBe('user');
    expect(seen.length).toBe(before + 1);
    expect(tables.deliverables.of({ taskId: task.id })).toHaveLength(1);
  });

  it('keeps one detected row per project and key, removed or not (decision 119)', () => {
    const { run, project, task } = setup();
    const detected: AddDeliverableInput = {
      projectId: project.id,
      kind: 'command',
      title: 'dev',
      source: 'detected',
      detectedKey: 'package.json#dev',
      command: { line: 'pnpm run dev', cwd: '/w/app', detectedFrom: 'package.json' },
    };
    const dev = run((ctx) => addDeliverable(ctx, detected, SYSTEM)).value;
    run((ctx) => removeDeliverable(ctx, dev.id, USER, undefined, LOCAL));
    expect(refusal(() => run((ctx) => addDeliverable(ctx, detected, SYSTEM))).code).toBe(
      'conflict',
    );
    const { detectedKey: _key, ...withoutKey } = detected;
    expect(refusal(() => run((ctx) => addDeliverable(ctx, withoutKey, SYSTEM))).message).toMatch(
      /detected key/,
    );
    expect(
      refusal(() =>
        run((ctx) =>
          addDeliverable(ctx, { ...detected, projectId: undefined, taskId: task.id }, SYSTEM),
        ),
      ).message,
    ).toMatch(/project's detected/);
  });
});

describe('updateDeliverable, removeDeliverable, restoreDeliverable', () => {
  it('bumps the version on every change, never on a change that changes nothing', () => {
    const { run, steward, file } = setup();
    const d = run((ctx) => addDeliverable(ctx, file(), steward)).value;
    const moved = run((ctx) =>
      updateDeliverable(
        ctx,
        d.id,
        {
          location: {
            storage: 'copy',
            path: '/w/app/deliverables/login/report.md',
            originalPath: d.location!.path,
          },
          meta: { copy: { bytes: 10 } },
        },
        SYSTEM,
      ),
    );
    expect(moved.value.version).toBe(2);
    expect(moved.events).toEqual([
      {
        type: 'deliverable.updated',
        deliverableId: d.id,
        changes: {
          location: {
            storage: 'copy',
            path: '/w/app/deliverables/login/report.md',
            originalPath: d.location!.path,
          },
          meta: { copy: { bytes: 10 } },
        },
        version: 2,
      },
    ]);
    const same = run((ctx) => updateDeliverable(ctx, d.id, { title: 'Report' }, steward));
    expect(same.events).toEqual([]);
    expect(same.value.version).toBe(2);
    // `meta` merges; `null` drops a key, and an emptied meta is cleared.
    const merged = run((ctx) =>
      updateDeliverable(ctx, d.id, { meta: { confirmedOpen: { fingerprint: 'f' } } }, USER, LOCAL),
    ).value;
    expect(merged.meta).toEqual({ copy: { bytes: 10 }, confirmedOpen: { fingerprint: 'f' } });
    const cleared = run((ctx) =>
      updateDeliverable(ctx, d.id, { meta: { copy: null, confirmedOpen: null } }, USER, LOCAL),
    );
    expect(cleared.value).not.toHaveProperty('meta');
    expect(cleared.events[0]).toMatchObject({ changes: { meta: null }, version: 4 });
  });

  it('refuses a stale version, an owner change, a broken shape and an agent on the user’s row', () => {
    const { run, steward, file, project } = setup();
    const d = run((ctx) => addDeliverable(ctx, file(), steward)).value;
    const stale = refusal(() =>
      run((ctx) =>
        updateDeliverable(ctx, d.id, { title: 'x' }, USER, { ...LOCAL, expectedVersion: 3 }),
      ),
    );
    expect(stale.code).toBe('stale');
    expect(
      refusal(() =>
        run((ctx) => updateDeliverable(ctx, d.id, { projectId: project.id } as never, SYSTEM)),
      ).message,
    ).toMatch(/projectId is not edited/);
    expect(
      refusal(() => run((ctx) => updateDeliverable(ctx, d.id, { location: null }, SYSTEM))).message,
    ).toMatch(/needs a path/);
    expect(
      refusal(() => run((ctx) => updateDeliverable(ctx, d.id, { title: 'x' }, USER))).message,
    ).toMatch(/only from this machine/);
    const mine = run((ctx) =>
      addDeliverable(ctx, file({ source: 'user', title: 'Mine' }), USER, LOCAL),
    ).value;
    expect(
      refusal(() => run((ctx) => updateDeliverable(ctx, mine.id, { title: 'y' }, steward))).code,
    ).toBe('conflict');
    expect(
      refusal(() => run((ctx) => removeDeliverable(ctx, mine.id, steward, 'scratch'))).message,
    ).toMatch(/added by the user: an agent cannot remove it/);
  });

  it('removes (the row stays, with who and why) and restores, each bumping the version', () => {
    const { run, tables, steward, file } = setup();
    const waykeeper: Actor = { type: 'agent', id: 'a-wk' };
    const d = run((ctx) => addDeliverable(ctx, file(), steward)).value;
    const removed = run((ctx) => removeDeliverable(ctx, d.id, waykeeper, '  a scratch log '));
    expect(removed.events).toEqual([
      {
        type: 'deliverable.removed',
        deliverableId: d.id,
        by: waykeeper,
        reason: 'a scratch log',
        version: 2,
      },
    ]);
    expect(tables.deliverables.get(d.id)).toMatchObject({
      removedBy: waykeeper,
      removedReason: 'a scratch log',
      version: 2,
    });
    expect(tables.deliverables.get(d.id)?.removedAt).toBeDefined();
    expect(
      refusal(() => run((ctx) => removeDeliverable(ctx, d.id, USER, undefined, LOCAL))).code,
    ).toBe('invalid_transition');
    expect(
      refusal(() => run((ctx) => updateDeliverable(ctx, d.id, { title: 'z' }, USER, LOCAL))).code,
    ).toBe('invalid_transition');
    const restored = run((ctx) => restoreDeliverable(ctx, d.id, USER, LOCAL));
    expect(restored.events).toEqual([
      { type: 'deliverable.restored', deliverableId: d.id, by: USER, version: 3 },
    ]);
    expect(restored.value).not.toHaveProperty('removedAt');
    expect(restored.value).not.toHaveProperty('removedBy');
    expect(restored.value).not.toHaveProperty('removedReason');
    expect(refusal(() => run((ctx) => restoreDeliverable(ctx, d.id, USER, LOCAL))).code).toBe(
      'invalid_transition',
    );
    expect(run((ctx) => recordOpened(ctx, d.id, 'open', USER)).types).toEqual([
      'deliverable.opened',
    ]);
  });
});

describe('runs', () => {
  it('records a run, its ports and its end; one live run per deliverable; the history projected', () => {
    const { run, tables, project, file, steward } = setup();
    const dev = run((ctx) =>
      addDeliverable(
        ctx,
        {
          projectId: project.id,
          kind: 'command',
          title: 'dev',
          source: 'detected',
          detectedKey: 'package.json#dev',
          command: { line: 'pnpm run dev', cwd: '/w/app' },
        },
        SYSTEM,
      ),
    ).value;
    const started = run((ctx) =>
      recordRunStarted(
        ctx,
        { runId: 'r-1', deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/app' },
        USER,
      ),
    );
    expect(started.types).toEqual(['run.started']);
    expect(tables.deliverables.get(dev.id)?.lastRun).toMatchObject({
      runId: 'r-1',
      state: 'running',
    });
    expect(tables.deliverables.get(dev.id)?.version).toBe(1); // a run is not a change of the row
    expect(
      refusal(() =>
        run((ctx) =>
          recordRunStarted(
            ctx,
            { deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/app' },
            USER,
          ),
        ),
      ).code,
    ).toBe('conflict');
    const doc = run((ctx) => addDeliverable(ctx, file(), steward)).value;
    expect(
      refusal(() =>
        run((ctx) => recordRunStarted(ctx, { deliverableId: doc.id, line: 'x', cwd: '/w' }, USER)),
      ).message,
    ).toMatch(/not a command/);
    expect(run((ctx) => recordRunPorts(ctx, 'r-1', [5174, 5173, 5173])).types).toEqual([
      'run.ports',
    ]);
    expect(run((ctx) => recordRunPorts(ctx, 'r-1', [5173, 5174])).types).toEqual([]);
    expect(tables.runs.get('r-1')?.ports).toEqual([5173, 5174]);
    run((ctx) => recordRunEnded(ctx, 'r-1', { outcome: 'stopped', by: USER }));
    expect(
      run((ctx) => recordRunEnded(ctx, 'r-1', { outcome: 'exited', exitCode: 0 })).types,
    ).toEqual([]);
    expect(tables.runs.get('r-1')).toMatchObject({
      state: 'ended',
      outcome: 'stopped',
      stoppedBy: USER,
    });
    expect(tables.deliverables.get(dev.id)?.lastRun).toMatchObject({
      state: 'ended',
      outcome: 'stopped',
      ports: [5173, 5174],
    });
    expect(refusal(() => run((ctx) => recordRunPorts(ctx, 'r-1', [1]))).code).toBe(
      'invalid_transition',
    );
    const second = run((ctx) =>
      recordRunStarted(ctx, { deliverableId: dev.id, line: 'pnpm run dev', cwd: '/w/app' }, USER),
    ).value;
    run((ctx) => recordRunEnded(ctx, second.id, { outcome: 'exited', exitCode: 1 }));
    expect(tables.runs.of(dev.id).map((r) => r.id)).toEqual([second.id, 'r-1']);
  });
});

describe('moves carry deliverables (decision 124)', () => {
  it('moveTask and transferTask carry every row of the task, removed ones too, in the same command', () => {
    const { run, tables, project, other, steward, file, harmonizer } = setup();
    const standalone = run((ctx) =>
      createTask(ctx, { description: 'chore', meta: { workspace: '/w/s' } }),
    ).value;
    const a = run((ctx) => addDeliverable(ctx, file({ taskId: standalone.id }), steward)).value;
    expect(a).not.toHaveProperty('projectId');
    const b = run((ctx) =>
      addDeliverable(ctx, file({ taskId: standalone.id, title: 'B' }), steward),
    ).value;
    run((ctx) => removeDeliverable(ctx, b.id, steward));
    // The Waykeeper the hand-over needs (P2-12).
    run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: CAPS,
        projectId: project.id,
        supervisorId: harmonizer.id,
      }),
    );
    const moved = run((ctx) => moveTask(ctx, standalone.id, project.id, USER));
    const updates = moved.events.filter((e) => e.type === 'deliverable.updated');
    expect(updates).toEqual([
      {
        type: 'deliverable.updated',
        deliverableId: a.id,
        changes: { projectId: project.id },
        version: 2,
      },
      {
        type: 'deliverable.updated',
        deliverableId: b.id,
        changes: { projectId: project.id },
        version: 3,
      },
    ]);
    expect(tables.deliverables.of({ projectId: project.id }).map((d) => d.id)).toEqual([
      a.id,
      b.id,
    ]);
    run((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: CAPS,
        projectId: other.id,
        supervisorId: harmonizer.id,
      }),
    );
    run((ctx) => transferTask(ctx, standalone.id, other.id));
    expect(tables.deliverables.get(a.id)).toMatchObject({ projectId: other.id, version: 3 });
    expect(tables.deliverables.of({ projectId: project.id })).toEqual([]);
    // Nothing to carry: nothing logged.
    expect(run((ctx) => carryTaskDeliverables(ctx, standalone.id, other.id)).events).toEqual([]);
  });
});

describe('the world fold agrees with the commands', () => {
  it('folding every deliverable and run event gives the tables', () => {
    const { log, run, steward, file, project } = setup();
    const start: Snapshot = { ...log.snapshot(), statuses: [] };
    const recorded = log.eventsSince(start.seq, Number.MAX_SAFE_INTEGER);
    expect(recorded).toEqual([]);
    const from = log.currentSeq();
    const d = run((ctx) => addDeliverable(ctx, file({ description: 'first' }), steward)).value;
    run((ctx) => updateDeliverable(ctx, d.id, { description: null, title: 'Renamed' }, steward));
    run((ctx) => removeDeliverable(ctx, d.id, steward));
    run((ctx) => restoreDeliverable(ctx, d.id, USER, LOCAL));
    run((ctx) => recordOpened(ctx, d.id, 'reveal', USER));
    const cmd = run((ctx) =>
      addDeliverable(
        ctx,
        {
          projectId: project.id,
          kind: 'command',
          title: 'test',
          source: 'user',
          command: { line: 'make test', cwd: '/w/app' },
        },
        USER,
        LOCAL,
      ),
    ).value;
    const r = run((ctx) =>
      recordRunStarted(ctx, { deliverableId: cmd.id, line: 'make test', cwd: '/w/app' }, USER),
    ).value;
    run((ctx) => recordRunPorts(ctx, r.id, [8080]));
    run((ctx) => recordRunEnded(ctx, r.id, { outcome: 'exited', exitCode: 2 }));
    let worldNow = applySnapshot(start);
    for (const e of log.eventsSince(from, Number.MAX_SAFE_INTEGER))
      worldNow = applyEvent(worldNow, e);
    expect(Object.values(worldNow.deliverables)).toEqual(log.snapshot().deliverables);
  });
});
