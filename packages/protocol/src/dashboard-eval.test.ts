import { describe, expect, it } from 'vitest';
import type { Panel } from './dashboard.js';
import { DashboardResponse, PanelData, evaluatePanel, unchangedSince } from './dashboard-eval.js';
import type { Task } from './domain.js';
import type { Job, JobRun } from './long-term.js';
import * as d from './fixtures/domain.js';

/**
 * P15-04 — the pure panel evaluator: which runs a panel reads, when it is stale, empty or "no
 * longer reported", the tile comparison, very bad / very good, the snapshots and the task board.
 */

const NOW = '2026-10-20T12:00:00.000Z';
const DAY = 86_400_000;
const daysAgo = (n: number): string => new Date(Date.parse(NOW) - n * DAY).toISOString();

let seq = 0;
function run(at: string, numbers?: Record<string, number>, extra: Partial<JobRun> = {}): JobRun {
  seq += 1;
  return {
    id: `jr-${seq}`,
    jobId: 'j-1',
    purpose: 'scheduled',
    dueAt: at,
    startedAt: at,
    endedAt: at,
    outcome: 'quiet',
    ...(numbers ? { numbers } : {}),
    ...extra,
  };
}

const job = (extra: Partial<Job> = {}): Job => ({ ...d.job, ...extra });

function tile(value: string, extra: Partial<Panel> = {}): Panel {
  return {
    ...d.panel,
    type: 'tile',
    title: 'Churn',
    source: { kind: 'job', jobId: 'j-1', values: [value] },
    display: { compare: 'week' },
    limits: [],
    ...extra,
  };
}

/** Runs are passed newest first; these helpers take them oldest first for readability. */
const newestFirst = (...runs: JobRun[]): JobRun[] => [...runs].reverse();

describe('evaluatePanel — a tile', () => {
  it('a value reported under another name is "no longer reported", keeps the last value, no verdict (Review Focus 1)', () => {
    const panel = tile('churn_30d', {
      limits: [{ value: 'churn_30d', better: 'lower', veryBad: { op: 'above', value: 1 } }],
    });
    const runs = newestFirst(run(daysAgo(1), { churn_30d: 4.1 }), run(daysAgo(0), { churn: 4.0 }));
    const data = evaluatePanel(panel, job(), runs, NOW);
    expect(data.status).toBe('not_reported');
    expect(data.tile?.value).toBe(4.1);
    expect(data.verdict).toBeUndefined();
    expect(PanelData.parse(data)).toEqual(data);
  });

  it('a failed last run makes the panel stale: no verdict from the older value past veryBad (Review Focus 4)', () => {
    const panel = tile('churn', {
      limits: [{ value: 'churn', better: 'lower', veryBad: { op: 'above', value: 6 } }],
    });
    const good = run(daysAgo(2), { churn: 7 });
    const failed = run(daysAgo(1), undefined, { outcome: 'failed' });
    const data = evaluatePanel(
      panel,
      job({
        lastRun: {
          runId: failed.id,
          outcome: 'failed',
          purpose: 'scheduled',
          startedAt: failed.startedAt,
        },
      }),
      newestFirst(good, failed),
      NOW,
    );
    expect(data.status).toBe('stale');
    expect(data.verdict).toBeUndefined();
    expect(data.tile?.value).toBe(7);
    expect(data.lastGoodAt).toBe(good.endedAt);
  });

  it('a limited last run is stale too; a paused or stopped job says so', () => {
    const runs = [run(daysAgo(1), { churn: 3 })];
    const limited = job({
      lastRun: { runId: 'x', outcome: 'limited', purpose: 'scheduled', startedAt: daysAgo(0) },
    });
    expect(evaluatePanel(tile('churn'), limited, runs, NOW).status).toBe('stale');
    expect(evaluatePanel(tile('churn'), job({ state: 'paused' }), runs, NOW).status).toBe(
      'job_paused',
    );
    expect(evaluatePanel(tile('churn'), job({ state: 'stopped' }), runs, NOW).status).toBe(
      'job_stopped',
    );
  });

  it('no run since historyFrom is empty; one run gives a value without comparison (Review Focus 5)', () => {
    const old = run(daysAgo(10), { churn: 5 });
    const cleared = tile('churn', { historyFrom: daysAgo(3) });
    const empty = evaluatePanel(cleared, job(), [old], NOW);
    expect(empty.status).toBe('empty');
    expect(empty.tile).toBeUndefined();
    expect(evaluatePanel(tile('churn'), job(), [], NOW).status).toBe('empty');

    const one = run(daysAgo(1), { churn: 4 });
    const data = evaluatePanel(cleared, job(), newestFirst(old, one), NOW);
    expect(data.status).toBe('ok');
    expect(data.tile).toEqual({ value: 4 });

    const line = evaluatePanel({ ...cleared, type: 'line' }, job(), newestFirst(old, one), NOW);
    expect(line.series).toEqual([{ name: 'churn', points: [{ at: one.startedAt, value: 4 }] }]);
  });

  it('reads only good runs: a failed, interrupted or running run is skipped', () => {
    const runs = newestFirst(
      run(daysAgo(3), { churn: 2 }),
      run(daysAgo(2), { churn: 9 }, { outcome: 'interrupted' }),
      run(daysAgo(1), { churn: 3 }, { outcome: 'findings' }),
      run(daysAgo(0), { churn: 8 }, { outcome: 'running', endedAt: undefined }),
    );
    const data = evaluatePanel({ ...tile('churn'), type: 'line' }, job(), runs, NOW);
    expect(data.series?.[0]?.points.map((p) => p.value)).toEqual([2, 3]);
  });

  it('compares with the newest good run at least a week (or a month) older', () => {
    const runs = newestFirst(
      run(daysAgo(40), { churn: 8 }),
      run(daysAgo(9), { churn: 5 }),
      run(daysAgo(7), { churn: 4 }),
      run(daysAgo(3), { churn: 3.5 }),
      run(daysAgo(0), { churn: 3 }),
    );
    const week = evaluatePanel(tile('churn'), job(), runs, NOW).tile!;
    expect(week).toMatchObject({ value: 3, previous: 4, changeAbs: -1, changePct: -25 });
    const month = evaluatePanel(
      tile('churn', { display: { compare: 'month' } }),
      job(),
      runs,
      NOW,
    ).tile!;
    expect(month).toMatchObject({ value: 3, previous: 8, changeAbs: -5 });
    // Nothing old enough: no comparison at all (never +0% or NaN).
    const recent = evaluatePanel(tile('churn'), job(), runs.slice(0, 2), NOW).tile!;
    expect(recent).toEqual({ value: 3 });
  });
});

