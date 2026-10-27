import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposalJobOf, type Id, type JobDraft, type Project } from '@galactic/protocol';
import { brainHarness, type BrainHarness, type ToolOutcome } from '../testing/index.js';
import { WAYKEEPER_SYSTEM_PROMPT, waykeeperDefinition } from './index.js';

/**
 * P10-06 — the Waykeeper's recurring-job tools (SPEC decision 144): one card per job set-up,
 * change or stop, checked before it exists; approving it carries the job out in the deciding
 * transaction and tells the proposing Waykeeper once; rejecting creates nothing.
 */

const USER = { type: 'user' } as const;
const LONG_TERM = { purpose: 'Grow the app', goals: ['1000 users'] };
const DAILY = { kind: 'daily', at: '09:00' } as const;
const DRAFT = {
  name: 'Read reviews',
  instructions: 'Read the new app store reviews and suggest improvements.',
  schedule: DAILY,
};

let h: BrainHarness;
beforeEach(() => {
  h = brainHarness();
});
afterEach(async () => {
  await h.dispose().catch(() => {});
});

async function longTermProject(): Promise<Project> {
  return (
    await h.commands.createProject({ name: 'App', workspace: '/tmp/app', longTerm: LONG_TERM })
  ).value;
}

/** A Waykeeper on `project` whose script calls `tool` with `input` when told "go". */
async function waykeeperCalling(project: Project, tool: string, input: unknown) {
  const out: { result?: ToolOutcome } = {};
  const hq = await h.startHarmonizer();
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      script: (s) =>
        s
          .once('go', async (t) => {
            out.result = await t.try(tool, input);
          })
          .on(/was (approved|rejected)/, () => {}),
    },
  );
  wk.tell('go');
  await h.settle();
  return { wk, out };
}

const theCard = () => h.log.tables.proposals.all().find((p) => proposalJobOf(p));

