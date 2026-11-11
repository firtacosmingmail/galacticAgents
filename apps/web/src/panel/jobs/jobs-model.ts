import { create } from 'zustand';
import {
  PROVIDER_LABEL,
  Provider,
  isJobOwned,
  scheduleText,
  type Area,
  type Id,
  type Job,
  type JobRunBrief,
  type Question,
  type WorldState,
} from '@galactic/protocol';

/**
 * The Jobs tab's model (P10-07; SPEC decision 144; the approved mockup's option B with option A's
 * per-job detail): a long-term project's jobs, what needs Cosmin first (paused jobs and jobs with
 * questions waiting in the inbox), then one section per area with its moon, each job's schedule,
 * its last result as one line, its provider and its next run. Computed from the client world only;
 * the run history is read from the REST route when a job is expanded.
 */

export interface JobRow {
  job: Job;
  area: Area;
  moonName: string;
  scheduleText: string;
  /** When it runs next ("tomorrow 9:00"); only an active job has one. */
  nextRunText?: string;
  /** Its last run as one line ("✓ today 9:02 — 14 new messages"). */
  lastLine?: string;
  tone: 'ok' | 'catchup' | 'bad' | 'idle';
  /** Open job-owned questions (findings, its failure question, spends). */
  waiting: number;
  /** Their ids, oldest first (the inbox reveal opens the first). */
  waitingIds: Id[];
  /** A paused job's line: "paused since Tue — CRM login expired (asked in the inbox)". */
  pausedText?: string;
}

export interface JobsAreaSection {
  area: Area;
  moonName: string;
  /** More than one area of the project sits on this moon. */
  shared: boolean;
  /** The other areas on the moon, by name. */
  sharedWith: string[];
  rows: JobRow[];
}

export interface JobsModel {
  needsYou: JobRow[];
  areas: JobsAreaSection[];
  /** The moon the list is filtered to, when the filter names a moon of this project's areas. */
  moon?: { bodyId: Id; name: string };
}

// --- times -------------------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DAY_MS = 86_400_000;

const startOfDay = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "today", "yesterday", "tomorrow", a weekday within the week either side, else "Nov 1" (local time). */
export function dayWord(at: Date, now: Date): string {
  const diff = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'today';
  if (diff === -1) return 'yesterday';
  if (diff === 1) return 'tomorrow';
  if (Math.abs(diff) < 7) return DAY_NAMES[at.getDay()]!;
  return `${MONTH_NAMES[at.getMonth()]} ${at.getDate()}`;
}