describe('evaluatePanel — very bad / very good', () => {
  it('better lower and a 10% fall vs a week ago is very good, arrow down', () => {
    const panel = tile('churn', {
      limits: [
        { value: 'churn', better: 'lower', veryGood: { op: 'fall', percent: 10, vs: 'week' } },
      ],
    });
    const now = run(daysAgo(0), { churn: 4.1 });
    const data = evaluatePanel(panel, job(), newestFirst(run(daysAgo(7), { churn: 5 }), now), NOW);
    expect(data.status).toBe('ok');
    expect(data.verdict).toEqual({
      kind: 'very_good',
      value: 'churn',
      arrow: 'down',
      resultId: now.id,
    });
  });

  it('above 6 with 6.5 is very bad, arrow up; very bad wins over very good', () => {
    const panel = tile('churn', {
      limits: [
        {
          value: 'churn',
          better: 'lower',
          veryBad: { op: 'above', value: 6 },
          veryGood: { op: 'above', value: 1 },
        },
      ],
    });
    const now = run(daysAgo(0), { churn: 6.5 });
    expect(evaluatePanel(panel, job(), [now], NOW).verdict).toEqual({
      kind: 'very_bad',
      value: 'churn',
      arrow: 'up',
      resultId: now.id,
    });
  });

  it('a chart judges its series’ latest values; a table is never judged', () => {
    const limits = [
      {
        value: 'visits',
        better: 'higher' as const,
        veryGood: { op: 'above' as const, value: 100 },
      },
    ];
    const runs = newestFirst(run(daysAgo(1), { visits: 50 }), run(daysAgo(0), { visits: 150 }));
    const chart: Panel = {
      ...tile('visits', { limits }),
      type: 'bar',
    };
    expect(evaluatePanel(chart, job(), runs, NOW).verdict?.kind).toBe('very_good');
    const table: Panel = { ...chart, type: 'table' };
    expect(evaluatePanel(table, job(), runs, NOW).verdict).toBeUndefined();
  });

  it('the arrow follows the value’s movement against the comparison run (ruling R12)', () => {
    const panel = tile('installs', {
      limits: [{ value: 'installs', better: 'higher', veryGood: { op: 'above', value: 100 } }],
    });
    // Still above 100, but it fell against a week ago: the arrow says so.
    const fell = newestFirst(
      run(daysAgo(7), { installs: 180 }),
      run(daysAgo(0), { installs: 150 }),
    );
    expect(evaluatePanel(panel, job(), fell, NOW).verdict).toMatchObject({
      kind: 'very_good',
      arrow: 'down',
    });
    // No change against the comparison run: the limit's direction.
    const flat = newestFirst(
      run(daysAgo(7), { installs: 150 }),
      run(daysAgo(0), { installs: 150 }),
    );
    expect(evaluatePanel(panel, job(), flat, NOW).verdict?.arrow).toBe('up');
  });

  it('without a previous value the arrow is the limit’s direction', () => {
    const panel = tile('churn', {
      limits: [{ value: 'churn', better: 'lower', veryBad: { op: 'above', value: 6 } }],
    });
    // A run only two days older is no week comparison: no previous value.
    const runs = newestFirst(run(daysAgo(2), { churn: 9 }), run(daysAgo(0), { churn: 7 }));
    expect(evaluatePanel(panel, job(), runs, NOW).verdict).toMatchObject({
      kind: 'very_bad',
      arrow: 'up',
    });
  });

  it('a series’ arrow compares its latest point with the previous one', () => {
    const limits = [
      { value: 'errors', better: 'lower' as const, veryBad: { op: 'above' as const, value: 10 } },
    ];
    const chart: Panel = { ...tile('errors', { limits }), type: 'line', display: {} };
    const rose = newestFirst(run(daysAgo(1), { errors: 4 }), run(daysAgo(0), { errors: 12 }));
    expect(evaluatePanel(chart, job(), rose, NOW).verdict).toMatchObject({
      kind: 'very_bad',
      arrow: 'up',
    });
    const easing = newestFirst(run(daysAgo(1), { errors: 20 }), run(daysAgo(0), { errors: 12 }));
    expect(evaluatePanel(chart, job(), easing, NOW).verdict?.arrow).toBe('down');
  });

  it('a rise without a comparison run judges nothing', () => {
    const panel = tile('churn', {
      limits: [
        { value: 'churn', better: 'lower', veryBad: { op: 'rise', percent: 5, vs: 'week' } },
      ],
    });
    expect(
      evaluatePanel(panel, job(), [run(daysAgo(0), { churn: 9 })], NOW).verdict,
    ).toBeUndefined();
  });
});

