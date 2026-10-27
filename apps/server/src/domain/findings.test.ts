import { describe, expect, it } from 'vitest';
import {
  FAILURE_ACTIONS,
  FINDING_ACTIONS,
  SPEND_ACTIONS,
  applyEvent,
  applySnapshot,
  isJobOwned,
  isJobTask,
  type Actor,
  type Event,
  type EventEnvelope,
  type Id,
  type JobDraft,
  type Question,
  type Snapshot,
} from '@galactic/protocol';
import { createWakeScope } from '../brains/seed.js';
import { wakeLine } from '../brains/wake.js';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { Commands } from './commands.js';
import { DomainError } from './errors.js';
import { attachJobRunAgent, endJobRun, startJobRun } from './job-runs.js';
import { createJob, jobOf, setJobState } from './jobs.js';
import { addPermissionRule } from './project-rules.js';
import { closeProject, createProject } from './projects.js';
import { endAgentQuestions, logRouting } from './question-service.js';
import { reassignQuestion } from './questions.js';
import { createTask } from './tasks.js';

/**
 * P10-05 (plan Task 7) — findings and spend approvals. A run's findings and a job's spends are
 * job-owned questions held by the user; answering one carries out its action in the answer's own
 * transaction (a proposed ticket, a message to the Waykeeper, a queued follow-up, a retry or a
 * stop), refused with a clear message when the project closed or the job stopped meanwhile —
 * except "Drop" and "Refuse", which always work. A `spend` is the user's alone: never an agent's
 * or the system's, never part of a set, never touched by an "Allow similar" rule; a remote client
 * answers it as it answers a permission request (decision 90, Ruling R7: `remote-access.test.ts`).
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const DRAFT: JobDraft = {
  name: 'Read the feedback',
  instructions: 'Read new app reviews and summarise them.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

function setup() {
  const w = world();
  const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
  const recorded: EventEnvelope[] = [];
  w.log.subscribe((e) => recorded.push(e));
  const living = new Set<Id>();
  const routing = logRouting(w.log, (id) => living.has(id));
  const commands = new Commands({ log: w.log, questions: routing });
  const cmd = <T>(fn: Parameters<typeof w.log.runCommand<T>>[0]): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace: '/w/shop',
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    }),
  );
  const { job } = cmd((ctx) =>
    createJob(ctx, { projectId: project.id, area: { name: 'Feedback' }, draft: DRAFT, by: USER }),
  );
  const { hq, wk } = cmd((ctx) => {
    const hq = createAgent(ctx, { role: 'harmonizer', runtime: 'fake', caps: CAPS });
    const wk = createAgent(ctx, {
      role: 'waykeeper',
      runtime: 'fake',
      caps: CAPS,
      projectId: project.id,
      supervisorId: hq.id,
    });
    return { hq, wk };
  });
  living.add(hq.id);
  living.add(wk.id);
  const run = cmd((ctx) =>
    startJobRun(ctx, { jobId: job.id, purpose: 'scheduled', dueAt: '2026-10-01T09:00:00.000Z' }),
  );
  const steward = cmd((ctx) =>
    createAgent(ctx, {
      role: 'steward',
      runtime: 'fake',
      caps: CAPS,
      taskId: job.taskId,
      projectId: project.id,
      supervisorId: wk.id,
    }),
  );
  living.add(steward.id);
  cmd((ctx) => attachJobRunAgent(ctx, { runId: run.id, agentId: steward.id }));

  const suggestion = async (title = 'Add dark mode', text = 'Three reviews ask for it') =>
    (
      await commands.openFinding({
        runId: run.id,
        originAgentId: steward.id,
        kind: 'suggestion',
        title,
        text,
      })
    ).value;
  const reply = async () =>
    (
      await commands.openFinding({
        runId: run.id,
        originAgentId: steward.id,
        kind: 'reply',
        title: 'Reply to Ana',
        text: 'Ana asks when the export lands',
        draft: 'Hi Ana, soon!',
      })
    ).value;
  const jobSpend = async (amount = 20) =>
    (
      await commands.requestSpend({
        originAgentId: steward.id,
        amount,
        purpose: 'Boost the launch post',
        runId: run.id,
      })
    ).value;
  const answer = (q: Question, answer: string, extra: object = {}) =>
    commands.answerQuestion({ questionId: q.id, answer, by: USER, ...extra });
  const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
    try {
      await p;
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  const row = (id: Id) => w.tables.questions.get(id)!;
  /** The wake lines `events` give the Waykeeper and the Harmonizer. */
  const wakes = (events: Event[]) => {
    const scopes = [
      createWakeScope(w.tables, { brainId: wk.id, role: 'waykeeper', projectId: project.id }),
      createWakeScope(w.tables, { brainId: hq.id, role: 'harmonizer' }),
    ];
    return scopes.flatMap((s) =>
      events.flatMap((e) => {
        const line = wakeLine(e, s);
        return line === undefined ? [] : [{ brain: s.brainId, type: e.type, line }];
      }),
    );
  };
  /** The protocol fold of everything logged equals the server's tables. */
  const conforms = () => {
    let folded = applySnapshot(start);
    for (const env of recorded) folded = applyEvent(folded, env);
    const snap = w.log.snapshot();
    const byId = <T extends { id: Id }>(rows: T[]) =>
      Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(folded.jobs).toEqual(byId(snap.jobs ?? []));
    expect(folded.tasks).toEqual(byId(snap.tasks));
    expect(folded.questions).toEqual(byId(snap.questions));
  };
  return {
    ...w,
    commands,
    living,
    routing,
    cmd,
    project,
    job,
    hq,
    wk,
    run,
    steward,
    suggestion,
    reply,
    jobSpend,
    answer,
    refusal,
    row,
    wakes,
    conforms,
  };
}

