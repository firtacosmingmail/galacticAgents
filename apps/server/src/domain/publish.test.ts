import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLISH_ACTIONS,
  applyEvent,
  applySnapshot,
  isJobOwned,
  publishFingerprint,
  type Actor,
  type EventEnvelope,
  type Id,
  type JobDraft,
  type Snapshot,
} from '@galactic/protocol';
import { brainHarness, type BrainHarness } from '../brains/testing/index.js';
import { waykeeperDefinition } from '../brains/waykeeper/index.js';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { Commands } from './commands.js';
import { DomainError } from './errors.js';
import { attachJobRunAgent, startJobRun } from './job-runs.js';
import { createJob, jobOf } from './jobs.js';
import { createProject } from './projects.js';
import { logRouting } from './question-service.js';
import { sha256 } from './publish.js';
import { createTask } from './tasks.js';

/**
 * P11-06 (plan Task 7; SPEC decision 147) — publish approvals. Any Steward asks with
 * `request_publish`: a `publish` question held by the user alone, bound to the exact content
 * (platform, account, text, the files' hashes). A task Steward asks only on a publishing step and
 * never on Gemini; a job run's Steward may ask on any provider (the follow-up's provider is checked
 * when it starts). "Approve" with an edited text stores the edited request with a new fingerprint,
 * which a job's follow-up carries. Phase 10's "Send" findings already waiting are answered the old
 * way.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const DRAFT: JobDraft = {
  name: 'Answer reviews',
  instructions: 'Read new app reviews and draft replies.',
  schedule: { kind: 'daily', at: '09:00' },
  provider: 'claude',
  unattendedRules: [],
};

const folders: string[] = [];
const harnesses: BrainHarness[] = [];
afterEach(async () => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
  for (const h of harnesses.splice(0)) await h.dispose().catch(() => {});
});

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'galactic-publish-'));
  folders.push(workspace);
  writeFileSync(join(workspace, 'post.png'), 'png bytes');
  const w = world();
  const start: Snapshot = { ...w.log.snapshot(), statuses: [] };
  const recorded: EventEnvelope[] = [];
  w.log.subscribe((e) => recorded.push(e));
  const routing = logRouting(w.log, () => true);
  const commands = new Commands({ log: w.log, questions: routing });
  const cmd = <T>(fn: Parameters<typeof w.log.runCommand<T>>[0]): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) =>
    createProject(ctx, {
      name: 'Shop',
      workspace,
      bodyId: 'b-saturn',
      longTerm: { purpose: 'Run the shop', goals: ['grow'] },
    }),
  );
  const { job } = cmd((ctx) =>
    createJob(ctx, { projectId: project.id, area: { name: 'Reviews' }, draft: DRAFT, by: USER }),
  );
  const wk = cmd((ctx) =>
    createAgent(ctx, { role: 'waykeeper', runtime: 'fake', caps: CAPS, projectId: project.id }),
  );
  const run = cmd((ctx) =>
    startJobRun(ctx, { jobId: job.id, purpose: 'scheduled', dueAt: '2026-10-01T09:00:00.000Z' }),
  );
  const runSteward = (runtime: 'fake' | 'agy' = 'fake') => {
    const steward = cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime,
        caps: CAPS,
        taskId: job.taskId,
        projectId: project.id,
        supervisorId: wk.id,
      }),
    );
    cmd((ctx) => attachJobRunAgent(ctx, { runId: run.id, agentId: steward.id }));
    return steward;
  };
  const taskSteward = (opts: { publishes?: boolean; runtime?: 'fake' | 'agy' } = {}) => {
    const task = cmd((ctx) =>
      createTask(ctx, {
        projectId: project.id,
        description: 'Post the launch',
        ...(opts.publishes ? { publishes: true } : {}),
      }),
    );
    return cmd((ctx) =>
      createAgent(ctx, {
        role: 'steward',
        runtime: opts.runtime ?? 'fake',
        caps: CAPS,
        taskId: task.id,
        supervisorId: wk.id,
      }),
    );
  };
  const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
    try {
      await p;
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  const conforms = () => {
    let folded = applySnapshot(start);
    for (const env of recorded) folded = applyEvent(folded, env);
    const byId = <T extends { id: Id }>(rows: T[]) =>
      Object.fromEntries(rows.map((r) => [r.id, r]));
    const snap = w.log.snapshot();
    expect(folded.questions).toEqual(byId(snap.questions));
    expect(folded.jobs).toEqual(byId(snap.jobs ?? []));
  };
  return {
    ...w,
    workspace,
    commands,
    cmd,
    project,
    job,
    wk,
    run,
    runSteward,
    taskSteward,
    refusal,
    conforms,
  };
}

describe('requestPublish', () => {
  it('opens a user-only publish question with the content', async () => {
    const s = setup();
    const steward = s.taskSteward({ publishes: true });
    const out = await s.commands.requestPublish({
      originAgentId: steward.id,
      platform: 'Instagram',
      account: '@myshop',
      text: 'We launched!',
      files: ['post.png'],
    });
    const q = s.tables.questions.get(out.value.questionId)!;
    expect(q).toMatchObject({
      kind: 'publish',
      status: 'open',
      holder: USER,
      originAgentId: steward.id,
      meta: { toUser: true },
    });
    expect(q.context.text).toBe('Publish to Instagram (@myshop)');
    expect(q.context.options).toEqual([...PUBLISH_ACTIONS]);
    const files = [{ path: 'post.png', sha256: sha256('png bytes') }];
    expect(q.context.publish).toEqual({
      platform: 'Instagram',
      account: '@myshop',
      text: 'We launched!',
      files,
      fingerprint: publishFingerprint(
        { platform: 'Instagram', account: '@myshop', text: 'We launched!', files },
        sha256,
      ),
      taskId: steward.taskId,
    });
    expect(isJobOwned(q)).toBe(false);
    expect(q.meta?.['jobOwned']).toBeUndefined();
    // Never an agent's: not answered by a supervisor or the system, never escalated.
    for (const by of [{ type: 'agent' as const, id: s.wk.id }, { type: 'system' as const }]) {
      const e = await s.refusal(
        s.commands.answerQuestion({ questionId: q.id, answer: 'Approve', by }),
      );
      expect(e.message).toMatch(/publish/);
    }
    await expect(s.commands.escalateQuestion(q.id, { type: 'agent', id: s.wk.id })).rejects.toThrow(
      /publish/,
    );
    // Only Approve or Refuse.
    expect(
      (await s.refusal(s.commands.answerQuestion({ questionId: q.id, answer: 'yes', by: USER })))
        .code,
    ).toBe('invalid');
    s.conforms();
  });

  it('refuses a file outside the worktree', async () => {
    const s = setup();
    const steward = s.taskSteward({ publishes: true });
    for (const path of ['../secret.txt', '/etc/hosts', 'missing.png']) {
      const e = await s.refusal(
        s.commands.requestPublish({
          originAgentId: steward.id,
          platform: 'Instagram',
          account: '@myshop',
          text: 'Hi',
          files: [path],
        }),
      );
      expect(e.message).toBe(`${path} is not in the task's folder`);
    }
    expect(s.tables.questions.all()).toEqual([]);
  });

  it('refuses a non-publishing task', async () => {
    const s = setup();
    const steward = s.taskSteward();
    const e = await s.refusal(
      s.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'X',
        account: '@myshop',
        text: 'Hi',
      }),
    );
    expect(e.message).toBe('this task is not a publishing step; ask your Waykeeper');
  });

  it('refuses a Gemini task Steward', async () => {
    const s = setup();
    const steward = s.taskSteward({ publishes: true, runtime: 'agy' });
    const e = await s.refusal(
      s.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'X',
        account: '@myshop',
        text: 'Hi',
      }),
    );
    expect(e.message).toBe('Gemini cannot publish');
  });

  it('refuses a blank platform or account, and nothing to publish', async () => {
    const s = setup();
    const steward = s.taskSteward({ publishes: true });
    const base = { originAgentId: steward.id, platform: 'X', account: '@me', text: 'Hi' };
    for (const bad of [{ platform: ' ' }, { account: '' }, { text: '  ' }]) {
      expect((await s.refusal(s.commands.requestPublish({ ...base, ...bad }))).code).toBe(
        'invalid',
      );
    }
    expect(s.tables.questions.all()).toEqual([]);
  });

  it('a Gemini job run may ask', async () => {
    const s = setup();
    const steward = s.runSteward('agy');
    const out = await s.commands.requestPublish({
      originAgentId: steward.id,
      platform: 'App Store',
      account: 'My Shop',
      text: 'Thanks for the review!',
    });
    const q = s.tables.questions.get(out.value.questionId)!;
    expect(q).toMatchObject({ kind: 'publish', holder: USER, meta: { jobOwned: true } });
    expect(q.context.publish).toMatchObject({ jobId: s.job.id, runId: s.run.id });
    expect(isJobOwned(q)).toBe(true);
  });
});

describe('answering a publish', () => {
  it('edited publish text is what the follow-up carries', async () => {
    const s = setup();
    const steward = s.runSteward();
    const { questionId } = (
      await s.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'App Store',
        account: 'My Shop',
        text: 'Thanks!',
        files: ['post.png'],
      })
    ).value;
    const out = await s.commands.answerQuestion({
      questionId,
      answer: 'Approve',
      by: USER,
      detail: { choices: ['Approve'], text: 'Edited' },
    });
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'job.updated']);
    const [followUp] = jobOf(s, s.job.id).followUps;
    const files = [{ path: 'post.png', sha256: sha256('png bytes') }];
    expect(followUp).toMatchObject({ questionId, kind: 'publish' });
    expect(followUp!.publish!.text).toBe('Edited');
    expect(followUp!.publish!.fingerprint).toBe(
      publishFingerprint(
        { platform: 'App Store', account: 'My Shop', text: 'Edited', files },
        sha256,
      ),
    );
    // The stored question carries the approved request too, and the protocol fold agrees.
    expect(s.tables.questions.get(questionId)!.context.publish).toEqual(followUp!.publish);
    s.conforms();
  });

  it('refuse queues nothing', async () => {
    const s = setup();
    const steward = s.runSteward();
    const { questionId } = (
      await s.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'App Store',
        account: 'My Shop',
        text: 'Thanks!',
      })
    ).value;
    const out = await s.commands.answerQuestion({ questionId, answer: 'Refuse', by: USER });
    expect(out.events.map((e) => e.type)).toEqual(['question.answered']);
    expect(jobOf(s, s.job.id).followUps).toEqual([]);
  });

  it('legacy Send findings still queue a send', async () => {
    const s = setup();
    const steward = s.runSteward();
    const finding = (
      await s.commands.openFinding({
        runId: s.run.id,
        originAgentId: steward.id,
        kind: 'reply',
        title: 'Reply to Ana',
        text: 'Ana asks when the export lands',
        draft: 'Hi Ana, soon!',
      })
    ).value;
    await s.commands.answerQuestion({ questionId: finding.id, answer: 'Send', by: USER });
    expect(jobOf(s, s.job.id).followUps).toEqual([
      { questionId: finding.id, kind: 'send', text: 'Hi Ana, soon!' },
    ]);
  });
});

describe('a brain and a publish (P11-06)', () => {
  it('a brain cannot answer it', async () => {
    const h = brainHarness();
    harnesses.push(h);
    const hq = await h.startHarmonizer();
    const project = (await h.commands.createProject({ name: 'Docs', workspace: '/w/docs' })).value;
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .on(/was added to your project/, () => {})
            .once('check', async (t) => {
              const q = h.log.tables.questions.all().find((x) => x.kind === 'publish')!;
              expect(q).toMatchObject({ holder: { type: 'user' } });
              const answered = await t.try('answer_question', {
                questionId: q.id,
                answer: 'Approve',
              });
              expect(answered).toMatchObject({ ok: false, error: 'invalid' });
              expect(answered.message).toMatch(/the user answers publish approvals/);
              const escalated = await t.try('escalate', { questionId: q.id });
              expect(escalated).toMatchObject({ ok: false, error: 'invalid' });
            }),
      },
    );
    const task = (
      await h.commands.createTask({ projectId: project.id, description: 'echo', publishes: true })
    ).value;
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        taskId: task.id,
        supervisorId: wk.agentId,
        prompt: 'scenario:echo',
      })
    ).value;
    const { questionId } = (
      await h.commands.requestPublish({
        originAgentId: steward.id,
        platform: 'X',
        account: '@docs',
        text: 'New docs are out',
      })
    ).value;
    await h.settle();
    wk.tell('check');
    await h.done();
    expect(h.log.tables.questions.get(questionId)?.status).toBe('open');
  });
});