describe('evaluatePanel — snapshots', () => {
  const table = (rows: (string | number)[][]) => ({
    tables: { plans: { columns: ['plan', 'users'], rows } },
  });

  it('a table takes only the newest good run’s rows', () => {
    const panel: Panel = { ...tile('plans'), type: 'table', display: {} };
    const runs = newestFirst(
      run(daysAgo(2), undefined, { data: table([['free', 10]]) }),
      run(daysAgo(1), undefined, {
        data: table([
          ['pro', 3],
          ['team', 1],
        ]),
      }),
    );
    const data = evaluatePanel(panel, job(), runs, NOW);
    expect(data.status).toBe('ok');
    expect(data.table).toEqual({
      columns: ['plan', 'users'],
      rows: [
        ['pro', 3],
        ['team', 1],
      ],
    });
  });

  it('a table shows only the display columns when given', () => {
    const panel: Panel = { ...tile('plans'), type: 'table', display: { columns: ['users'] } };
    const data = evaluatePanel(
      panel,
      job(),
      [run(daysAgo(1), undefined, { data: table([['pro', 3]]) })],
      NOW,
    );
    expect(data.table).toEqual({ columns: ['users'], rows: [[3]] });
  });

  it('lists, calendars, texts and a job’s status board come from the newest good run', () => {
    const data = {
      lists: { feedback: [{ title: 'Slow login' }] },
      calendars: { posts: [{ date: '2026-10-21', title: 'Launch post' }] },
      texts: { note: 'All calm.' },
      statuses: {
        work: [
          { column: 'Doing', title: 'A' },
          { column: 'Done', title: 'B' },
          { column: 'Doing', title: 'C', detail: 'c' },
        ],
      },
    };
    const runs = [run(daysAgo(1), undefined, { data })];
    const of = (type: Panel['type'], value: string) =>
      evaluatePanel({ ...tile(value), type, display: {} }, job(), runs, NOW);
    expect(of('list', 'feedback').list).toEqual([{ title: 'Slow login' }]);
    expect(of('calendar', 'posts').calendar).toEqual([
      { date: '2026-10-21', title: 'Launch post' },
    ]);
    expect(of('text', 'note').text).toBe('All calm.');
    expect(of('status', 'work').statusBoard).toEqual({
      columns: [
        {
          name: 'Doing',
          items: [{ title: 'A' }, { title: 'C', detail: 'c' }],
        },
        { name: 'Done', items: [{ title: 'B' }] },
      ],
    });
  });

  it('names the job in the source line', () => {
    const data = evaluatePanel(tile('churn'), job({ name: 'Count churn' }), [], NOW);
    expect(data.sourceLine).toBe('from job “Count churn”');
    expect(data.panelId).toBe(d.panel.id);
  });
});

