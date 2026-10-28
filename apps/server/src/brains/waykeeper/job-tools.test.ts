import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  proposalJobOf,
  type Id,
  type JobDraft,
  type Project,
  type RequestOrigin,
} from '@galactic/protocol';
import { createAgent } from '../../domain/agents.js';
import { unattendedPermissionRules } from '../../domain/jobs.js';
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
          scope: 'exact',
          match: { kind: 'text', text: 'https://api.myapp.com/reviews' },
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
        // The card says what the rule allows in the server's words, not the Waykeeper's.
        unattendedRules: [
          { label: 'WebFetch exactly: https://api.myapp.com/reviews — only as network access' },
        ],
      },
    });
    expect(h.log.tables.jobs.all()).toHaveLength(0);
    const turnsBefore = wk.turns.length;

    const { events } = await h.commands.decideProposal(card.id, { decision: 'approve' }, USER, {
      origin: 'local',
    });
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
    // The card's moon line previewed the moon the new area took.
    expect(proposalJobOf(card)?.moonId).toBe(area!.bodyId);
    // One turn, about the decision; the job's hidden task does not wake it as new work.
    const later = wk.turns.slice(turnsBefore);
    expect(later).toHaveLength(1);
    expect(later[0]!.prompt).toContain(
      `proposal ${card.id} was approved: the recurring job "Read reviews" was created with the approval`,
    );
    expect(later[0]!.prompt).not.toContain('was added to your project');
  });

  it('an existing area named in another case is that area, on its moon', async () => {
    const project = await longTermProject();
    const job = await existingJob(project);
    const area = h.log.tables.areas.get(job.areaId)!;
    const { out } = await waykeeperCalling(project, 'propose_job', {
      area: '  feedBACK ',
      ...DRAFT,
      name: 'Read tickets',
    });
    expect(out.result).toMatchObject({ ok: true });
    expect(proposalJobOf(theCard())).toMatchObject({
      action: 'create',
      area: { areaId: area.id },
      moonId: area.bodyId,
    });
    await h.done();
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
    expect(proposalJobOf(card)).toMatchObject({
      action: 'stop',
      jobId: job.id,
      moonId: h.log.tables.areas.get(job.areaId)!.bodyId,
    });
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

describe('approving a job card from a remote client (final review I3)', () => {
  const CURL: JobDraft['unattendedRules'][number] = {
    scope: 'prefix',
    tool: 'Bash',
    match: { kind: 'words', words: ['curl', 'api.myapp.com'] },
    categories: ['network'],
  };
  const GH: JobDraft['unattendedRules'][number] = {
    scope: 'prefix',
    tool: 'Bash',
    match: { kind: 'words', words: ['gh', 'issue', 'list'] },
    categories: ['run_workspace'],
  };
  const waykeeperOf = (project: Project): Id =>
    h.log.runCommand((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: { maxWallClockMs: 1000, maxToolCalls: 10 },
        projectId: project.id,
      }),
    ).value.id;
  const createCard = async (project: Project, rules: JobDraft['unattendedRules']) =>
    (
      await h.commands.proposeJob({
        projectId: project.id,
        waykeeperId: waykeeperOf(project),
        action: 'create',
        area: { name: 'Feedback' },
        draft: { ...DRAFT, provider: 'claude', unattendedRules: rules },
      })
    ).value;
  const approve = (id: Id, origin: RequestOrigin) =>
    h.commands.decideProposal(id, { decision: 'approve' }, USER, { origin });

  it('a remote approval of a card granting unattended rules is refused (403 remote_control); the card stays', async () => {
    const project = await longTermProject();
    const card = await createCard(project, [CURL]);
    const refused = await approve(card.id, 'remote').catch((e: { code?: string }) => e);
    expect(refused).toMatchObject({ code: 'remote_control' });
    expect(String(refused)).toMatch(/on the Mac/);
    expect(h.log.tables.proposals.get(card.id)?.state).toBe('pending');
    expect(h.log.tables.jobs.all()).toHaveLength(0);
    await approve(card.id, 'local');
    expect(h.log.tables.jobs.all()[0]!.unattendedRules.map((r) => r.origin)).toEqual(['local']);
  });

  it('a card with no unattended rule, a narrowing change and a stop may be approved remotely', async () => {
    const project = await longTermProject();
    await approve((await createCard(project, [])).id, 'remote');
    const job = await existingJob(project, { name: 'Sales', unattendedRules: [CURL, GH] });
    const wk = waykeeperOf(project);
    const narrow = (
      await h.commands.proposeJob({
        projectId: project.id,
        waykeeperId: wk,
        action: 'change',
        jobId: job.id,
        changes: { unattendedRules: [GH] },
      })
    ).value;
    await approve(narrow.id, 'remote');
    const after = h.log.tables.jobs.get(job.id)!;
    expect(after.unattendedRules.map((r) => r.match)).toEqual([GH.match]);
    // The rule kept is the same rule: its id stays.
    expect(after.unattendedRules[0]!.id).toBe(job.unattendedRules[1]!.id);
    const stop = (
      await h.commands.proposeJob({
        projectId: project.id,
        waykeeperId: wk,
        action: 'stop',
        jobId: job.id,
      })
    ).value;
    await approve(stop.id, 'remote');
    expect(h.log.tables.jobs.get(job.id)?.state).toBe('stopped');
  });

  it('a remote change that adds or widens a rule is refused', async () => {
    const project = await longTermProject();
    const job = await existingJob(project, { unattendedRules: [GH] });
    const wk = waykeeperOf(project);
    const widen = (
      await h.commands.proposeJob({
        projectId: project.id,
        waykeeperId: wk,
        action: 'change',
        jobId: job.id,
        changes: { unattendedRules: [{ ...GH, categories: ['run_workspace', 'network'] }] },
      })
    ).value;
    await expect(approve(widen.id, 'remote')).rejects.toMatchObject({ code: 'remote_control' });
  });

  it('with autoApproveRemote a remote approval grants the rules, recorded as remote', async () => {
    await h.dispose();
    h = brainHarness({ compose: { autoApproveRemote: true } });
    const project = await longTermProject();
    const card = await createCard(project, [CURL]);
    await approve(card.id, 'remote');
    const [job] = h.log.tables.jobs.all();
    expect(job!.unattendedRules.map((r) => r.origin)).toEqual(['remote']);
    // The gate sees the rule with the origin of its approval (a rule granted before origins
    // were kept reads as local, as it did).
    expect(unattendedPermissionRules(job!, project.id).map((r) => r.origin)).toEqual(['remote']);
    const { origin: _o, ...legacy } = job!.unattendedRules[0]!;
    expect(
      unattendedPermissionRules({ ...job!, unattendedRules: [legacy] }, project.id)[0]!.origin,
    ).toBe('local');
  });
});
