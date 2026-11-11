import { z } from 'zod';
import {
  CalendarEntry,
  ListItem,
  PanelLayout,
  type Panel,
  type PanelLimit,
  type PanelType,
  type RunData,
  type Threshold,
} from './dashboard.js';
import type { Task } from './domain.js';
import { isJobTask, type Job, type JobRun } from './long-term.js';
import { Id, Timestamp } from './primitives.js';

/**
 * What a dashboard panel shows now (P15-04; SPEC decision 156), computed from its definition, its
 * job and that job's runs (or the project's tasks). Pure, so the server and the web agree: the
 * server answers `GET /api/projects/:id/dashboard` with it, the web may recompute it.
 *
 * - A panel reads only **good** runs (`quiet` / `findings`) started at or after its `historyFrom`.
 * - Its **status**, first match: `job_stopped`, `job_paused`, `stale` (the job's last run failed or
 *   hit its usage limit), `empty` (nothing to show), `not_reported` (the newest good run lacks a
 *   value an older good run had: the older value is shown), else `ok`.
 * - Numbers keep history (tiles, charts); tables, lists, calendars, status boards and text show the
 *   newest good run that has them.
 * - A **verdict** (very bad / very good) only on an `ok` tile or chart, from its limits on the
 *   newest values; very bad wins. Its `resultId` is the run's id, so fireworks play once per run.
 */

export const PanelStatus = z.enum([
  'ok',
  'empty',
  'stale',
  'job_paused',
  'job_stopped',
  'not_reported',
]);
export type PanelStatus = z.infer<typeof PanelStatus>;

const Cell = z.union([z.string(), z.number(), z.null()]);

export const PanelData = z.object({
  panelId: Id,
  status: PanelStatus,
  /** When the newest good run the panel shows ended. */
  lastGoodAt: Timestamp.optional(),
  /** "from job “Count churn”", "from the project’s tasks". */
  sourceLine: z.string(),
  tile: z
    .object({
      value: z.number(),
      previous: z.number().optional(),
      changePct: z.number().optional(),
      changeAbs: z.number().optional(),
    })
    .optional(),
  series: z
    .array(
      z.object({
        name: z.string(),
        points: z.array(z.object({ at: Timestamp, value: z.number() })),
      }),
    )
    .optional(),
  table: z.object({ columns: z.array(z.string()), rows: z.array(z.array(Cell)) }).optional(),
  list: z.array(ListItem).optional(),
  calendar: z.array(CalendarEntry).optional(),
  statusBoard: z
    .object({
      columns: z.array(
        z.object({
          name: z.string(),
          items: z.array(z.object({ title: z.string(), detail: z.string().optional() })),
        }),
      ),
    })
    .optional(),
  text: z.string().optional(),
  verdict: z
    .object({
      kind: z.enum(['very_bad', 'very_good']),
      /** The value whose limit it is. */
      value: z.string(),
      arrow: z.enum(['up', 'down']),
      /** The run the verdict is about. */
      resultId: Id,
    })
    .optional(),
});
export type PanelData = z.infer<typeof PanelData>;

/** `GET /api/projects/:id/dashboard`: every panel's data, in dashboard order. */
export const DashboardResponse = z.object({ panels: z.array(PanelData) });
export type DashboardResponse = z.infer<typeof DashboardResponse>;

/** `POST /api/jobs/:id/refresh`: the run started, or the one already going (`started: false`). */
export const RefreshJobResponse = z.object({ runId: Id, started: z.boolean() });
export type RefreshJobResponse = z.infer<typeof RefreshJobResponse>;

/** `POST /api/jobs/:id/clear-values`: the panels that read the job. */
export const ClearJobValuesResponse = z.object({ panels: z.array(Id) });
export type ClearJobValuesResponse = z.infer<typeof ClearJobValuesResponse>;

/** `PUT /api/projects/:id/dashboard/layout`: every panel of the dashboard, each once. */
export const ArrangePanelsRequest = z.object({
  layouts: z.array(z.object({ panelId: Id, layout: PanelLayout })),
});
export type ArrangePanelsRequest = z.infer<typeof ArrangePanelsRequest>;

const DAY_MS = 86_400_000;
const COMPARE_DAYS = { week: 7, month: 30 } as const;
const NEXT_TASKS = 5;
const DONE_WINDOW_DAYS = 7;
const TASK_TITLE_MAX = 200;

const NUMBER_PANELS: ReadonlySet<PanelType> = new Set(['tile', 'line', 'bar']);

const isGood = (run: JobRun): boolean => run.outcome === 'quiet' || run.outcome === 'findings';

/** The value `name` in a run, by the panel's kind of data; `undefined` when the run lacks it. */
function valueIn(type: PanelType, run: JobRun, name: string): unknown {
  if (NUMBER_PANELS.has(type)) return run.numbers?.[name];
  const data: RunData | undefined = run.data;
  switch (type) {
    case 'table':
      return data?.tables?.[name];
    case 'list':
      return data?.lists?.[name];
    case 'calendar':
      return data?.calendars?.[name];
    case 'status':
      return data?.statuses?.[name];
    case 'text':
      return data?.texts?.[name];
    default:
      return undefined;
  }
}

