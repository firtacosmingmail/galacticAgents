import { z } from 'zod';
import { Actor } from './actor.js';
import { Id, Meta, Timestamp } from './primitives.js';

/**
 * The project dashboard (Phase 15; SPEC decision 156): one dashboard per long-term project, owned
 * by its Waykeeper. A **panel** shows values a job's runs reported (or the project's own tasks);
 * a job's **data map** declares where those values come from; a run's **data** carries the
 * snapshot kinds (tables, lists, calendars, status boards, text) next to its numbers.
 */

export const MAX_PANELS_PER_DASHBOARD = 24;
/** A panel unchanged this long gets a removal suggestion from its Waykeeper (never auto-removed). */
export const PANEL_UNCHANGED_DAYS = 28;
/** On the phone the first this-many cards are open; the rest are folded to a title line. */
export const PHONE_OPEN_CARDS = 3;

export const DASHBOARD_LIMITS = {
  /** Data map. */
  maxSources: 20,
  maxCollects: 60,
  maxSteps: 30,
  maxSourceLabel: 80,
  maxSourceTarget: 200,
  maxCollectName: 60,
  maxCollectDescription: 300,
  maxStepText: 500,
  /** Run data. */
  maxTables: 10,
  maxTableColumns: 12,
  maxTableRows: 200,
  maxCell: 300,
  maxLists: 10,
  maxListItems: 100,
  maxListTitle: 200,
  maxListDetail: 1000,
  maxListTag: 40,
  maxCalendars: 5,
  maxCalendarEntries: 200,
  maxCalendarTitle: 200,
  maxCalendarDetail: 1000,
  maxStatusBoards: 5,
  maxStatusItems: 200,
  maxStatusColumn: 40,
  maxStatusTitle: 200,
  maxStatusDetail: 300,
  maxTexts: 5,
  maxTextChars: 4000,
  maxSourceProblems: 20,
  maxProblem: 300,
  maxRunDataBytes: 262_144,
  /** Panels. */
  maxPanelTitle: 80,
  maxPanelValues: 8,
  maxPanelLimits: 8,
} as const;

const L = DASHBOARD_LIMITS;

/** The name of a table, list, calendar, status board, text or source. Not used for numbers. */
export const DataName = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/);
export type DataName = z.infer<typeof DataName>;

// ---------------------------------------------------------------------------
// The job's data map
// ---------------------------------------------------------------------------

export const JobSourceKind = z.enum(['mcp', 'site', 'files', 'database', 'command', 'other']);
export type JobSourceKind = z.infer<typeof JobSourceKind>;

export const JobSource = z.object({
  id: DataName,
  label: z.string().max(L.maxSourceLabel),
  kind: JobSourceKind,
  target: z.string().max(L.maxSourceTarget),
});
export type JobSource = z.infer<typeof JobSource>;

export const JobCollectKind = z.enum(['number', 'table', 'list', 'calendar', 'status', 'text']);
export type JobCollectKind = z.infer<typeof JobCollectKind>;

export const JobCollect = z.object({
  name: z.string().min(1).max(L.maxCollectName),
  kind: JobCollectKind,
  sourceIds: z.array(DataName).min(1),
  description: z.string().max(L.maxCollectDescription),
});
export type JobCollect = z.infer<typeof JobCollect>;

export const JobStep = z.object({
  text: z.string().max(L.maxStepText),
  uses: z.array(z.string()),
  produces: z.array(z.string()),
});
export type JobStep = z.infer<typeof JobStep>;

/**
 * Where a job's data comes from and what it does with it. Every collect's `sourceIds` names a
 * source; a step `uses` a source or a collected value and `produces` collected values.
 */
