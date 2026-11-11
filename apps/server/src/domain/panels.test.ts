import { describe, expect, it } from 'vitest';
import {
  MAX_PANELS_PER_DASHBOARD,
  applyEvent,
  applySnapshot,
  type Actor,
  type EventEnvelope,
  type Id,
  type JobDraft,
  type JobRun,
  type PanelDraft,
  type Snapshot,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { DomainError } from './errors.js';
import type { CommandContext } from './event-log.js';
import { createJob } from './jobs.js';
import {
  arrangePanels,
  clearJobValues,
  clearPanelHistory,
  createPanel,
  removePanel,
  suggestPanelRemoval,
  updatePanel,
} from './panels.js';
import { closeProject, createProject } from './projects.js';

/**
 * P15-03 — the dashboard's panel commands (SPEC decision 156): the 24-panel cap, the order and
 * default sizes of a new panel, arranging (the user's alone, every panel), clearing a panel's
 * history and a job's stored values. Every command's rows equal the protocol fold.
 */

const USER: Actor = { type: 'user' };
const LONG_TERM = { purpose: 'Run the shop', goals: ['grow'] };
const JOB: JobDraft = {
  name: 'Count the sales',
  instructions: 'Count yesterday’s sales.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

const draft = (type: PanelDraft['type'], jobId: Id, title = `A ${type}`): PanelDraft => ({
  type,
  title,
  source: { kind: 'job', jobId, values: ['sales'] },
  display: {},
  limits: [],
});

function setup() {
  const w = world();
  const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
  const recorded: EventEnvelope[] = [];
  w.log.subscribe((e) => recorded.push(e));
  const cmd = <T>(fn: (ctx: CommandContext) => T): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace: '/w/shop',
      bodyId: 'b-saturn',
      longTerm: LONG_TERM,
    }),
  );
  const { job } = cmd((ctx) =>
    createJob(ctx, { projectId: project.id, area: { name: 'Sales' }, draft: JOB, by: USER }),
  );
  const err = (fn: () => unknown): DomainError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  const conforms = () => {
    let folded = applySnapshot(start);
    for (const env of recorded) folded = applyEvent(folded, env);
    const snap = w.log.snapshot();
    expect(folded.panels).toEqual(Object.fromEntries((snap.panels ?? []).map((p) => [p.id, p])));
  };
  return { ...w, cmd, project, job, err, conforms };
}

describe('createPanel', () => {
  it('puts each panel at the end, with the default size of its type', () => {
    const { cmd, project, job, conforms } = setup();
    const sizes = (['tile', 'line', 'bar', 'table', 'list', 'calendar', 'status', 'text'] as const)
      .map((type) => cmd((ctx) => createPanel(ctx, project.id, draft(type, job.id), USER)))
      .map((p) => [p.type, p.layout]);
    expect(sizes).toEqual([
      ['tile', { order: 0, w: 1, h: 1 }],
      ['line', { order: 1, w: 2, h: 1 }],
      ['bar', { order: 2, w: 2, h: 1 }],
      ['table', { order: 3, w: 2, h: 1 }],
      ['list', { order: 4, w: 1, h: 2 }],
      ['calendar', { order: 5, w: 1, h: 2 }],
      ['status', { order: 6, w: 2, h: 1 }],
      ['text', { order: 7, w: 2, h: 1 }],
    ]);
    conforms();
  });

  it('follows the highest order, not the count', () => {
    const { cmd, project, job } = setup();
    const a = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    cmd((ctx) => updatePanel(ctx, a.id, { layout: { ...a.layout, order: 9 } }, USER));
    const b = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    expect(b.layout.order).toBe(10);
  });

  it(`refuses the ${MAX_PANELS_PER_DASHBOARD + 1}th panel with 'limit'`, () => {
    const { cmd, project, job, err, tables } = setup();
    for (let i = 0; i < MAX_PANELS_PER_DASHBOARD; i++) {
      cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    }
    const refused = err(() =>
      cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER)),
    );
    expect(refused.code).toBe('limit');
    expect(tables.panels.all()).toHaveLength(MAX_PANELS_PER_DASHBOARD);
  });

  it('refuses a short-term or closed project, the placeholder job and a job of another project', () => {
    const { cmd, project, job, err } = setup();
    const short = cmd((ctx) =>
      createProject(ctx, { name: 'Lab', workspace: '/w/lab', kind: 'planet' }),
    );
    expect(
      err(() => cmd((ctx) => createPanel(ctx, short.id, draft('tile', job.id), USER))).code,
    ).toBe('invalid');
    expect(
      err(() => cmd((ctx) => createPanel(ctx, project.id, draft('tile', '$new'), USER))).code,
    ).toBe('invalid');
    expect(
      err(() => cmd((ctx) => createPanel(ctx, project.id, draft('tile', 'j-none'), USER))).code,
    ).toBe('invalid');
    const other = cmd((ctx) =>
      createProject(ctx, {
        name: 'Farm',
        workspace: '/w/farm',
        bodyId: 'b-jupiter',
        longTerm: LONG_TERM,
      }),
    );
    expect(
      err(() => cmd((ctx) => createPanel(ctx, other.id, draft('tile', job.id), USER))).code,
    ).toBe('invalid');
    cmd((ctx) => closeProject(ctx, project.id, USER));
    expect(
      err(() => cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER))).code,
    ).toBe('invalid');
  });
});

