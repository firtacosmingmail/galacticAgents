import { describe, expect, it, vi } from 'vitest';
import type { Job, JobRun, Panel } from '@galactic/protocol';
import { evaluateDashboard } from './dashboard.js';

/** P15-04 — every panel's data, in the order given; each job's runs are read once. */

const panel = (id: string, jobId: string, type: Panel['type'] = 'tile'): Panel => ({
  id,
  projectId: 'p-1',
  type,
  title: id,
  source: { kind: 'job', jobId, values: ['sales'] },
  display: {},
  limits: [],
  layout: { order: 0, w: 1, h: 1 },
  createdBy: { type: 'user' },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});
const run: JobRun = {
  id: 'jr-1',
  jobId: 'j-a',
  purpose: 'scheduled',
  dueAt: '2026-10-01T09:00:00.000Z',
  startedAt: '2026-10-01T09:00:00.000Z',
  endedAt: '2026-10-01T09:05:00.000Z',
  outcome: 'quiet',
  numbers: { sales: 7 },
};

describe('evaluateDashboard', () => {
  it('reads each job’s runs once, however many panels read it, and keeps the order', () => {
    const runs = vi.fn((jobId: string) => (jobId === 'j-a' ? [run] : []));
    const data = evaluateDashboard(
      [panel('pn-1', 'j-a'), panel('pn-2', 'j-b'), panel('pn-3', 'j-a', 'line')],
      { job: (id) => ({ id }) as Job, runs, tasks: [] },
      '2026-10-02T00:00:00.000Z',
    );
    expect(data.map((d) => d.panelId)).toEqual(['pn-1', 'pn-2', 'pn-3']);
    expect(runs.mock.calls.map(([id]) => id)).toEqual(['j-a', 'j-b']);
  });
});
