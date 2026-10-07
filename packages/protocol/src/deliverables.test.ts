import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AddDeliverableBody,
  Deliverable,
  DeliverablesQuery,
  deliverableShapeError,
  isDeliverableUrl,
  isRunLive,
} from './deliverables.js';
import { Event, EVENT_TYPES, type EventEnvelope } from './events.js';
import { applyEvent, applySnapshot, emptyWorld } from './world.js';
import { ServerMessage, SnapshotMessage } from './ws.js';
import * as d from './fixtures/domain.js';
import { events } from './fixtures/events.js';

/** P9-01 — the deliverables vocabulary, its fold, and what a page of the previous build reads. */

const NEW_TYPES = [
  'deliverable.added',
  'deliverable.updated',
  'deliverable.removed',
  'deliverable.restored',
  'deliverable.opened',
  'run.started',
  'run.ports',
  'run.ended',
] as const;

const at = (n: number) => `2026-10-07T10:00:${String(n).padStart(2, '0')}.000Z`;
const env = (seq: number, event: Event): EventEnvelope => ({ seq, at: at(seq), event });

describe('deliverable rows', () => {
  it('parses the fixtures and checks the shape each kind needs', () => {
    expect(Deliverable.parse(d.deliverable)).toEqual(d.deliverable);
    expect(Deliverable.parse(d.commandDeliverable)).toEqual(d.commandDeliverable);
    expect(deliverableShapeError(d.deliverable)).toBeUndefined();
    expect(deliverableShapeError(d.commandDeliverable)).toBeUndefined();
    expect(deliverableShapeError({ ...d.deliverable, location: undefined })).toMatch(/path/);
    expect(
      deliverableShapeError({ ...d.deliverable, projectId: undefined, taskId: undefined }),
    ).toMatch(/project or a task/);
    expect(deliverableShapeError({ ...d.commandDeliverable, url: 'https://x.dev' })).toMatch(
      /no address/,
    );
    expect(
      deliverableShapeError({ kind: 'url', url: 'javascript:alert(1)', projectId: 'p-1' }),
    ).toMatch(/http or https/);
    expect(isDeliverableUrl('http://localhost:5173/')).toBe(true);
    expect(isDeliverableUrl('file:///etc/passwd')).toBe(false);
    expect(isRunLive(d.commandDeliverable)).toBe(true);
    expect(isRunLive(d.deliverable)).toBe(false);
  });

  it('reads the REST bodies', () => {
    expect(DeliverablesQuery.parse({ projectId: 'p-1', removed: '1' })).toEqual({
      projectId: 'p-1',
      removed: true,
    });
    expect(AddDeliverableBody.safeParse({ kind: 'file', title: 'x', path: '/a' }).success).toBe(
      false,
    );
    expect(
      AddDeliverableBody.parse({ taskId: 't-1', kind: 'file', title: '  Notes ', path: '/a' }),
    ).toMatchObject({ title: 'Notes' });
  });
});