describe('openFinding', () => {
  it('opens a job-owned question held by the user, with the finding actions', async () => {
    const s = setup();
    const out = await s.commands.openFinding({
      runId: s.run.id,
      originAgentId: s.steward.id,
      kind: 'suggestion',
      title: 'Add dark mode',
      text: 'Three reviews ask for it',
    });
    const q = out.value;
    expect(q).toMatchObject({
      kind: 'clarification',
      originAgentId: s.steward.id,
      holder: USER,
      status: 'open',
      context: {
        text: 'Three reviews ask for it',
        options: [...FINDING_ACTIONS.suggestion],
        finding: { jobId: s.job.id, runId: s.run.id, kind: 'suggestion', title: 'Add dark mode' },
      },
      meta: { jobOwned: true, toUser: true },
    });
    expect(isJobOwned(q)).toBe(true);
    expect(out.events.map((e) => e.type)).toEqual(['question.opened']);
    // It wakes no brain, though the Waykeeper supervises the run's Steward.
    expect(s.wakes(out.events)).toEqual([]);
    const r = await s.reply();
    expect(r.context.options).toEqual([...FINDING_ACTIONS.reply]);
    expect(r.context.finding).toMatchObject({ kind: 'reply', draft: 'Hi Ana, soon!' });
    s.conforms();
  });

  it('outlives its Steward', async () => {
    const s = setup();
    const q = await s.suggestion();
    s.living.delete(s.steward.id);
    s.cmd((ctx) => endAgentQuestions(ctx, s.steward.id, 'finished', s.routing));
    expect(s.row(q.id).status).toBe('open');
  });

  it('refuses another agent than the run’s Steward, a reply without a draft, a stopped job', async () => {
    const s = setup();
    const base = { runId: s.run.id, kind: 'suggestion' as const, title: 'T', text: 'x' };
    expect(
      (await s.refusal(s.commands.openFinding({ ...base, originAgentId: s.wk.id }))).code,
    ).toBe('invalid');
    expect(
      (
        await s.refusal(
          s.commands.openFinding({ ...base, originAgentId: s.steward.id, kind: 'reply' }),
        )
      ).message,
    ).toMatch(/draft/);
    expect(
      (
        await s.refusal(
          s.commands.openFinding({ ...base, originAgentId: s.steward.id, title: ' ' }),
        )
      ).code,
    ).toBe('invalid');
    s.cmd((ctx) => setJobState(ctx, { jobId: s.job.id, state: 'stopped', by: USER }));
    expect(
      (await s.refusal(s.commands.openFinding({ ...base, originAgentId: s.steward.id }))).message,
    ).toMatch(/stopped/);
    expect(s.tables.questions.all()).toEqual([]);
  });
});