/** The newest good run at least `days` older than `run` that has `name`. */
function olderRun(
  runs: JobRun[],
  run: JobRun,
  name: string,
  days: number,
): { run: JobRun; value: number } | undefined {
  const before = Date.parse(run.startedAt) - days * DAY_MS;
  for (const r of runs) {
    const value = r.numbers?.[name];
    if (value !== undefined && Date.parse(r.startedAt) <= before) return { run: r, value };
  }
  return undefined;
}

function change(value: number, previous: number): { changeAbs: number; changePct?: number } {
  const changeAbs = value - previous;
  return previous === 0
    ? { changeAbs }
    : { changeAbs, changePct: (changeAbs / Math.abs(previous)) * 100 };
}

/** Whether `value` (of `name`, in `run`) crosses the threshold; a rise or fall needs an older run. */
function crosses(t: Threshold, runs: JobRun[], run: JobRun, name: string, value: number): boolean {
  switch (t.op) {
    case 'above':
      return value > t.value;
    case 'below':
      return value < t.value;
    case 'rise':
    case 'fall': {
      const older = olderRun(runs, run, name, COMPARE_DAYS[t.vs]);
      const pct = older ? change(value, older.value).changePct : undefined;
      if (pct === undefined) return false;
      return t.op === 'rise' ? pct >= t.percent : pct <= -t.percent;
    }
  }
}

const arrowOf = (t: Threshold): 'up' | 'down' =>
  t.op === 'above' || t.op === 'rise' ? 'up' : 'down';

/**
 * The verdict's arrow (ruling R12): the value's movement against the panel's comparison value
 * (a tile's `compare` run, a series' previous point) — "churn ▼ 0.6 pt"; without one, or with no
 * change, the limit's own direction.
 */
function arrowFor(t: Threshold, value: number, previous: number | undefined): 'up' | 'down' {
  if (previous === undefined || value === previous) return arrowOf(t);
  return value > previous ? 'up' : 'down';
}

function verdictOf(
  limits: PanelLimit[],
  names: string[],
  runs: JobRun[],
  newest: JobRun,
  previousOf: (name: string) => number | undefined,
): PanelData['verdict'] {
  for (const kind of ['very_bad', 'very_good'] as const) {
    for (const limit of limits) {
      if (!names.includes(limit.value)) continue;
      const threshold = kind === 'very_bad' ? limit.veryBad : limit.veryGood;
      const value = newest.numbers?.[limit.value];
      if (!threshold || value === undefined) continue;
      if (crosses(threshold, runs, newest, limit.value, value)) {
        const arrow = arrowFor(threshold, value, previousOf(limit.value));
        return { kind, value: limit.value, arrow, resultId: newest.id };
      }
    }
  }
  return undefined;
}

function tileOf(
  panel: Panel,
  runs: JobRun[],
  name: string,
): { tile: NonNullable<PanelData['tile']>; run: JobRun } | undefined {
  const run = runs.find((r) => r.numbers?.[name] !== undefined);
  if (!run) return undefined;
  const value = run.numbers![name]!;
  const compare = panel.display.compare;
  const older = compare ? olderRun(runs, run, name, COMPARE_DAYS[compare]) : undefined;
  return {
    run,
    tile: older ? { value, previous: older.value, ...change(value, older.value) } : { value },
  };
}

function seriesOf(panel: Panel, runs: JobRun[], names: string[], now: string) {
  const from = panel.display.rangeDays
    ? Date.parse(now) - panel.display.rangeDays * DAY_MS
    : -Infinity;
  const inRange = runs.filter((r) => Date.parse(r.startedAt) >= from).reverse();
  return names.map((name) => ({
    name,
    points: inRange.flatMap((r) => {
      const value = r.numbers?.[name];
      return value === undefined ? [] : [{ at: r.startedAt, value }];
    }),
  }));
}

/** A status board's items grouped by column, columns in the order they first appear. */
function boardOf(items: { column: string; title: string; detail?: string }[]) {
  const columns: { name: string; items: { title: string; detail?: string }[] }[] = [];
  for (const { column, title, detail } of items) {
    let col = columns.find((c) => c.name === column);
    if (!col) columns.push((col = { name: column, items: [] }));
    col.items.push(detail !== undefined ? { title, detail } : { title });
  }
  return { columns };
}

/** The snapshot fields of a table, list, calendar, status or text panel from `value`. */
function snapshotOf(panel: Panel, value: unknown): Partial<PanelData> {
  switch (panel.type) {
    case 'table': {
      const t = value as { columns: string[]; rows: (string | number | null)[][] };
      const wanted = panel.display.columns?.filter((c) => t.columns.includes(c));
      if (!wanted || wanted.length === 0) return { table: { columns: t.columns, rows: t.rows } };
      const at = wanted.map((c) => t.columns.indexOf(c));
      return { table: { columns: wanted, rows: t.rows.map((row) => at.map((i) => row[i]!)) } };
    }
    case 'list':
      return { list: value as PanelData['list'] };
    case 'calendar':
      return { calendar: value as PanelData['calendar'] };
    case 'status':
      return { statusBoard: boardOf(value as Parameters<typeof boardOf>[0]) };
    case 'text':
      return { text: value as string };
    default:
      return {};
  }
}