export const JobDataMap = z
  .object({
    sources: z.array(JobSource).max(L.maxSources),
    collects: z.array(JobCollect).max(L.maxCollects),
    steps: z.array(JobStep).max(L.maxSteps),
  })
  .superRefine((map, ctx) => {
    const sources = new Set(map.sources.map((s) => s.id));
    const collects = new Set(map.collects.map((c) => c.name));
    map.collects.forEach((c, i) => {
      for (const id of c.sourceIds) {
        if (!sources.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['collects', i, 'sourceIds'],
            message: `unknown source "${id}"`,
          });
        }
      }
    });
    map.steps.forEach((s, i) => {
      for (const name of s.uses) {
        if (!sources.has(name) && !collects.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'uses'],
            message: `unknown source or value "${name}"`,
          });
        }
      }
      for (const name of s.produces) {
        if (!collects.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['steps', i, 'produces'],
            message: `unknown value "${name}"`,
          });
        }
      }
    });
  });
export type JobDataMap = z.infer<typeof JobDataMap>;

// ---------------------------------------------------------------------------
// What a run reports
// ---------------------------------------------------------------------------

export const ListItem = z.object({
  title: z.string().max(L.maxListTitle),
  detail: z.string().max(L.maxListDetail).optional(),
  tag: z.string().max(L.maxListTag).optional(),
  at: Timestamp.optional(),
});
export type ListItem = z.infer<typeof ListItem>;

export const CalendarEntry = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().max(L.maxCalendarTitle),
  detail: z.string().max(L.maxCalendarDetail).optional(),
});
export type CalendarEntry = z.infer<typeof CalendarEntry>;

export const StatusItem = z.object({
  column: z.string().max(L.maxStatusColumn),
  title: z.string().max(L.maxStatusTitle),
  detail: z.string().max(L.maxStatusDetail).optional(),
});
export type StatusItem = z.infer<typeof StatusItem>;

export const RunTable = z
  .object({
    columns: z.array(z.string().max(L.maxCell)).max(L.maxTableColumns),
    rows: z
      .array(z.array(z.union([z.string().max(L.maxCell), z.number(), z.null()])))
      .max(L.maxTableRows),
  })
  .refine((t) => t.rows.every((row) => row.length === t.columns.length), {
    message: 'every row needs exactly one cell per column',
    path: ['rows'],
  });
export type RunTable = z.infer<typeof RunTable>;

const named = <T extends z.ZodType>(value: T, max: number) =>
  z
    .record(DataName, value)
    .refine((r) => Object.keys(r).length <= max, { message: `at most ${max} entries` });

const byteLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** The snapshot data a run reports next to its numbers. */
export const RunData = z
  .object({
    tables: named(RunTable, L.maxTables).optional(),
    lists: named(z.array(ListItem).max(L.maxListItems), L.maxLists).optional(),
    calendars: named(z.array(CalendarEntry).max(L.maxCalendarEntries), L.maxCalendars).optional(),
    statuses: named(z.array(StatusItem).max(L.maxStatusItems), L.maxStatusBoards).optional(),
    texts: named(z.string().max(L.maxTextChars), L.maxTexts).optional(),
    sourceProblems: z
      .array(z.object({ sourceId: z.string(), problem: z.string().max(L.maxProblem) }))
      .max(L.maxSourceProblems)
      .optional(),
  })
  .refine((d) => byteLength(d) <= L.maxRunDataBytes, {
    message: `data is larger than ${L.maxRunDataBytes} bytes`,
  });
export type RunData = z.infer<typeof RunData>;

/** What a run actually read from, recorded by Mission Control (not reported by the run). */
export const UsedSource = z.object({ kind: JobSourceKind, target: z.string() });
export type UsedSource = z.infer<typeof UsedSource>;

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export const PanelType = z.enum([
  'tile',
  'line',
  'bar',
  'table',
  'list',
  'calendar',
  'status',
  'text',
]);
export type PanelType = z.infer<typeof PanelType>;

export const PanelSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('job'),
    jobId: Id,
    values: z.array(z.string()).min(1).max(L.maxPanelValues),
  }),
  z.object({ kind: z.literal('tasks') }),
]);
export type PanelSource = z.infer<typeof PanelSource>;