describe('answering a suggestion', () => {
  it('"Create a ticket" files a proposed task on the project, in the answer’s transaction', async () => {
    const s = setup();
    const q = await s.suggestion();
    const out = await s.answer(q, 'Create a ticket');
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'task.created']);
    const task = (out.events[1] as Extract<Event, { type: 'task.created' }>).task;
    expect(task).toMatchObject({
      projectId: s.project.id,
      bodyId: s.project.bodyId,
      state: 'proposed',
      description: 'Add dark mode',
      meta: { fromFinding: q.id },
    });
    expect(isJobTask(task)).toBe(false);
    expect(s.row(q.id)).toMatchObject({ status: 'answered', answer: 'Create a ticket' });
    // Nobody is woken: the ticket waits for Cosmin (a proposed task wakes no Waykeeper).
    expect(s.wakes(out.events)).toEqual([]);
    s.conforms();
  });

  it('"Implement it" messages the project’s Waykeeper from the system, waking it exactly once', async () => {
    const s = setup();
    const q = await s.suggestion();
    const out = await s.answer(q, 'Implement it');
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'message.sent']);
    expect(out.events[1]).toMatchObject({
      type: 'message.sent',
      agentId: s.wk.id,
      sender: { type: 'system' },
      interrupt: false,
      fromFinding: q.id,
      text:
        'Cosmin wants this implemented (from Read the feedback): Add dark mode — Three reviews ' +
        'ask for it. Plan it as a task and propose it.',
    });
    const woken = s.wakes(out.events);
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({ brain: s.wk.id, type: 'message.sent' });
    s.conforms();
  });

  it('"Implement it" prefers the living Waykeeper over a newer ended row', async () => {
    const s = setup();
    const ended = s.cmd((ctx) =>
      createAgent(ctx, {
        role: 'waykeeper',
        runtime: 'fake',
        caps: CAPS,
        projectId: s.project.id,
        supervisorId: s.hq.id,
      }),
    );
    expect(s.living.has(ended.id)).toBe(false);
    const q = await s.suggestion();
    const out = await s.answer(q, 'Implement it');
    expect(out.events[1]).toMatchObject({ type: 'message.sent', agentId: s.wk.id });
    // With no living Waykeeper, the latest row gets it.
    s.living.delete(s.wk.id);
    const r = await s.suggestion('Export to CSV');
    const later = await s.answer(r, 'Implement it');
    expect(later.events[1]).toMatchObject({ type: 'message.sent', agentId: ended.id });
  });

  it('"Drop" records the answer and does nothing else', async () => {
    const s = setup();
    const q = await s.suggestion();
    const out = await s.answer(q, 'Drop');
    expect(out.events.map((e) => e.type)).toEqual(['question.answered']);
    expect(s.wakes(out.events)).toEqual([]);
  });

  it('on a closed project, "Create a ticket" and "Implement it" are refused; "Drop" still works', async () => {
    const s = setup();
    const q = await s.suggestion();
    s.cmd((ctx) => closeProject(ctx, s.project.id, USER));
    expect(jobOf(s, s.job.id).state).toBe('stopped');
    expect(s.row(q.id).status).toBe('open');
    for (const action of ['Create a ticket', 'Implement it']) {
      const e = await s.refusal(s.answer(q, action));
      expect(e.code).toBe('invalid');
      expect(e.message).toBe('the project is closed; the suggestion was not filed');
      expect(s.row(q.id).status).toBe('open');
    }
    expect(s.tables.tasks.all().filter((t) => t.state === 'proposed')).toEqual([]);
    await s.answer(q, 'Drop');
    expect(s.row(q.id)).toMatchObject({ status: 'answered', answer: 'Drop' });
  });

  it('refuses an answer that is not one of its actions', async () => {
    const s = setup();
    const q = await s.suggestion();
    const e = await s.refusal(s.answer(q, 'maybe later'));
    expect(e.code).toBe('invalid');
    expect(e.message).toMatch(/Create a ticket, Implement it, Drop/);
    expect(s.row(q.id).status).toBe('open');
  });
});