describe('evaluatePanel — the project’s tasks as a status board', () => {
  const task = (id: string, state: Task['state'], updatedAt: string, extra: Partial<Task> = {}) =>
    ({
      ...d.task,
      id,
      description: `Task ${id}`,
      state,
      createdAt: updatedAt,
      updatedAt,
      ...extra,
    }) satisfies Task;

  it('shows In progress, Next (five oldest approved) and Done this week; job tasks are left out', () => {
    const panel: Panel = {
      ...d.panel,
      type: 'status',
      title: 'Work',
      source: { kind: 'tasks' },
      display: {},
      limits: [],
    };
    const tasks: Task[] = [
      task('a', 'in_progress', daysAgo(1)),
      task('b', 'blocked_on_user', daysAgo(2)),
      task('c', 'awaiting_closure', daysAgo(3)),
      ...[1, 2, 3, 4, 5, 6].map((n) => task(`n${n}`, 'approved', daysAgo(20 - n))),
      task('d1', 'completed', daysAgo(2)),
      task('d2', 'completed', daysAgo(9)),
      task('job', 'in_progress', daysAgo(0), { meta: { jobId: 'j-1' } }),
      task('other', 'in_progress', daysAgo(0), { projectId: 'p-other' }),
      task('x', 'archived', daysAgo(0)),
    ];
    const data = evaluatePanel(panel, undefined, [], NOW, tasks);
    expect(data.status).toBe('ok');
    expect(data.sourceLine).toBe('from the project’s tasks');
    const titles = data.statusBoard!.columns.map((c) => [c.name, c.items.map((i) => i.title)]);
    expect(titles).toEqual([
      ['In progress', ['Task a', 'Task b', 'Task c']],
      ['Next', ['Task n1', 'Task n2', 'Task n3', 'Task n4', 'Task n5']],
      ['Done this week', ['Task d1']],
    ]);
  });
});

describe('DashboardResponse', () => {
  it('parses a list of panel data', () => {
    const data = evaluatePanel(tile('churn'), job(), [run(daysAgo(0), { churn: 1 })], NOW);
    expect(DashboardResponse.parse({ panels: [data] }).panels).toHaveLength(1);
  });
});

describe('unchangedSince (P15-05, ruling R5)', () => {
  it('is the start of the oldest run in the newest streak of equal values', () => {
    const runs = newestFirst(
      run(daysAgo(40), { churn: 3 }),
      run(daysAgo(30), { churn: 4 }),
      run(daysAgo(20), { churn: 4 }),
      run(daysAgo(1), { churn: 4 }),
    );
    expect(unchangedSince(tile('churn'), runs)).toBe(daysAgo(30));
  });

  it('a changed newest value starts a new streak', () => {
    const runs = newestFirst(run(daysAgo(30), { churn: 4 }), run(daysAgo(1), { churn: 5 }));
    expect(unchangedSince(tile('churn'), runs)).toBe(daysAgo(1));
  });

  it('skips bad runs and runs before historyFrom, and ignores panel.updatedAt', () => {
    const runs = newestFirst(
      run(daysAgo(50), { churn: 4 }),
      run(daysAgo(30), { churn: 4 }),
      run(daysAgo(10), undefined, { outcome: 'failed' }),
      run(daysAgo(2), { churn: 4 }),
    );
    const panel = tile('churn', { historyFrom: daysAgo(40), updatedAt: daysAgo(0) });
    expect(unchangedSince(panel, runs)).toBe(daysAgo(30));
  });

  it('compares the JSON of a snapshot dataset', () => {
    const table = (rows: number[][]) => ({
      tables: { t: { columns: ['a'], rows } },
    });
    const panel: Panel = {
      ...d.panel,
      type: 'table',
      source: { kind: 'job', jobId: 'j-1', values: ['t'] },
      display: {},
      limits: [],
    };
    const same = newestFirst(
      run(daysAgo(9), undefined, { data: table([[1]]) }),
      run(daysAgo(1), undefined, { data: table([[1]]) }),
    );
    expect(unchangedSince(panel, same)).toBe(daysAgo(9));
    const changed = newestFirst(
      run(daysAgo(9), undefined, { data: table([[1]]) }),
      run(daysAgo(1), undefined, { data: table([[2]]) }),
    );
    expect(unchangedSince(panel, changed)).toBe(daysAgo(1));
  });

  it('is undefined without a good run, and for a tasks source', () => {
    expect(unchangedSince(tile('churn'), [])).toBeUndefined();
    expect(
      unchangedSince(tile('churn'), [run(daysAgo(1), undefined, { outcome: 'failed' })]),
    ).toBeUndefined();
    const tasks: Panel = { ...d.panel, type: 'status', source: { kind: 'tasks' }, display: {} };
    expect(unchangedSince(tasks, [run(daysAgo(1), { churn: 1 })])).toBeUndefined();
  });
});