/** "9:02" (local time, the way `scheduleText` writes times). */
export function clockText(at: Date): string {
  return `${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** "tomorrow 9:00". */
export function whenText(iso: string, now: Date): string {
  const at = new Date(iso);
  return `${dayWord(at, now)} ${clockText(at)}`;
}

// --- one run as a line -------------------------------------------------------------------------

type RunLike = Pick<JobRunBrief, 'outcome' | 'purpose' | 'startedAt' | 'summary'>;

/**
 * A run as one line, per the mockup: `✓ today 9:02 — <summary>`, `↻ Mon 11:40 (caught up after
 * sleep) — <summary>`, `✕ Sun 9:00 — <reason>`; `reason` (a paused job's) wins over the summary.
 */
export function runLine(run: RunLike, now: Date, reason?: string): string {
  const when = whenText(run.startedAt, now);
  const tail = (text: string | undefined) => (text ? ` — ${text}` : '');
  switch (run.outcome) {
    case 'running':
      return `▶ running since ${when}`;
    case 'failed':
      return `✕ ${when} — ${reason ?? run.summary ?? 'failed'}`;
    case 'interrupted':
      // A refresh (P15-04) is never run again: the schedule stands.
      return run.purpose === 'refresh'
        ? `↻ ${when} — refresh cut short`
        : `↻ ${when} — cut short; it runs again`;
    default: {
      const mark = run.purpose === 'catch_up' ? '↻' : '✓';
      const why =
        run.purpose === 'catch_up'
          ? ' (caught up after sleep)'
          : run.purpose === 'retry'
            ? ' (retry)'
            : run.purpose === 'follow_up'
              ? ' (follow-up)'
              : run.purpose === 'refresh'
                ? ' (refresh)'
                : '';
      return `${mark} ${when}${why}${tail(run.summary)}`;
    }
  }
}

function toneOf(job: Job): JobRow['tone'] {
  if (job.state === 'paused') return 'bad';
  const last = job.lastRun;
  if (!last) return 'idle';
  switch (last.outcome) {
    case 'failed':
      return 'bad';
    case 'interrupted':
      return 'catchup';
    case 'running':
      return 'idle';
    default:
      return last.purpose === 'catch_up' ? 'catchup' : 'ok';
  }
}

/** The job a job-owned question belongs to. */
function jobIdOfQuestion(q: Question): Id | undefined {
  return q.context.finding?.jobId ?? q.context.jobFailure?.jobId ?? q.context.spend?.jobId;
}

/** "Claude" from "claude", "ChatGPT" from "chatgpt" (P11-09: the protocol's labels). */
export function providerText(provider: string): string {
  const known = Provider.safeParse(provider);
  if (known.success) return PROVIDER_LABEL[known.data];
  return provider ? provider[0]!.toUpperCase() + provider.slice(1) : provider;
}

const byCreation = <T extends { createdAt: string; name: string }>(a: T, b: T) =>
  a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name);

// --- the model ---------------------------------------------------------------------------------

export function jobsModel(
  world: WorldState,
  projectId: Id,
  filter: { bodyId?: Id } = {},
  now: Date = new Date(),
): JobsModel {
  const allAreas = Object.values(world.areas ?? {})
    .filter((a) => a.projectId === projectId)
    .sort(byCreation);
  const jobs = Object.values(world.jobs ?? {}).filter((j) => j.projectId === projectId);

  const waitingOf = new Map<Id, Question[]>();
  for (const q of Object.values(world.questions)) {
    if (q.status !== 'open' || !isJobOwned(q)) continue;
    const jobId = jobIdOfQuestion(q);
    if (!jobId) continue;
    const list = waitingOf.get(jobId) ?? [];
    list.push(q);
    waitingOf.set(jobId, list);
  }

  const moonName = (bodyId: Id) => world.bodies[bodyId]?.name ?? 'a moon';

  const rowOf = (job: Job, area: Area): JobRow => {
    const waiting = (waitingOf.get(job.id) ?? []).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const failure = job.failureQuestionId ? world.questions[job.failureQuestionId] : undefined;
    const reason =
      job.state === 'paused'
        ? (job.pausedReason ?? failure?.context.jobFailure?.reason ?? job.lastRun?.summary)
        : undefined;
    const row: JobRow = {
      job,
      area,
      moonName: moonName(area.bodyId),
      scheduleText: scheduleText(job.schedule),
      tone: toneOf(job),
      waiting: waiting.length,
      waitingIds: waiting.map((q) => q.id),
    };
    if (job.state === 'active' && job.nextRunAt) row.nextRunText = whenText(job.nextRunAt, now);
    if (job.lastRun) {
      row.lastLine = runLine(
        job.lastRun,
        now,
        job.lastRun.outcome === 'failed' ? reason : undefined,
      );
    }
    if (job.state === 'paused') {
      const since = new Date(
        job.lastRun?.outcome === 'failed'
          ? (job.lastRun.endedAt ?? job.lastRun.startedAt)
          : job.updatedAt,
      );
      const asked = failure?.status === 'open' ? ' (asked in the inbox)' : '';
      row.pausedText = `paused since ${dayWord(since, now)} — ${reason ?? 'its last run failed'}${asked}`;
    }
    return row;
  };

  const sectionOf = (area: Area): JobsAreaSection => {
    const onMoon = allAreas.filter((a) => a.bodyId === area.bodyId && a.id !== area.id);
    const rows = jobs
      .filter((j) => j.areaId === area.id)
      .sort(
        (a, b) => Number(a.state === 'stopped') - Number(b.state === 'stopped') || byCreation(a, b),
      )
      .map((j) => rowOf(j, area));
    return {
      area,
      moonName: moonName(area.bodyId),
      shared: onMoon.length > 0,
      sharedWith: onMoon.map((a) => a.name),
      rows,
    };
  };

  // A filter naming a moon none of this project's areas sits on (another project's) is ignored.
  const filtered =
    filter.bodyId !== undefined && allAreas.some((a) => a.bodyId === filter.bodyId)
      ? filter.bodyId
      : undefined;
  const areas = allAreas
    .filter((a) => filtered === undefined || a.bodyId === filtered)
    .map(sectionOf);

  const rows = areas.flatMap((s) => s.rows);
  const needsYou = [
    ...rows.filter((r) => r.job.state === 'paused'),
    ...rows.filter((r) => r.job.state !== 'paused' && r.waiting > 0),
  ];

  const model: JobsModel = { needsYou, areas };
  if (filtered !== undefined) model.moon = { bodyId: filtered, name: moonName(filtered) };
  return model;
}

/** How many of the project's jobs need Cosmin (the Jobs tab's dot). */
export function jobsNeedingYou(world: WorldState, projectId: Id): number {
  return jobsModel(world, projectId).needsYou.length;
}

// --- the moon filter ---------------------------------------------------------------------------

interface JobsFilterState {
  /** The moon whose areas' jobs the tab shows; `undefined`: every job of the project. */
  bodyId?: Id | undefined;
  set: (bodyId?: Id) => void;
}

/**
 * Which moon the Jobs tab is filtered to (a moon's "jobs" action sets it). Not persisted: a
 * reload shows every job again.
 */
export const useJobsFilter = create<JobsFilterState>((set) => ({
  set: (bodyId) => set({ bodyId }),
}));
