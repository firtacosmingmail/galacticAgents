import { describe, expect, it } from 'vitest';
import {
  affectedPanels,
  DASHBOARD_LIMITS,
  DataName,
  JobDataMap,
  Panel,
  RunData,
  Threshold,
} from './dashboard.js';
import { Job, JobDraft, JobRun } from './long-term.js';
import * as d from './fixtures/domain.js';

describe('DataName', () => {
  it('accepts snake_case names and rejects the rest', () => {
    expect(DataName.safeParse('churn_by_plan').success).toBe(true);
    expect(DataName.safeParse('Churn').success).toBe(false);
    expect(DataName.safeParse('1x').success).toBe(false);
    expect(DataName.safeParse('a'.repeat(60)).success).toBe(true);
    expect(DataName.safeParse('a'.repeat(61)).success).toBe(false);
  });
});

describe('JobDataMap', () => {
  const source = { id: 'crm', label: 'CRM', kind: 'mcp', target: 'crm-server' } as const;
  const collect = {
    name: 'messages',
    kind: 'number',
    sourceIds: ['crm'],
    description: 'New messages',
  } as const;

  it('accepts a consistent map and rejects a collect naming a missing source', () => {
    const ok = {
      sources: [source],
      collects: [collect],
      steps: [{ text: 'Count', uses: ['crm'], produces: ['messages'] }],
    };
    expect(JobDataMap.safeParse(ok).success).toBe(true);
    expect(
      JobDataMap.safeParse({ ...ok, collects: [{ ...collect, sourceIds: ['nope'] }] }).success,
    ).toBe(false);
  });

  it('rejects a step that uses or produces something unknown', () => {
    const base = { sources: [source], collects: [collect] };
    expect(
      JobDataMap.safeParse({ ...base, steps: [{ text: 'x', uses: ['zzz'], produces: [] }] })
        .success,
    ).toBe(false);
    expect(
      JobDataMap.safeParse({ ...base, steps: [{ text: 'x', uses: [], produces: ['zzz'] }] })
        .success,
    ).toBe(false);
  });

  it('rejects more than 20 sources', () => {
    const sources = Array.from({ length: 21 }, (_, i) => ({ ...source, id: `s${i}` }));
    expect(JobDataMap.safeParse({ sources, collects: [], steps: [] }).success).toBe(false);
  });
});

describe('RunData', () => {
  const table = { columns: ['a'], rows: [['x']] };

  it('accepts a small report', () => {
    expect(
      RunData.safeParse({
        tables: {
          plans: {
            columns: ['plan', 'n'],
            rows: [
              ['pro', 3],
              ['free', null],
            ],
          },
        },
        lists: { todo: [{ title: 'Call back' }] },
        calendars: { due: [{ date: '2026-11-11', title: 'Invoice' }] },
        statuses: { board: [{ column: 'open', title: 'Fix' }] },
        texts: { note: 'hello' },
        sourceProblems: [{ sourceId: 'crm', problem: 'timeout' }],
      }).success,
    ).toBe(true);
  });

  it('rejects 11 tables and a 201-row table', () => {
    const tables = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`t${i}`, table]));
    expect(RunData.safeParse({ tables }).success).toBe(false);
    const rows = Array.from({ length: DASHBOARD_LIMITS.maxTableRows + 1 }, () => ['x']);
    expect(RunData.safeParse({ tables: { big: { columns: ['a'], rows } } }).success).toBe(false);
  });

  it('rejects a table row whose length differs from its columns', () => {
    const bad = (rows: unknown[][]) =>
      RunData.safeParse({ tables: { t: { columns: ['a', 'b'], rows } } });
    expect(bad([['x', 1]]).success).toBe(true);
    expect(bad([['x']]).success).toBe(false);
    expect(bad([['x', 1, 2]]).success).toBe(false);
  });

  it('rejects a bad name, a long cell and data over 256 KiB', () => {
    expect(RunData.safeParse({ tables: { Bad: table } }).success).toBe(false);
    expect(
      RunData.safeParse({ tables: { t: { columns: ['a'], rows: [['x'.repeat(301)]] } } }).success,
    ).toBe(false);
    const texts = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`t${i}`, 'x'.repeat(4000)]),
    );
    expect(RunData.safeParse({ texts }).success).toBe(true);
    const rows = Array.from({ length: 200 }, () =>
      Array.from({ length: 12 }, () => 'y'.repeat(300)),
    );
    const tables = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`t${i}`, { columns: ['a'], rows }]),
    );
    expect(RunData.safeParse({ tables }).success).toBe(false);
  });
});