describe('the world fold of deliverable.* and run.*', () => {
  it('adds, updates (version, updatedAt, null clears), removes and restores; opened changes nothing', () => {
    let w = emptyWorld();
    w = applyEvent(w, env(1, events['deliverable.added']));
    expect(w.deliverables['d-1']).toEqual(d.deliverable);
    w = applyEvent(
      w,
      env(2, {
        type: 'deliverable.updated',
        deliverableId: 'd-1',
        changes: { title: 'Login', description: null },
        version: 2,
      }),
    );
    expect(w.deliverables['d-1']).toMatchObject({ title: 'Login', version: 2, updatedAt: at(2) });
    expect(w.deliverables['d-1']).not.toHaveProperty('description');
    w = applyEvent(w, env(3, events['deliverable.removed']));
    expect(w.deliverables['d-1']).toMatchObject({
      removedAt: at(3),
      removedBy: { type: 'agent', id: 'a-waykeeper-1' },
      removedReason: 'a scratch log',
      version: 3,
    });
    w = applyEvent(w, env(4, events['deliverable.restored']));
    expect(w.deliverables['d-1']).not.toHaveProperty('removedAt');
    expect(w.deliverables['d-1']).not.toHaveProperty('removedBy');
    expect(w.deliverables['d-1']).not.toHaveProperty('removedReason');
    const before = w.deliverables;
    w = applyEvent(w, env(5, events['deliverable.opened']));
    expect(w.deliverables).toBe(before);
    expect(w.seq).toBe(5);
  });

  it("folds runs into the command's lastRun, ignoring an older run's events", () => {
    const { lastRun: _none, ...command } = d.commandDeliverable;
    let w = applyEvent(emptyWorld(), env(1, { type: 'deliverable.added', deliverable: command }));
    w = applyEvent(w, env(2, { type: 'run.started', run: { ...d.run, startedAt: at(2) } }));
    expect(w.deliverables['d-2']?.lastRun).toEqual({
      runId: 'r-1',
      state: 'running',
      startedAt: at(2),
      ports: [],
    });
    expect(w.deliverables['d-2']?.version).toBe(2); // a run is not a change of the row
    w = applyEvent(w, env(3, events['run.ports']));
    expect(w.deliverables['d-2']?.lastRun?.ports).toEqual([5173]);
    w = applyEvent(w, env(4, { ...events['run.ports'], runId: 'r-old', ports: [1] }));
    expect(w.deliverables['d-2']?.lastRun?.ports).toEqual([5173]);
    w = applyEvent(w, env(5, events['run.ended']));
    expect(w.deliverables['d-2']?.lastRun).toEqual({
      runId: 'r-1',
      state: 'ended',
      startedAt: at(2),
      endedAt: at(5),
      outcome: 'stopped',
      ports: [5173],
    });
  });

  it('a world built before deliverables existed (no key) still folds them', () => {
    const { deliverables: _gone, ...old } = emptyWorld();
    const w = applyEvent(old as ReturnType<typeof emptyWorld>, env(1, events['deliverable.added']));
    expect(w.deliverables['d-1']).toEqual(d.deliverable);
  });
});

describe('protocol evolution (TECHNOLOGY §6.3 rule 5)', () => {
  const snapshot = {
    type: 'snapshot' as const,
    logId: 'log-1',
    seq: 9,
    agents: [d.agent],
    bodies: [d.body],
    projects: [d.project],
    tasks: [d.task],
    questions: [],
    proposals: [],
    statuses: [],
    deliverables: [d.deliverable, d.commandDeliverable],
  };

  it('this build reads the snapshot and folds it into the world', () => {
    const parsed = ServerMessage.parse(snapshot);
    expect(parsed).toEqual(snapshot);
    expect(applySnapshot(SnapshotMessage.parse(snapshot)).deliverables['d-2']).toEqual(
      d.commandDeliverable,
    );
    // A server before Phase 9 sends none: the world has none.
    const { deliverables: _none, ...older } = snapshot;
    expect(applySnapshot(SnapshotMessage.parse(older)).deliverables).toEqual({});
  });

  it('a page built before this change parses a snapshot that carries them (the key is dropped)', () => {
    const previous = SnapshotMessage.omit({ deliverables: true });
    const parsed = previous.parse(snapshot);
    expect(parsed).not.toHaveProperty('deliverables');
    expect(parsed.projects).toEqual([d.project]);
  });

  it('a page built before this change skips the new events by their type (its union lacks them)', () => {
    const previousTypes = EVENT_TYPES.filter((t) => !(NEW_TYPES as readonly string[]).includes(t));
    const previousEvent = z.discriminatedUnion(
      'type',
      Event.options.filter((o) => previousTypes.includes(o.shape.type.value)) as unknown as [
        z.ZodObject<{ type: z.ZodLiteral<string> }>,
      ],
    );
    for (const type of NEW_TYPES) {
      const frame = { type: 'event', seq: 10, at: at(10), event: events[type] };
      // Its envelope is valid and its type unknown to that build: skipped, not unreadable.
      expect(previousEvent.safeParse(frame.event).success, type).toBe(false);
      expect(previousTypes.includes(frame.event.type), type).toBe(false);
      expect(ServerMessage.parse(frame), type).toEqual(frame);
    }
  });
});