describe('answering a reply', () => {
  it('"Send" queues the edited reply on the job, not the draft', async () => {
    const s = setup();
    const q = await s.reply();
    await s.answer(q, 'Send', { detail: { choices: ['Send'], text: 'Hi, thanks…' } });
    expect(jobOf(s, s.job.id).followUps).toEqual([
      { questionId: q.id, kind: 'send', text: 'Hi, thanks…' },
    ]);
    expect(s.row(q.id).meta?.['answerDetail']).toEqual({ choices: ['Send'], text: 'Hi, thanks…' });
    s.conforms();
  });

  it('"Send" without an edit queues the draft', async () => {
    const s = setup();
    const q = await s.reply();
    const out = await s.answer(q, 'Send');
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'job.updated']);
    expect(jobOf(s, s.job.id).followUps).toEqual([
      { questionId: q.id, kind: 'send', text: 'Hi Ana, soon!' },
    ]);
    expect(s.wakes(out.events)).toEqual([]);
  });

  it('on a stopped job "Send" is refused and "Drop" still works', async () => {
    const s = setup();
    const q = await s.reply();
    s.cmd((ctx) => setJobState(ctx, { jobId: s.job.id, state: 'stopped', by: USER }));
    const e = await s.refusal(s.answer(q, 'Send'));
    expect(e.code).toBe('invalid');
    expect(e.message).toBe('the job is stopped; the reply was not sent');
    expect(s.row(q.id).status).toBe('open');
    await s.answer(q, 'Drop');
    expect(s.row(q.id).status).toBe('answered');
    expect(jobOf(s, s.job.id).followUps).toEqual([]);
  });
});

describe('answering a failure question', () => {
  function failed(s: ReturnType<typeof setup>) {
    s.cmd((ctx) => endJobRun(ctx, { runId: s.run.id, outcome: 'failed', failureReason: 'no net' }));
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('paused');
    return s.row(job.failureQuestionId!);
  }

  it('"Fixed — retry now" reactivates the job due now; the question is answered, not cancelled', async () => {
    const s = setup();
    const q = failed(s);
    expect(q.context.options).toEqual([...FAILURE_ACTIONS]);
    const out = await s.answer(q, 'Fixed — retry now');
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'job.updated']);
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('active');
    // Due now: the answer's own time.
    expect(job.nextRunAt).toBe(job.updatedAt);
    expect(job.pausedReason).toBeUndefined();
    expect(job.failureQuestionId).toBeUndefined();
    expect(job.meta?.['retryNote']).toBeUndefined();
    expect(s.row(q.id)).toMatchObject({ status: 'answered', answer: 'Fixed — retry now' });
    expect(s.wakes(out.events)).toEqual([]);
    s.conforms();
  });

  it('any other answer retries too, keeping the text as the retry note', async () => {
    const s = setup();
    const q = failed(s);
    await s.answer(q, 'I renewed the API key; try again');
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('active');
    expect(job.meta?.['retryNote']).toBe('I renewed the API key; try again');
    expect(s.row(q.id).status).toBe('answered');
    s.conforms();
  });

  it('"Stop the job" stops it', async () => {
    const s = setup();
    const q = failed(s);
    await s.answer(q, 'Stop the job');
    const job = jobOf(s, s.job.id);
    expect(job.state).toBe('stopped');
    expect(job.nextRunAt).toBeUndefined();
    expect(job.failureQuestionId).toBeUndefined();
    expect(s.row(q.id)).toMatchObject({ status: 'answered', answer: 'Stop the job' });
    s.conforms();
  });
});