export const PanelDisplay = z.object({
  compare: z.enum(['week', 'month']).optional(),
  format: z.enum(['number', 'percent', 'money']).optional(),
  unit: z.string().max(8).optional(),
  currency: z.string().length(3).optional(),
  rangeDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365)]).optional(),
  columns: z.array(z.string()).optional(),
});
export type PanelDisplay = z.infer<typeof PanelDisplay>;

export const Threshold = z.discriminatedUnion('op', [
  z.object({ op: z.literal('above'), value: z.number() }),
  z.object({ op: z.literal('below'), value: z.number() }),
  z.object({
    op: z.literal('rise'),
    percent: z.number().positive(),
    vs: z.enum(['week', 'month']),
  }),
  z.object({
    op: z.literal('fall'),
    percent: z.number().positive(),
    vs: z.enum(['week', 'month']),
  }),
]);
export type Threshold = z.infer<typeof Threshold>;

export const PanelLimit = z.object({
  value: z.string(),
  better: z.enum(['higher', 'lower']),
  veryBad: Threshold.optional(),
  veryGood: Threshold.optional(),
});
export type PanelLimit = z.infer<typeof PanelLimit>;

export const PanelLayout = z.object({
  order: z.number().int().min(0),
  w: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  h: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  hidden: z.literal(true).optional(),
});
export type PanelLayout = z.infer<typeof PanelLayout>;

const PanelBase = z.object({
  id: Id,
  projectId: Id,
  type: PanelType,
  title: z.string().min(1).max(L.maxPanelTitle),
  source: PanelSource,
  display: PanelDisplay,
  limits: z.array(PanelLimit).max(L.maxPanelLimits),
  layout: PanelLayout,
  /** The panel ignores runs before this time (set by "clear history"). */
  historyFrom: Timestamp.optional(),
  removalSuggestedAt: Timestamp.optional(),
  createdBy: Actor,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});

/** Only a `status` panel may read the project's own tasks; every other type needs a job. */
const needsJobSource = (p: { type: PanelType; source: PanelSource }): boolean =>
  p.source.kind === 'job' || p.type === 'status';
const needsJobSourceMessage = {
  message: 'only a status panel may use the project’s tasks as its source',
  path: ['source'],
};

export const Panel = PanelBase.refine(needsJobSource, needsJobSourceMessage);
export type Panel = z.infer<typeof Panel>;

/** What a panel card proposes and `addPanel` takes. */
export const PanelDraft = PanelBase.pick({
  type: true,
  title: true,
  source: true,
  display: true,
  limits: true,
}).refine(needsJobSource, needsJobSourceMessage);
export type PanelDraft = z.infer<typeof PanelDraft>;

/** What `panel.updated` may change. A `null` `removalSuggestedAt` clears the suggestion. */
export const PanelChanges = PanelBase.pick({
  title: true,
  source: true,
  display: true,
  limits: true,
  layout: true,
  historyFrom: true,
})
  .extend({ removalSuggestedAt: Timestamp.nullable() })
  .partial();
export type PanelChanges = z.infer<typeof PanelChanges>;

/** The same dataset a job reports, keyed as `collects` names (numbers) and data names. */
const readsOf = (panel: Panel): string[] =>
  panel.source.kind === 'job' ? panel.source.values : [];

/**
 * The panels a job's data change touches. Without `after`: every panel sourced from the job (its
 * values are being cleared or its job removed). With `after`: those reading a value the new data
 * map no longer collects.
 */
export function affectedPanels(panels: Panel[], jobId: Id, after?: JobDataMap): Panel[] {
  const ofJob = panels.filter((p) => p.source.kind === 'job' && p.source.jobId === jobId);
  if (!after) return ofJob;
  const names = new Set(after.collects.map((c) => c.name));
  return ofJob.filter((p) => readsOf(p).some((v) => !names.has(v)));
}
