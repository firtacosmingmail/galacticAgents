import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  proposalPanelOf,
  type Id,
  type JobDraft,
  type PanelDraft,
  type Project,
} from '@galactic/protocol';
import { createPanel } from '../../domain/panels.js';
import { brainHarness, type BrainHarness, type ToolOutcome } from '../testing/index.js';
import { WAYKEEPER_SYSTEM_PROMPT, waykeeperDefinition } from './index.js';

/**
 * P15-05 — the Waykeeper's dashboard tools (SPEC decision 156): `propose_panel` and
 * `propose_panel_remove` make one card each, checked before it exists; `list_panels` reads what
 * each panel shows; the tools exist only for a long-term project's Waykeeper; and the Waykeeper is
 * woken when its panel card is decided.
 */

const USER = { type: 'user' } as const;
const LONG_TERM = { purpose: 'Run the shop', goals: ['grow'] };
const DAILY = { kind: 'daily', at: '09:00' } as const;
const JOB: JobDraft = {
  name: 'Count the sales',
  instructions: 'Count yesterday’s sales.',
  schedule: DAILY,
  provider: 'claude',
  unattendedRules: [],
  dataMap: {
    sources: [{ id: 'db', kind: 'database', label: 'Shop database', target: 'shop.sqlite' }],
    collects: [
      { name: 'sales', kind: 'number', sourceIds: ['db'], description: 'Yesterday’s sales' },
    ],
    steps: [],
  },
};
const tile = (jobId: Id, title = 'Sales'): PanelDraft => ({
  type: 'tile',
  title,
  source: { kind: 'job', jobId, values: ['sales'] },
  display: {},
  limits: [],
});

let h: BrainHarness;
beforeEach(() => {
  h = brainHarness();
});
afterEach(async () => {
  await h.dispose().catch(() => {});
});

async function longTermProject(): Promise<Project> {
  return (
    await h.commands.createProject({ name: 'Shop', workspace: '/tmp/shop', longTerm: LONG_TERM })
  ).value;
}
async function shopJob(project: Project) {
  return (
    await h.commands.createJob({
      projectId: project.id,
      area: { name: 'Sales' },
      draft: JOB,
      by: USER,
    })
  ).value.job;
}

/** A Waykeeper on `project` whose script calls `tool` with `input` when told "go". */
async function waykeeperCalling(project: Project, tool: string, input: unknown) {
  const out: {
    result?: ToolOutcome;
    results?: Record<string, ToolOutcome>;
    errors?: Record<string, string>;
  } = {};
  const hq = await h.startHarmonizer();
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      script: (s) =>
        s
          .once('go', async (t) => {
            for (const name of tool.split(',')) {
              try {
                out.result = await t.try(name, input);
                (out.results ??= {})[name] = out.result;
              } catch (error) {
                (out.errors ??= {})[name] = (error as Error).message;
              }
            }
          })
          .on(/was (approved|rejected)/, () => {}),
    },
  );
  wk.tell('go');
  await h.settle();
  return { wk, out };
}

const theCard = () => h.log.tables.proposals.all().find((p) => proposalPanelOf(p));