describe('requestSpend', () => {
  it('a job run’s spend is job-owned, held by the user, with Approve / Refuse', async () => {
    const s = setup();
    const out = await s.commands.requestSpend({
      originAgentId: s.steward.id,
      amount: 20,
      purpose: 'Boost the launch post',
      runId: s.run.id,
    });
    const q = out.value;
    expect(q).toMatchObject({
      kind: 'spend',
      holder: USER,
      status: 'open',
      context: {
        options: [...SPEND_ACTIONS],
        spend: {
          amount: 20,
          currency: 'USD',
          purpose: 'Boost the launch post',
          jobId: s.job.id,
          runId: s.run.id,
        },
      },
      meta: { jobOwned: true, toUser: true },
    });
    expect(isJobOwned(q)).toBe(true);
    // A job spend's question.opened wakes no brain.
    expect(s.wakes(out.events)).toEqual([]);
    s.conforms();
  });

  it('a job-run Steward’s spend names its job even without the run id', async () => {
    const s = setup();
    const { value } = await s.commands.requestSpend({
      originAgentId: s.steward.id,
      amount: 5,
      currency: 'eur',
      purpose: 'A domain name',
    });
    expect(value.context.spend).toMatchObject({
      currency: 'EUR',
      jobId: s.job.id,
      runId: s.run.id,
    });
  });

  it('a task Steward’s spend is held by the user although its Waykeeper lives', async () => {
    const s = setup();
    const task = s.cmd((ctx) =>
      createTask(ctx, { projectId: s.project.id, description: 'Launch the ad' }),
    );
    const stew = s.cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: 'fake',
        caps: CAPS,
        taskId: task.id,
        supervisorId: s.wk.id,
      }),
    );
    s.living.add(stew.id);
    const out = await s.commands.requestSpend({
      originAgentId: stew.id,
      amount: 49.99,
      purpose: 'One week of ads',
    });
    expect(out.value).toMatchObject({ kind: 'spend', holder: USER });
    expect(out.value.context.spend?.jobId).toBeUndefined();
    expect(isJobOwned(out.value)).toBe(false);
    expect(s.wakes(out.events)).toEqual([]);
    // Approve or Refuse on a task spend is recorded only (the Steward hears it, P10-05 Task 9).
    const answered = await s.answer(out.value, 'Approve');
    expect(answered.events.map((e) => e.type)).toEqual(['question.answered']);
    expect(s.wakes(answered.events)).toEqual([]);
  });

  it('refuses a non-positive amount, a bad currency, a blank or long purpose, a foreign run', async () => {
    const s = setup();
    const base = { originAgentId: s.steward.id, amount: 1, purpose: 'x' };
    for (const bad of [
      { amount: 0 },
      { amount: -3 },
      { amount: Number.NaN },
      { currency: 'dollars' },
      { purpose: '  ' },
      { purpose: 'p'.repeat(501) },
      { originAgentId: s.wk.id, runId: s.run.id },
    ]) {
      expect((await s.refusal(s.commands.requestSpend({ ...base, ...bad }))).code).toBe('invalid');
    }
    expect(s.tables.questions.all()).toEqual([]);
  });
});