describe('Panel', () => {
  it('rejects a tile on the project’s tasks and accepts a status panel on them', () => {
    expect(Panel.safeParse({ ...d.panel, source: { kind: 'tasks' } }).success).toBe(false);
    expect(Panel.safeParse({ ...d.panel, type: 'status', source: { kind: 'tasks' } }).success).toBe(
      true,
    );
    expect(Panel.safeParse(d.panel).success).toBe(true);
  });

  it('limits a panel to 8 values and 8 limits', () => {
    const values = Array.from({ length: 9 }, (_, i) => `v${i}`);
    expect(
      Panel.safeParse({ ...d.panel, source: { kind: 'job', jobId: 'j-1', values } }).success,
    ).toBe(false);
    expect(
      Panel.safeParse({ ...d.panel, limits: Array.from({ length: 9 }, () => d.panel.limits[0]) })
        .success,
    ).toBe(false);
  });
});

describe('Threshold', () => {
  it('rejects a zero percent', () => {
    expect(Threshold.safeParse({ op: 'rise', percent: 0, vs: 'week' }).success).toBe(false);
    expect(Threshold.safeParse({ op: 'fall', percent: 10, vs: 'month' }).success).toBe(true);
    expect(Threshold.safeParse({ op: 'above', value: 0 }).success).toBe(true);
  });
});

describe('jobs and runs with dashboard data', () => {
  const dataMap = {
    sources: [{ id: 'crm', label: 'CRM', kind: 'mcp', target: 'crm' }],
    collects: [{ name: 'messages', kind: 'number', sourceIds: ['crm'], description: '' }],
    steps: [],
  };

  it('a job and a draft may carry a data map; older jobs have none', () => {
    expect(Job.safeParse(d.job).success).toBe(true);
    expect(Job.parse({ ...d.job, dataMap }).dataMap).toEqual(dataMap);
    expect(JobDraft.parse({ ...d.job, dataMap }).dataMap).toEqual(dataMap);
  });

  it('a run may carry data and sources, and may be a refresh', () => {
    const run = {
      ...d.jobRun,
      purpose: 'refresh',
      data: { texts: { note: 'hi' } },
      sources: [{ kind: 'site', target: 'https://example.com' }],
    };
    expect(JobRun.parse(run)).toEqual(run);
  });
});

describe('affectedPanels', () => {
  const other = {
    ...d.panel,
    id: 'pn-2',
    source: { kind: 'job', jobId: 'j-2', values: ['x'] },
  } as const;
  const tasks = { ...d.panel, id: 'pn-3', type: 'status', source: { kind: 'tasks' } } as const;
  const panels = [d.panel, other, tasks] as Panel[];

  it('without a data map: every panel sourced from the job', () => {
    expect(affectedPanels(panels, 'j-1').map((p) => p.id)).toEqual(['pn-1']);
  });

  it('with a data map: those reading a value it no longer collects', () => {
    const keeps = {
      sources: [{ id: 'crm', label: 'CRM', kind: 'mcp', target: 'crm' }],
      collects: [{ name: 'messages', kind: 'number', sourceIds: ['crm'], description: '' }],
      steps: [],
    } as const;
    expect(affectedPanels(panels, 'j-1', keeps as never)).toEqual([]);
    expect(
      affectedPanels(panels, 'j-1', { sources: [], collects: [], steps: [] }).map((p) => p.id),
    ).toEqual(['pn-1']);
  });
});