describe('propose_panel (P15-05)', () => {
  it('with `use` opens one card whose job part is {use}; the job is untouched', async () => {
    const project = await longTermProject();
    const job = await shopJob(project);
    const { wk, out } = await waykeeperCalling(project, 'propose_panel', {
      draft: tile(job.id),
      job: { use: job.id },
      rationale: 'Sales matter',
    });
    expect(out.result).toMatchObject({ ok: true, turnEnded: true });
    const card = theCard()!;
    expect(card).toMatchObject({ state: 'pending', rationale: 'Sales matter' });
    expect(proposalPanelOf(card)).toMatchObject({
      action: 'create',
      waykeeperId: wk.agentId,
      draft: { title: 'Sales' },
      job: { use: job.id },
    });
    expect(h.log.tables.panels.all()).toHaveLength(0);
    expect(h.log.tables.jobs.all()).toHaveLength(1);
    await h.done();
  });

  it('with `create` builds the new job part like propose_job, a dataMap included; approval makes both', async () => {
    const project = await longTermProject();
    const { out } = await waykeeperCalling(project, 'propose_panel', {
      draft: tile('$new'),
      job: {
        create: {
          area: 'Sales',
          name: JOB.name,
          instructions: JOB.instructions,
          schedule: DAILY,
          dataMap: JOB.dataMap,
        },
      },
    });
    expect(out.result).toMatchObject({ ok: true });
    const part = proposalPanelOf(theCard())?.job;
    expect(part).toMatchObject({
      propose: {
        action: 'create',
        area: { name: 'Sales' },
        draft: { name: JOB.name, dataMap: JOB.dataMap },
      },
    });
    await h.commands.decideProposal(theCard()!.id, { decision: 'approve' }, USER, {
      origin: 'local',
    });
    await h.done();
    const [job] = h.log.tables.jobs.all();
    const [panel] = h.log.tables.panels.all();
    expect(job?.dataMap).toEqual(JOB.dataMap);
    expect(panel?.source).toEqual({ kind: 'job', jobId: job!.id, values: ['sales'] });
  });

  it('with `change` proposes a change to an existing job, in the same card', async () => {
    const project = await longTermProject();
    const job = await shopJob(project);
    const { out } = await waykeeperCalling(project, 'propose_panel', {
      draft: tile(job.id),
      job: { change: { jobId: job.id, changes: { schedule: { kind: 'weekdays', at: '08:30' } } } },
    });
    expect(out.result).toMatchObject({ ok: true });
    expect(proposalPanelOf(theCard())?.job).toMatchObject({
      propose: { action: 'change', jobId: job.id, draft: { schedule: { kind: 'weekdays' } } },
    });
    await h.done();
  });

  it('a tile with a tasks source is refused as invalid, before any card', async () => {
    const project = await longTermProject();
    const { out } = await waykeeperCalling(project, 'propose_panel', {
      draft: {
        type: 'tile',
        title: 'Tasks',
        source: { kind: 'tasks' },
        display: {},
        limits: [],
      },
    });
    expect(out.result).toMatchObject({ ok: false, error: 'invalid' });
    expect(h.log.tables.proposals.all()).toHaveLength(0);
    await h.done();
  });

  it('refuses a job part that names none or several of use, create and change', async () => {
    const project = await longTermProject();
    const job = await shopJob(project);
    const { out } = await waykeeperCalling(project, 'propose_panel', {
      draft: tile(job.id),
      job: { use: job.id, change: { jobId: job.id, changes: {} } },
    });
    expect(out.result).toMatchObject({ ok: false, error: 'invalid' });
    expect(h.log.tables.proposals.all()).toHaveLength(0);
    await h.done();
  });

  it('a short project’s Waykeeper has the tools, and each refuses: no dashboard', async () => {
    const short = (await h.commands.createProject({ name: 'App', workspace: '/tmp/app' })).value;
    const { out } = await waykeeperCalling(
      short,
      'propose_panel,propose_panel_remove,list_panels',
      {
        draft: {
          type: 'status',
          title: 'Work',
          source: { kind: 'tasks' },
          display: {},
          limits: [],
        },
        panelId: 'pn-none',
        reason: 'r',
      },
    );
    expect(out.errors).toBeUndefined();
    for (const name of ['propose_panel', 'propose_panel_remove', 'list_panels']) {
      expect(out.results?.[name]).toMatchObject({
        ok: false,
        error: 'invalid',
        message: 'a dashboard belongs to a long-term project',
      });
    }
    expect(h.log.tables.proposals.all()).toHaveLength(0);
    await h.done();
  });

  it('a project made long-term after its Waykeeper started may use them at once', async () => {
    const project = (await h.commands.createProject({ name: 'App', workspace: '/tmp/app' })).value;
    const hq = await h.startHarmonizer();
    let listed: ToolOutcome | undefined;
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s.once('go', async (t) => {
            listed = await t.try('list_panels', {});
          }),
      },
    );
    await h.commands.setLongTerm({
      projectId: project.id,
      purpose: 'Run the app',
      goals: [],
      by: USER,
    });
    wk.tell('go');
    await h.settle();
    expect(listed).toMatchObject({ ok: true, value: { panels: [] } });
    await h.done();
  });
});

