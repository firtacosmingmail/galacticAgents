import { beforeEach, describe, expect, it } from 'vitest';
import {
  emptyWorld,
  type Area,
  type Body,
  type Job,
  type Project,
  type Question,
  type WorldState,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { dayWord, jobsModel, jobsNeedingYou, runLine, useJobsFilter } from './jobs-model.js';

/**
 * P10-07 — the Jobs tab's model: what needs Cosmin first (paused jobs, jobs with questions in the
 * inbox), then one section per area with its moon; a moon filter; times in local words.
 */

/** Tuesday 27 October 2026, 10:00 local time. */
const NOW = new Date(2026, 9, 27, 10, 0);
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();

const titan: Body = { id: 'b-titan', kind: 'moon', parentId: 'b-saturn', name: 'Titan' };
const rhea: Body = { id: 'b-rhea', kind: 'moon', parentId: 'b-saturn', name: 'Rhea' };
const shop: Project = { ...fx.project, id: 'p-shop', name: 'Shop', longTerm: true };
const area = (id: string, name: string, bodyId: string, at = fx.NOW): Area => ({
  id,
  projectId: 'p-shop',
  name,
  bodyId,
  createdAt: at,
  updatedAt: at,
});
const feedback = area('ar-feedback', 'Feedback', 'b-titan', '2026-10-01T00:00:00.000Z');
const sales = area('ar-sales', 'Sales', 'b-titan', '2026-10-02T00:00:00.000Z');
const marketing = area('ar-marketing', 'Marketing', 'b-rhea', '2026-10-03T00:00:00.000Z');

/** A job of the shop; `undefined` in `over` drops that field. */
const job = (over: { [K in keyof Job]?: Job[K] | undefined }): Job => {
  const { lastRun: _lastRun, ...base } = fx.job;
  const out: Record<string, unknown> = {
    ...base,
    projectId: 'p-shop',
    areaId: 'ar-feedback',
    nextRunAt: local(28, 9),
    ...over,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as Job;
};
const finding = (id: string, jobId: string, status: Question['status'] = 'open'): Question => ({
  ...fx.question,
  id,
  status,
  holder: { type: 'user' },
  context: {
    text: 'An idea',
    finding: { jobId, runId: 'jr-1', kind: 'suggestion', title: 'Dark mode' },
  },
});

const replies = job({
  id: 'j-replies',
  name: 'Read feedback, draft replies',
  lastRun: {
    runId: 'jr-1',
    outcome: 'findings',
    purpose: 'scheduled',
    startedAt: local(27, 9, 2),
    endedAt: local(27, 9, 5),
    summary: '14 new messages · 3 need you',
  },
});
const pipeline = job({
  id: 'j-pipeline',
  areaId: 'ar-sales',
  name: 'Weekly pipeline report',
  state: 'paused',
  pausedReason: 'CRM login expired',
  failureQuestionId: 'q-fail',
  nextRunAt: undefined,
  lastRun: {
    runId: 'jr-9',
    outcome: 'failed',
    purpose: 'scheduled',
    startedAt: local(27, 8),
    endedAt: local(27, 8, 1),
  },
});
const ideas = job({
  id: 'j-ideas',
  areaId: 'ar-marketing',
  name: 'Post ideas',
  schedule: { kind: 'weekly', days: [1, 4], at: '10:00' },
});
const old = job({ id: 'j-old', name: 'Old digest', state: 'stopped', createdAt: fx.NOW });
const failure: Question = {
  ...fx.question,
  id: 'q-fail',
  holder: { type: 'user' },
  context: {
    text: 'Weekly pipeline report failed',
    jobFailure: { jobId: 'j-pipeline', runId: 'jr-9', reason: 'CRM login expired' },
  },
};

function world(): WorldState {
  const w = emptyWorld();
  return {
    ...w,
    bodies: { [titan.id]: titan, [rhea.id]: rhea },
    projects: { [shop.id]: shop },
    areas: { [feedback.id]: feedback, [sales.id]: sales, [marketing.id]: marketing },
    jobs: { [old.id]: old, [replies.id]: replies, [pipeline.id]: pipeline, [ideas.id]: ideas },
    questions: {
      [failure.id]: failure,
      'q-1': finding('q-1', 'j-replies'),
      'q-2': finding('q-2', 'j-replies'),
      'q-3': finding('q-3', 'j-replies', 'answered'),
      'q-4': finding('q-4', 'j-elsewhere'),
    },
  };
}

beforeEach(() => useJobsFilter.getState().set(undefined));

describe('jobsModel (P10-07)', () => {
  it('puts a paused job first in "Needs you" and counts open findings per job', () => {
    const m = jobsModel(world(), 'p-shop', {}, NOW);
    expect(m.needsYou.map((r) => r.job.id)).toEqual(['j-pipeline', 'j-replies']);
    const [paused, waiting] = m.needsYou;
    expect(paused!.pausedText).toBe('paused since today — CRM login expired (asked in the inbox)');
    expect(paused!.tone).toBe('bad');
    expect(paused!.lastLine).toBe('✕ today 8:00 — CRM login expired');
    expect(paused!.nextRunText).toBeUndefined();
    expect(waiting!.waiting).toBe(2);
    expect(waiting!.waitingIds).toEqual(['q-1', 'q-2']);
    expect(jobsNeedingYou(world(), 'p-shop')).toBe(2);
  });

  it('lists one section per area with its moon, a shared moon named, stopped jobs last', () => {
    const m = jobsModel(world(), 'p-shop', {}, NOW);
    expect(m.moon).toBeUndefined();
    expect(m.areas.map((s) => [s.area.name, s.moonName, s.shared, s.sharedWith])).toEqual([
      ['Feedback', 'Titan', true, ['Sales']],
      ['Sales', 'Titan', true, ['Feedback']],
      ['Marketing', 'Rhea', false, []],
    ]);
    expect(m.areas[0]!.rows.map((r) => r.job.id)).toEqual(['j-replies', 'j-old']);
    const row = m.areas[0]!.rows[0]!;
    expect(row.scheduleText).toBe('every day 9:00');
    expect(row.lastLine).toBe('✓ today 9:02 — 14 new messages · 3 need you');
    expect(row.tone).toBe('ok');
    expect(m.areas[0]!.rows[1]!.nextRunText).toBeUndefined();
    expect(m.areas[2]!.rows[0]!.tone).toBe('idle');
    expect(m.areas[2]!.rows[0]!.scheduleText).toBe('Mon, Thu 10:00');
  });

  it('reads the next run as "tomorrow 9:00"', () => {
    const m = jobsModel(world(), 'p-shop', {}, NOW);
    expect(m.areas[0]!.rows[0]!.nextRunText).toBe('tomorrow 9:00');
  });

  it('filtered by a shared moon, returns both of its areas', () => {
    const m = jobsModel(world(), 'p-shop', { bodyId: 'b-titan' }, NOW);
    expect(m.moon).toEqual({ bodyId: 'b-titan', name: 'Titan' });
    expect(m.areas.map((s) => s.area.name)).toEqual(['Feedback', 'Sales']);
    expect(m.needsYou.map((r) => r.job.id)).toEqual(['j-pipeline', 'j-replies']);
    const rhea = jobsModel(world(), 'p-shop', { bodyId: 'b-rhea' }, NOW);
    expect(rhea.areas.map((s) => s.area.name)).toEqual(['Marketing']);
    expect(rhea.needsYou).toEqual([]);
    // Another project's moon: no filter.
    expect(jobsModel(world(), 'p-shop', { bodyId: 'b-luna' }, NOW).areas).toHaveLength(3);
  });

  it('writes runs as the mockup does', () => {
    const run = { startedAt: local(26, 11, 40), summary: '22 messages' };
    expect(runLine({ ...run, outcome: 'quiet', purpose: 'catch_up' }, NOW)).toBe(
      '↻ yesterday 11:40 (caught up after sleep) — 22 messages',
    );
    expect(runLine({ ...run, outcome: 'failed', purpose: 'scheduled' }, NOW)).toBe(
      '✕ yesterday 11:40 — 22 messages',
    );
    expect(runLine({ ...run, outcome: 'running', purpose: 'scheduled' }, NOW)).toBe(
      '▶ running since yesterday 11:40',
    );
    expect(dayWord(new Date(2026, 9, 25, 9), NOW)).toBe('Sun');
    expect(dayWord(new Date(2026, 10, 1, 9), NOW)).toBe('Sun');
    expect(dayWord(new Date(2026, 10, 3, 9), NOW)).toBe('Nov 3');
  });

  it('keeps the moon filter in a small store, not persisted', () => {
    useJobsFilter.getState().set('b-titan');
    expect(useJobsFilter.getState().bodyId).toBe('b-titan');
    useJobsFilter.getState().set();
    expect(useJobsFilter.getState().bodyId).toBeUndefined();
  });
});