const taskTitle = (t: Task): string => {
  const line = t.description.split('\n')[0]!.trim();
  return line.length > TASK_TITLE_MAX ? line.slice(0, TASK_TITLE_MAX) : line;
};

/**
 * The project’s own tasks as a status board (ruling R4): In progress (working, waiting on the
 * user, awaiting closure; latest first), Next (the five oldest approved), Done this week
 * (completed in the last seven days, newest first). A job’s hidden task is never shown.
 */
function taskBoard(panel: Panel, tasks: Task[], now: string): PanelData {
  const own = tasks.filter((t) => t.projectId === panel.projectId && !isJobTask(t));
  const byCreated = (a: Task, b: Task) => a.createdAt.localeCompare(b.createdAt);
  const byUpdatedDesc = (a: Task, b: Task) => b.updatedAt.localeCompare(a.updatedAt);
  const item = (t: Task) => ({ title: taskTitle(t) });
  const doneFrom = Date.parse(now) - DONE_WINDOW_DAYS * DAY_MS;
  const inProgress = own
    .filter((t) => ['in_progress', 'blocked_on_user', 'awaiting_closure'].includes(t.state))
    .sort(byUpdatedDesc);
  const next = own
    .filter((t) => t.state === 'approved')
    .sort(byCreated)
    .slice(0, NEXT_TASKS);
  const done = own
    .filter((t) => t.state === 'completed' && Date.parse(t.updatedAt) >= doneFrom)
    .sort(byUpdatedDesc);
  return {
    panelId: panel.id,
    status: 'ok',
    sourceLine: 'from the project’s tasks',
    statusBoard: {
      columns: [
        { name: 'In progress', items: inProgress.map(item) },
        { name: 'Next', items: next.map(item) },
        { name: 'Done this week', items: done.map(item) },
      ],
    },
  };
}

/**
 * What `panel` shows now. `runs` are the job's runs, newest first; `tasks` the project's (read only
 * by a status board sourced from the tasks).
 */
export function evaluatePanel(
  panel: Panel,
  job: Job | undefined,
  runs: JobRun[],
  now: string,
  tasks: Task[] = [],
): PanelData {
  if (panel.source.kind === 'tasks') return taskBoard(panel, tasks, now);
  const names = panel.source.values;
  const sourceLine = job ? `from job “${job.name}”` : 'from a job that no longer exists';
  const from = panel.historyFrom ?? '';
  const good = runs.filter((r) => isGood(r) && r.startedAt >= from);

  const shown: Partial<PanelData> = {};
  let shownRun: JobRun | undefined;
  if (panel.type === 'tile') {
    const t = tileOf(panel, good, names[0]!);
    if (t) {
      shown.tile = t.tile;
      shownRun = t.run;
    }
  } else if (NUMBER_PANELS.has(panel.type)) {
    const series = seriesOf(panel, good, names, now);
    if (series.some((s) => s.points.length > 0)) {
      shown.series = series;
      shownRun = good.find((r) => names.some((n) => r.numbers?.[n] !== undefined));
    }
  } else {
    const run = good.find((r) => valueIn(panel.type, r, names[0]!) !== undefined);
    if (run) {
      Object.assign(shown, snapshotOf(panel, valueIn(panel.type, run, names[0]!)));
      shownRun = run;
    }
  }

  const newest = good[0];
  const dropped =
    newest !== undefined &&
    names.some(
      (n) =>
        valueIn(panel.type, newest, n) === undefined &&
        good.some((r) => valueIn(panel.type, r, n) !== undefined),
    );
  const lastOutcome = job?.lastRun?.outcome;
  const status: PanelStatus =
    !job || job.state === 'stopped'
      ? 'job_stopped'
      : job.state === 'paused'
        ? 'job_paused'
        : lastOutcome === 'failed' || lastOutcome === 'limited'
          ? 'stale'
          : !shownRun
            ? 'empty'
            : dropped
              ? 'not_reported'
              : 'ok';

  const lastGoodAt = shownRun ? (shownRun.endedAt ?? shownRun.startedAt) : undefined;
  const verdict =
    status === 'ok' && NUMBER_PANELS.has(panel.type) && newest
      ? verdictOf(
          panel.limits,
          panel.type === 'tile' ? names.slice(0, 1) : names,
          good,
          newest,
          (name) => {
            if (panel.type === 'tile') return shown.tile?.previous;
            const points = shown.series?.find((s) => s.name === name)?.points ?? [];
            return points.length >= 2 ? points[points.length - 2]!.value : undefined;
          },
        )
      : undefined;
  return {
    panelId: panel.id,
    status,
    ...(lastGoodAt ? { lastGoodAt } : {}),
    sourceLine,
    ...shown,
    ...(verdict ? { verdict } : {}),
  };
}