describe('propose_job (P10-06)', () => {
  it('opens one card; approval creates the area, task and job in one transaction and wakes the Waykeeper once', async () => {
    const project = await longTermProject();
    const { wk, out } = await waykeeperCalling(project, 'propose_job', {
      area: 'Feedback',
      ...DRAFT,
      unattendedRules: [
        {
          label: 'may call api.myapp.com',
          tool: 'WebFetch',
          scope: 'prefix',
          match: { kind: 'text', text: 'https://api.myapp.com/' },
          categories: ['network'],
        },
      ],
    });
    expect(out.result).toMatchObject({ ok: true, turnEnded: true });
    const cards = h.log.tables.proposals.all();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({
      state: 'pending',
      requestText: 'New recurring job: Read reviews',
      proposedBody: { bodyId: project.bodyId },
    });
    expect(proposalJobOf(card)).toMatchObject({
      projectId: project.id,
      waykeeperId: wk.agentId,
      action: 'create',
      area: { name: 'Feedback' },
      draft: {
        ...DRAFT,
        provider: 'claude',
        unattendedRules: [{ label: 'may call api.myapp.com' }],
      },
    });
    expect(h.log.tables.jobs.all()).toHaveLength(0);
    const turnsBefore = wk.turns.length;

    const { events } = await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
    expect(events.map((e) => e.type)).toEqual([
      'proposal.approved',
      'area.created',
      'body.assigned',
      'task.created',
      'job.created',
    ]);
    await h.done();
    const [job] = h.log.tables.jobs.all();
    const [area] = h.log.tables.areas.all();
    expect(area).toMatchObject({ projectId: project.id, name: 'Feedback' });
    expect(job).toMatchObject({ areaId: area!.id, name: 'Read reviews', state: 'active' });
    expect(job!.unattendedRules[0]!.id).toBeTruthy();
    expect(h.log.tables.tasks.get(job!.taskId)).toMatchObject({ bodyId: area!.bodyId });
    // One turn, about the decision; the job's hidden task does not wake it as new work.
    const later = wk.turns.slice(turnsBefore);
    expect(later).toHaveLength(1);
    expect(later[0]!.prompt).toContain(
      `proposal ${card.id} was approved: the recurring job "Read reviews" was created with the approval`,
    );
    expect(later[0]!.prompt).not.toContain('was added to your project');
  });

  it('a rejected card creates nothing', async () => {
    const project = await longTermProject();
    await waykeeperCalling(project, 'propose_job', { area: 'Feedback', ...DRAFT });
    const card = theCard()!;
    await h.commands.decideProposal(card.id, { decision: 'reject', reason: 'not now' }, USER);
    await h.done();
    expect(h.log.tables.proposals.get(card.id)?.state).toBe('rejected');
    expect(h.log.tables.jobs.all()).toHaveLength(0);
    expect(h.log.tables.areas.all()).toHaveLength(0);
    expect(h.log.tables.tasks.all()).toHaveLength(0);
  });

  it.each([
    [
      'a push rule',
      {
        unattendedRules: [
          {
            label: 'may push',
            tool: 'Bash',
            scope: 'prefix',
            match: { kind: 'words', words: ['git', 'push'] },
            categories: ['push'],
          },
        ],
      },
      'a job never pushes unattended',
    ],
    [
      'a key in the instructions',
      { instructions: 'Call the API with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' },
      'looks like a secret',
    ],
    ['an area name over 60 characters', { area: 'x'.repeat(61) }, 'an area name is 1–60'],
    ['a bad schedule', { schedule: { kind: 'daily', at: '9:00' } }, 'invalid job'],
  ])('is refused before any card for %s', async (_what, change, message) => {
    const project = await longTermProject();
    const { out } = await waykeeperCalling(project, 'propose_job', {
      area: 'Feedback',
      ...DRAFT,
      ...change,
    });
    expect(out.result).toMatchObject({ ok: false, error: 'invalid' });
    expect(out.result?.message).toContain(message);
    expect(h.log.tables.proposals.all()).toHaveLength(0);
    await h.done();
  });

  it('is refused on an ordinary project', async () => {
    const project = (await h.commands.createProject({ name: 'Tool', workspace: '/tmp/tool' }))
      .value;
    const { out } = await waykeeperCalling(project, 'propose_job', { area: 'Feedback', ...DRAFT });
    expect(out.result).toMatchObject({
      ok: false,
      error: 'invalid',
      message: 'jobs live on long-term projects',
    });
    expect(h.log.tables.proposals.all()).toHaveLength(0);
    await h.done();
  });

  it('a job card is the user’s: no edit, no agent decision', async () => {
    const project = await longTermProject();
    const { wk } = await waykeeperCalling(project, 'propose_job', { area: 'Feedback', ...DRAFT });
    const card = theCard()!;
    await expect(
      h.commands.decideProposal(
        card.id,
        { decision: 'approve' },
        { type: 'agent', id: wk.agentId },
      ),
    ).rejects.toThrow(/the user's to decide/);
    await expect(
      h.commands.decideProposal(card.id, { decision: 'edit', changes: { workspace: '/x' } }, USER),
    ).rejects.toThrow(/reject it with a reason/);
    await expect(
      h.commands.createProposal({
        requestText: 'sneaky',
        kind: 'planet',
        proposedBody: { kind: 'planet', name: 'x' },
        workspace: '/tmp/x',
        rationale: '',
        meta: { job: proposalJobOf(card) },
      }),
    ).rejects.toThrow(/made by proposeJob/);
    await h.done();
  });
});

async function existingJob(project: Project, draft: Partial<JobDraft> = {}) {
  return (
    await h.commands.createJob({
      projectId: project.id,
      area: { name: 'Feedback' },
      draft: { ...DRAFT, provider: 'claude', unattendedRules: [], ...draft },
      by: USER,
    })
  ).value.job;
}

describe('propose_job_change and propose_job_stop (P10-06)', () => {
  it('a change card shows before → after; approving applies it', async () => {
    const project = await longTermProject();
    const job = await existingJob(project);
    const { out } = await waykeeperCalling(project, 'propose_job_change', {
      jobId: job.id,
      changes: { schedule: { kind: 'weekdays', at: '08:30' } },
    });
    expect(out.result).toMatchObject({
      ok: true,
      value: {
        before: { name: 'Read reviews', schedule: 'every day 9:00' },
        after: { name: 'Read reviews', schedule: 'weekdays 8:30' },
      },
    });
    const card = theCard()!;
    expect(proposalJobOf(card)).toMatchObject({
      action: 'change',
      jobId: job.id,
      draft: { schedule: { kind: 'weekdays', at: '08:30' } },
      before: { areaId: job.areaId, draft: { schedule: DAILY } },
    });
    expect(h.log.tables.jobs.get(job.id)?.schedule).toEqual(DAILY);
    // One card per job waits at a time.
    const second = await h.commands
      .proposeJob({
        projectId: project.id,
        waykeeperId: proposalJobOf(card)!.waykeeperId,
        action: 'stop',
        jobId: job.id,
      })
      .catch((e: Error) => e);
    expect(String(second)).toContain('is waiting for the user');

    // An edit made meanwhile to another field stands.
    await h.commands.updateJob({ jobId: job.id, changes: { name: 'Reviews' }, by: USER });
    await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
    await h.done();
    expect(h.log.tables.jobs.get(job.id)).toMatchObject({
      name: 'Reviews',
      schedule: { kind: 'weekdays', at: '08:30' },
    });
  });

  it('a change that changes nothing is refused before any card', async () => {
    const project = await longTermProject();
    const job = await existingJob(project);
    const { out } = await waykeeperCalling(project, 'propose_job_change', {
      jobId: job.id,
      changes: { schedule: DAILY },
    });
    expect(out.result).toMatchObject({ ok: false, error: 'invalid' });
    expect(h.log.tables.proposals.all()).toHaveLength(0);
    await h.done();
  });

  it('an approved stop card stops the job', async () => {
    const project = await longTermProject();
    const job = await existingJob(project);
    const { out } = await waykeeperCalling(project, 'propose_job_stop', { jobId: job.id });
    expect(out.result).toMatchObject({ ok: true, value: { before: { name: 'Read reviews' } } });
    const card = theCard()!;
    expect(proposalJobOf(card)).toMatchObject({ action: 'stop', jobId: job.id });
    expect(card.requestText).toBe('Stop job: Read reviews');
    await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
    await h.done();
    expect(h.log.tables.jobs.get(job.id)).toMatchObject({ state: 'stopped' });
    expect(h.log.tables.jobs.get(job.id)?.nextRunAt).toBeUndefined();
  });
});

describe('list_jobs and read_job_runs (P10-06)', () => {
  it('lists the jobs with their schedule text and reads at most 50 runs', async () => {
    const project = await longTermProject();
    const job = await existingJob(project, {
      schedule: { kind: 'weekly', days: [1, 4], at: '07:05' },
    });
    let listed: { jobs: Record<string, unknown>[] } | undefined;
    let runs: { runs: unknown[] } | undefined;
    let tooMany: ToolOutcome | undefined;
    let foreign: ToolOutcome | undefined;
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s.once('go', async (t) => {
            listed = await t.call('list_jobs', {});
            runs = await t.call('read_job_runs', { jobId: job.id, limit: 50 });
            tooMany = await t.try('read_job_runs', { jobId: job.id, limit: 0 });
            foreign = await t.try('read_job_runs', { jobId: 'j-nope' as Id });
          }),
      },
    );
    wk.tell('go');
    await h.done();
    expect(listed?.jobs).toEqual([
      {
        id: job.id,
        areaId: job.areaId,
        area: 'Feedback',
        name: 'Read reviews',
        schedule: 'Mon, Thu 7:05',
        state: 'active',
        nextRunAt: job.nextRunAt,
        lastRun: null,
        openFindings: 0,
      },
    ]);
    expect(runs).toEqual({ runs: [] });
    expect(tooMany).toMatchObject({ ok: false, error: 'invalid' });
    expect(foreign).toMatchObject({ ok: false, error: 'not_found' });
  });
});

describe('the Waykeeper prompt (P10-06)', () => {
  it('covers recurring jobs, credentials and money', () => {
    for (const line of [
      'When Cosmin asks for a recurring job, first ask what is missing',
      'Then present ONE propose_job',
      "tell Cosmin to put them in the project's environment",
      "Read a job's runs (read_job_runs) only when Cosmin asks or when you change the job",
      'Jobs never send, post or spend on their own',
      'You never spend real money yourself',
      'request_spend',
    ]) {
      expect(WAYKEEPER_SYSTEM_PROMPT).toContain(line);
    }
  });
});
