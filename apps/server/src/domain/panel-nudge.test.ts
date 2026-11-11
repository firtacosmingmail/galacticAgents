import { describe, expect, it } from 'vitest';
import type { Actor, JobDraft, JobRun, PanelDraft } from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import type { CommandContext } from './event-log.js';
import { createJob } from './jobs.js';
import { nudgeUnchangedPanels } from './panel-nudge.js';
import { createPanel, panelOf } from './panels.js';
import { createProject } from './projects.js';

/**
 * P15-05 — the unchanged-panel nudge (ruling R5): a panel whose value has not changed for 28 days
 * sends the project's Waykeeper one system message and is marked; a changed value clears the mark
 * so a later streak can nudge again; a panel changed this week, or a project without a Waykeeper,
 * nudges no one.
 */

const USER: Actor = { type: 'user' };
const DAY = 86_400_000;
const JOB: JobDraft = {
  name: 'Count the sales',
  instructions: 'Count yesterday’s sales.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};
const TILE: PanelDraft = {
  type: 'tile',
  title: 'Sales',
  source: { kind: 'job', jobId: '', values: ['sales'] },
  display: {},
  limits: [],
};

function setup() {
  const w = world();
  const cmd = <T>(fn: (ctx: CommandContext) => T): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace: '/w/shop',
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    }),
  );
  const wk = cmd((ctx) =>
    createAgent(ctx, {
      role: 'waykeeper',
      runtime: 'fake',
      caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
      projectId: project.id,
    }),
  );
  const { job } = cmd((ctx) =>
    createJob(ctx, { projectId: project.id, area: { name: 'Sales' }, draft: JOB, by: USER }),
  );
  const panel = cmd((ctx) =>
    createPanel(
      ctx,
      project.id,
      { ...TILE, source: { kind: 'job', jobId: job.id, values: ['sales'] } },
      USER,
    ),
  );
  let n = 0;
  /** A good run `daysAgo` days before now, reporting `sales`. */
  const run = (daysAgo: number, sales: number, outcome: JobRun['outcome'] = 'quiet') => {
    const at = new Date(Date.parse(w.log.clock()) - daysAgo * DAY).toISOString();
    w.log.tables.jobRuns.insert({
      id: `jr-${++n}`,
      jobId: job.id,
      purpose: 'scheduled',
      dueAt: at,
      startedAt: at,
      endedAt: at,
      outcome,
      numbers: { sales },
    });
  };
  const nudge = () => cmd((ctx) => nudgeUnchangedPanels(ctx, project.id));
  const nudges = () =>
    w.seen.flatMap(({ event }) =>
      event.type === 'message.sent' && event.fromPanel !== undefined ? [event] : [],
    );
  return { ...w, cmd, project, wk, job, panel, run, nudge, nudges };
}

describe('nudgeUnchangedPanels', () => {
  it('a panel unchanged for 29 days nudges the Waykeeper once, and not again on the next run', () => {
    const s = setup();
    s.run(29, 5);
    s.run(10, 5);
    s.run(1, 5);
    expect(s.nudge()).toEqual([s.panel.id]);
    const [message] = s.nudges();
    expect(message).toMatchObject({
      agentId: s.wk.id,
      sender: { type: 'system' },
      fromPanel: s.panel.id,
      interrupt: false,
    });
    expect(message!.text).toMatch(
      /^Panel 'Sales' has not changed since \d{4}-\d{2}-\d{2}; propose removing it if it is no longer useful$/,
    );
    expect(panelOf(s.log, s.panel.id).removalSuggestedAt).toBeDefined();
    s.run(0, 5);
    expect(s.nudge()).toEqual([]);
    expect(s.nudges()).toHaveLength(1);
  });

  it('a panel unchanged for 27 days is left alone', () => {
    const s = setup();
    s.run(27, 5);
    s.run(1, 5);
    expect(s.nudge()).toEqual([]);
    expect(s.nudges()).toHaveLength(0);
    expect(panelOf(s.log, s.panel.id).removalSuggestedAt).toBeUndefined();
  });

  it('a changed value clears the suggestion, so a later 28-day streak nudges again', () => {
    const s = setup();
    s.run(40, 5);
    s.run(1, 5);
    s.nudge();
    expect(panelOf(s.log, s.panel.id).removalSuggestedAt).toBeDefined();
    // The value changes: the mark is cleared at the next check.
    s.run(0, 6);
    expect(s.nudge()).toEqual([]);
    expect(panelOf(s.log, s.panel.id).removalSuggestedAt).toBeUndefined();
    // Nothing changes for 28 more days: a fresh nudge.
    s.clock.advance(29 * DAY);
    expect(s.nudge()).toEqual([s.panel.id]);
    expect(s.nudges()).toHaveLength(2);
  });

  it('sends nothing and marks nothing when the project has no Waykeeper row', () => {
    const s = setup();
    s.tables.agents.delete(s.wk.id);
    s.run(40, 5);
    s.run(1, 5);
    expect(s.nudge()).toEqual([]);
    expect(panelOf(s.log, s.panel.id).removalSuggestedAt).toBeUndefined();
  });
});