describe('updatePanel and removePanel', () => {
  it('re-checks the whole panel: a tile cannot be switched to the project’s tasks', () => {
    const { cmd, project, job, err, tables } = setup();
    const tile = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    const refused = err(() =>
      cmd((ctx) => updatePanel(ctx, tile.id, { source: { kind: 'tasks' } }, USER)),
    );
    expect(refused.code).toBe('invalid');
    expect(tables.panels.get(tile.id)?.source.kind).toBe('job');
  });

  it('a null removal suggestion clears it; a removal deletes the row', () => {
    const { cmd, project, job, tables, conforms } = setup();
    const p = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    cmd((ctx) => suggestPanelRemoval(ctx, p.id));
    expect(tables.panels.get(p.id)?.removalSuggestedAt).toBeDefined();
    cmd((ctx) => updatePanel(ctx, p.id, { removalSuggestedAt: null }, USER));
    expect(tables.panels.get(p.id)?.removalSuggestedAt).toBeUndefined();
    conforms();
    cmd((ctx) => removePanel(ctx, p.id, USER, 'not needed'));
    expect(tables.panels.get(p.id)).toBeUndefined();
    conforms();
  });
});

describe('arrangePanels', () => {
  it('the user rearranges every panel in one event', () => {
    const { cmd, project, job, tables, conforms } = setup();
    const a = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    const b = cmd((ctx) => createPanel(ctx, project.id, draft('line', job.id), USER));
    cmd((ctx) =>
      arrangePanels(
        ctx,
        project.id,
        [
          { panelId: a.id, layout: { order: 1, w: 2, h: 2 } },
          { panelId: b.id, layout: { order: 0, w: 4, h: 1, hidden: true } },
        ],
        USER,
      ),
    );
    expect(tables.panels.get(a.id)?.layout).toEqual({ order: 1, w: 2, h: 2 });
    expect(tables.panels.get(b.id)?.layout).toEqual({ order: 0, w: 4, h: 1, hidden: true });
    conforms();
  });

  it('is refused from an agent, for a missing panel and for a repeated order', () => {
    const { cmd, project, job, err, tables } = setup();
    const a = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    const b = cmd((ctx) => createPanel(ctx, project.id, draft('line', job.id), USER));
    const both = [
      { panelId: a.id, layout: { order: 1, w: 1 as const, h: 1 as const } },
      { panelId: b.id, layout: { order: 0, w: 2 as const, h: 1 as const } },
    ];
    const agent: Actor = { type: 'agent', id: 'a-wk' };
    expect(err(() => cmd((ctx) => arrangePanels(ctx, project.id, both, agent))).code).toBe(
      'invalid',
    );
    expect(err(() => cmd((ctx) => arrangePanels(ctx, project.id, [both[0]!], USER))).code).toBe(
      'invalid',
    );
    const same = [both[0]!, { ...both[1]!, layout: { ...both[1]!.layout, order: 1 } }];
    expect(err(() => cmd((ctx) => arrangePanels(ctx, project.id, same, USER))).code).toBe(
      'invalid',
    );
    expect(tables.panels.get(a.id)?.layout.order).toBe(0);
  });
});

describe('clearing', () => {
  it('clearPanelHistory sets historyFrom to now', () => {
    const { cmd, project, job, tables, seen, conforms } = setup();
    const p = cmd((ctx) => createPanel(ctx, project.id, draft('line', job.id), USER));
    const cleared = cmd((ctx) => clearPanelHistory(ctx, p.id, USER));
    const at = seen.at(-1)!.at;
    expect(cleared.historyFrom).toBe(at);
    expect(tables.panels.get(p.id)?.historyFrom).toBe(at);
    conforms();
  });

  it('clearJobValues empties the runs’ numbers and data and lists the panels reading the job', () => {
    const { cmd, project, job, tables, seen } = setup();
    const run = (n: number): JobRun => ({
      id: `jr-${n}`,
      jobId: job.id,
      purpose: 'scheduled',
      dueAt: `2026-09-0${n}T09:00:00.000Z`,
      startedAt: `2026-09-0${n}T09:00:00.000Z`,
      endedAt: `2026-09-0${n}T09:05:00.000Z`,
      outcome: 'quiet',
      numbers: { sales: n },
      data: { texts: { note: `day ${n}` } },
    });
    tables.jobRuns.insert(run(1));
    // An older run that still carries its Steward's report as `meta.report`.
    tables.jobRuns.insert({
      ...run(2),
      meta: { note: 'kept', report: { outcome: 'quiet', summary: 's', numbers: { sales: 2 } } },
    });
    // A run started after "now" (the test clock reads 2026-10-01) keeps its values.
    tables.jobRuns.insert({ ...run(3), id: 'jr-later', startedAt: '2026-12-01T09:00:00.000Z' });
    const a = cmd((ctx) => createPanel(ctx, project.id, draft('tile', job.id), USER));
    const b = cmd((ctx) => createPanel(ctx, project.id, draft('line', job.id), USER));
    cmd((ctx) =>
      createPanel(
        ctx,
        project.id,
        { type: 'status', title: 'Tasks', source: { kind: 'tasks' }, display: {}, limits: [] },
        USER,
      ),
    );
    const out = cmd((ctx) => clearJobValues(ctx, job.id, USER));
    const event = seen.at(-1)!;
    expect(event.event).toEqual({
      type: 'job.values_cleared',
      jobId: job.id,
      upTo: event.at,
      by: USER,
    });
    expect(out).toEqual({ upTo: event.at, panels: [a.id, b.id] });
    for (const id of ['jr-1', 'jr-2']) {
      const r = tables.jobRuns.get(id)!;
      expect(r.numbers).toBeUndefined();
      expect(r.data).toBeUndefined();
      expect(r.meta?.['report']).toBeUndefined();
      expect(r.outcome).toBe('quiet');
    }
    expect(tables.jobRuns.get('jr-2')?.meta).toEqual({ note: 'kept' });
    expect(tables.jobRuns.get('jr-later')?.numbers).toEqual({ sales: 3 });
  });
});