describe('propose_panel_remove (P15-05)', () => {
  it('opens a removal card with the reason; nothing is removed until it is approved', async () => {
    const project = await longTermProject();
    const job = await shopJob(project);
    const panel = h.log.runCommand((ctx) => createPanel(ctx, project.id, tile(job.id), USER)).value;
    const { out } = await waykeeperCalling(project, 'propose_panel_remove', {
      panelId: panel.id,
      reason: 'it never changes',
    });
    expect(out.result).toMatchObject({ ok: true, turnEnded: true });
    expect(theCard()).toMatchObject({ rationale: 'it never changes' });
    expect(proposalPanelOf(theCard())).toMatchObject({ action: 'remove', panelId: panel.id });
    expect(h.log.tables.panels.get(panel.id)).toBeDefined();
    await h.done();
  });
});

describe('list_panels (P15-05)', () => {
  it('returns each panel with what it shows, since when it is unchanged, and its job’s collects', async () => {
    const project = await longTermProject();
    const job = await shopJob(project);
    const panel = h.log.runCommand((ctx) => createPanel(ctx, project.id, tile(job.id), USER)).value;
    for (const [i, days] of [20, 3].entries()) {
      const at = new Date(Date.now() - days * 86_400_000).toISOString();
      h.log.tables.jobRuns.insert({
        id: `jr-${i}`,
        jobId: job.id,
        purpose: 'scheduled',
        dueAt: at,
        startedAt: at,
        endedAt: at,
        outcome: 'quiet',
        numbers: { sales: 12 },
      });
    }
    const reads = vi.spyOn(h.log.tables.jobRuns, 'of');
    h.log.runCommand((ctx) =>
      createPanel(ctx, project.id, { ...tile(job.id, 'Sales again'), type: 'line' }, USER),
    );
    const { out } = await waykeeperCalling(project, 'list_panels', {});
    // Two panels on one job: its runs are read once.
    expect(reads.mock.calls.filter(([id]) => id === job.id)).toHaveLength(1);
    const [listed] = (out.result as { value: { panels: Record<string, unknown>[] } }).value.panels;
    expect(listed).toMatchObject({
      id: panel.id,
      title: 'Sales',
      job: JOB.name,
      collects: ['sales'],
      data: { status: 'ok', tile: { value: 12 } },
    });
    expect(Date.now() - Date.parse(listed!['unchangedSince'] as string)).toBeGreaterThan(
      19 * 86_400_000,
    );
    await h.done();
  });
});

describe('a panel card’s decision wakes the Waykeeper (P15-05, ruling R11)', () => {
  async function pendingCard() {
    const project = await longTermProject();
    const job = await shopJob(project);
    const { wk } = await waykeeperCalling(project, 'propose_panel', {
      draft: tile(job.id),
      job: { use: job.id },
    });
    return { wk, card: theCard()! };
  }

  it('approval: one turn that says what it did', async () => {
    const { wk, card } = await pendingCard();
    const before = wk.turns.length;
    await h.commands.decideProposal(card.id, { decision: 'approve' }, USER, { origin: 'local' });
    await h.done();
    const later = wk.turns.slice(before);
    expect(later).toHaveLength(1);
    expect(later[0]!.prompt).toContain(
      `proposal ${card.id} was approved: the panel "Sales" was added with the approval`,
    );
    expect(h.log.tables.panels.all()).toHaveLength(1);
  });

  it('rejection: one turn with the reason, and no panel', async () => {
    const { wk, card } = await pendingCard();
    const before = wk.turns.length;
    await h.commands.decideProposal(card.id, { decision: 'reject', reason: 'too many' }, USER);
    await h.done();
    const later = wk.turns.slice(before);
    expect(later).toHaveLength(1);
    expect(later[0]!.prompt).toContain(`proposal ${card.id} was rejected: too many`);
    expect(h.log.tables.panels.all()).toHaveLength(0);
  });
});

describe('the Waykeeper prompt (P15-05)', () => {
  it('tells it how to fill a panel', () => {
    expect(WAYKEEPER_SYSTEM_PROMPT).toContain('propose_panel');
    expect(WAYKEEPER_SYSTEM_PROMPT).toContain('dataMap.collects');
    expect(WAYKEEPER_SYSTEM_PROMPT).toContain('Never rearrange or remove a panel without a card');
  });
});
