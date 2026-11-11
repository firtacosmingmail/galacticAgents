import { describe, expect, it } from 'vitest';
import type { Event, EventEnvelope } from './events.js';
import { applyEvent, applySnapshot, emptyWorld, panelsOf } from './world.js';
import { SnapshotMessage } from './ws.js';
import * as d from './fixtures/domain.js';
import { events } from './fixtures/events.js';

const at = (n: number) => `2026-10-24T09:00:${String(n).padStart(2, '0')}.000Z`;
const env = (seq: number, event: Event): EventEnvelope => ({ seq, at: at(seq), event });

describe('the world fold of area.*, job.* and job_run.* (P10-01)', () => {
  it('folds areas and jobs, stamping updatedAt on changes', () => {
    let w = applyEvent(emptyWorld(), env(1, events['area.created']));
    w = applyEvent(w, env(2, events['job.created']));
    expect(w.areas[d.area.id]).toEqual(d.area);
    expect(w.jobs[d.job.id]).toEqual(d.job);

    w = applyEvent(
      w,
      env(3, { type: 'job.updated', jobId: d.job.id, changes: { state: 'paused' } }),
    );
    expect(w.jobs[d.job.id]).toEqual({ ...d.job, state: 'paused', updatedAt: at(3) });

    w = applyEvent(
      w,
      env(4, { type: 'area.updated', areaId: d.area.id, changes: { name: 'Sales' } }),
    );
    expect(w.areas[d.area.id]).toEqual({ ...d.area, name: 'Sales', updatedAt: at(4) });
  });

  it('clears a job field with null', () => {
    let w = applyEvent(emptyWorld(), env(1, events['job.created']));
    w = applyEvent(
      w,
      env(2, { type: 'job.updated', jobId: d.job.id, changes: { nextRunAt: null } }),
    );
    expect(w.jobs[d.job.id]).not.toHaveProperty('nextRunAt');
  });

  it('job_run.* leave the world as it was (run history is REST)', () => {
    const before = applyEvent(emptyWorld(), env(1, events['job.created']));
    const started = applyEvent(before, env(2, events['job_run.started']));
    expect(started).toEqual({ ...before, seq: 2 });
    const ended = applyEvent(started, env(3, events['job_run.ended']));
    expect(ended).toEqual({ ...before, seq: 3 });
  });

  it('an update to an unknown job or area changes nothing', () => {
    const w = applyEvent(emptyWorld(), env(1, events['job.updated']));
    expect(w.jobs).toEqual({});
  });

  it('a world built before P10-01 folds the new events', () => {
    const { areas: _a, jobs: _j, ...old } = emptyWorld();
    const w = applyEvent(old as ReturnType<typeof emptyWorld>, env(1, events['job.created']));
    expect(w.jobs[d.job.id]).toEqual(d.job);
  });
});

describe('snapshots with and without areas and jobs', () => {
  const base = {
    type: 'snapshot',
    logId: 'log-1',
    seq: 5,
    agents: [],
    bodies: [],
    projects: [],
    tasks: [],
    questions: [],
    proposals: [],
    statuses: [],
  };

  it('applies a snapshot that carries them', () => {
    const w = applySnapshot(SnapshotMessage.parse({ ...base, areas: [d.area], jobs: [d.job] }));
    expect(w.areas).toEqual({ [d.area.id]: d.area });
    expect(w.jobs).toEqual({ [d.job.id]: d.job });
  });

  it('an older server’s snapshot gives empty records', () => {
    const w = applySnapshot(SnapshotMessage.parse(base));
    expect(w.areas).toEqual({});
    expect(w.jobs).toEqual({});
  });
});

describe('the world fold of panel.* and panels.arranged (P15-01)', () => {
  const second = {
    ...d.panel,
    id: 'pn-2',
    title: 'Second',
    layout: { order: 1, w: 2, h: 1 },
  } as const;

  it('folds created, updated, arranged and removed; panelsOf sorts by order', () => {
    let w = applyEvent(emptyWorld(), env(1, events['panel.created']));
    w = applyEvent(w, env(2, { type: 'panel.created', panel: second }));
    expect(panelsOf(w, d.panel.projectId).map((p) => p.id)).toEqual(['pn-1', 'pn-2']);

    w = applyEvent(
      w,
      env(3, {
        type: 'panel.updated',
        panelId: 'pn-1',
        changes: { layout: { order: 5, w: 1, h: 1 } },
        by: { type: 'user' },
      }),
    );
    expect(w.panels['pn-1']?.layout.order).toBe(5);
    expect(w.panels['pn-1']?.updatedAt).toBe(at(3));
    expect(panelsOf(w, d.panel.projectId).map((p) => p.id)).toEqual(['pn-2', 'pn-1']);

    w = applyEvent(
      w,
      env(4, {
        type: 'panels.arranged',
        projectId: d.panel.projectId,
        layouts: [
          { panelId: 'pn-1', layout: { order: 0, w: 1, h: 1 } },
          { panelId: 'pn-2', layout: { order: 1, w: 4, h: 2, hidden: true } },
          { panelId: 'pn-unknown', layout: { order: 2, w: 1, h: 1 } },
        ],
        by: { type: 'user' },
      }),
    );
    expect(panelsOf(w, d.panel.projectId).map((p) => p.id)).toEqual(['pn-1', 'pn-2']);
    expect(w.panels['pn-2']?.layout).toEqual({ order: 1, w: 4, h: 2, hidden: true });
    expect(w.panels['pn-unknown']).toBeUndefined();

    w = applyEvent(w, env(5, events['panel.removed']));
    expect(Object.keys(w.panels)).toEqual(['pn-2']);
  });

  it('job.values_cleared folds to nothing, and panelsOf is per project', () => {
    const w = applyEvent(emptyWorld(), env(1, events['panel.created']));
    const after = applyEvent(w, env(2, events['job.values_cleared']));
    expect(after.panels).toEqual(w.panels);
    expect(panelsOf(after, 'other-project')).toEqual([]);
  });

  it('a snapshot carries the panels; an older one gives none', () => {
    const base = {
      type: 'snapshot',
      logId: 'log-1',
      seq: 5,
      agents: [],
      bodies: [],
      projects: [],
      tasks: [],
      questions: [],
      proposals: [],
      statuses: [],
    };
    expect(applySnapshot(SnapshotMessage.parse({ ...base, panels: [d.panel] })).panels).toEqual({
      [d.panel.id]: d.panel,
    });
    expect(applySnapshot(SnapshotMessage.parse(base)).panels).toEqual({});
  });
});