describe('answering a spend', () => {
  it('"Approve" on a job spend queues the follow-up; "Refuse" only records', async () => {
    const s = setup();
    const q = await s.jobSpend(20);
    const out = await s.answer(q, 'Approve');
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'job.updated']);
    expect(jobOf(s, s.job.id).followUps).toEqual([
      {
        questionId: q.id,
        kind: 'spend',
        amount: 20,
        currency: 'USD',
        purpose: 'Boost the launch post',
      },
    ]);
    expect(s.wakes(out.events)).toEqual([]);
    const other = await s.jobSpend(30);
    const refused = await s.answer(other, 'Refuse');
    expect(refused.events.map((e) => e.type)).toEqual(['question.answered']);
    expect(jobOf(s, s.job.id).followUps).toHaveLength(1);
    s.conforms();
  });

  it('on a stopped job "Approve" is refused and "Refuse" still works', async () => {
    const s = setup();
    const q = await s.jobSpend();
    s.cmd((ctx) => setJobState(ctx, { jobId: s.job.id, state: 'stopped', by: USER }));
    const e = await s.refusal(s.answer(q, 'Approve'));
    expect(e.code).toBe('invalid');
    expect(e.message).toBe('the job is stopped; the spend was not approved');
    await s.answer(q, 'Refuse');
    expect(s.row(q.id)).toMatchObject({ status: 'answered', answer: 'Refuse' });
    expect(jobOf(s, s.job.id).followUps).toEqual([]);
  });

  it('only an exact Approve / Refuse answers it: free text is refused', async () => {
    const s = setup();
    const q = await s.jobSpend();
    for (const text of ['yes', 'approve', 'Approve — go']) {
      expect((await s.refusal(s.answer(q, text))).code).toBe('invalid');
    }
    expect(s.row(q.id).status).toBe('open');
  });

  it('is never answered or held by an agent, nor answered by the system', async () => {
    const s = setup();
    const q = await s.jobSpend();
    for (const by of [
      { type: 'agent' as const, id: s.wk.id },
      { type: 'agent' as const, id: s.hq.id },
      { type: 'system' as const },
    ]) {
      const e = await s.refusal(
        s.commands.answerQuestion({ questionId: q.id, answer: 'Approve', by }),
      );
      expect(e.code).toBe('invalid');
      expect(e.message).toMatch(/spend/);
    }
    expect(() =>
      s.cmd((ctx) => reassignQuestion(ctx, q.id, { type: 'agent', id: s.wk.id }, 'relay')),
    ).toThrow(/spend/);
    await expect(s.commands.escalateQuestion(q.id, { type: 'agent', id: s.wk.id })).rejects.toThrow(
      /spend/,
    );
    expect(s.row(q.id)).toMatchObject({ status: 'open', holder: USER });
  });

  it('is never part of a question set', async () => {
    const s = setup();
    const e = await s.refusal(
      s.commands.openQuestionSet({
        originAgentId: s.steward.id,
        title: 'Ads',
        questions: [{ kind: 'spend', text: 'Spend $20?' } as never, { text: 'Which audience?' }],
      }),
    );
    expect(e.code).toBe('invalid');
    expect(s.tables.questions.all()).toEqual([]);
  });

  it('a matching "Allow similar" rule never touches it', async () => {
    const s = setup();
    s.cmd((ctx) =>
      addPermissionRule(
        ctx,
        s.project.id,
        {
          scope: 'category',
          tool: '*',
          match: { kind: 'categories' },
          categories: [
            'read_workspace',
            'edit_workspace',
            'run_workspace',
            'destructive',
            'outside_workspace',
            'network',
          ],
          label: 'anything',
          preview: [],
        } as never,
        { by: USER, origin: 'local' },
      ),
    );
    const out = await s.commands.requestSpend({
      originAgentId: s.steward.id,
      amount: 20,
      purpose: 'Boost the launch post',
      runId: s.run.id,
    });
    expect(out.events.map((e) => e.type)).toEqual(['question.opened']);
    expect(s.row(out.value.id).status).toBe('open');
    const all = s.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event.type);
    expect(all).not.toContain('permission.decided');
    // Nor can the user make one from it.
    const e = await s.refusal(
      s.commands.allowSimilar({
        questionId: out.value.id,
        by: USER,
        scope: 'category',
        digest: 'x',
        origin: 'local',
      }),
    );
    expect(e.code).toBe('invalid');
    expect(s.row(out.value.id).status).toBe('open');
  });
});
