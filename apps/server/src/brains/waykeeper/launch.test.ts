import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { launchOf, type Id } from '@galactic/protocol';
import { SCENARIOS, type FakeScenario } from '../../adapters/fake/scenario.js';
import { gitRunner } from '../../workspace/git.js';
import { brainHarness, type BrainHarness, type BrainScript } from '../testing/index.js';
import { harmonizerDefinition } from '../testing/canned.js';
import { waykeeperDefinition } from './index.js';

/** P12-08: the Waykeeper asks for, starts and checks Stewards with launch flags. */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });

const FLAGS = {
  flags: ['chrome'],
  reason: 'Screenshot the page',
  expectedUse: 'Open http://localhost:5173 and attach a screenshot to the PR',
  check: 'the PR has a screenshot of the page',
};
const APPROVE = 'Approve and start';

let tmp: string;
let h: BrainHarness;
let scenarios: Record<string, FakeScenario>;
let release: () => void;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-launch-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  scenarios = { ...SCENARIOS };
  const gate = new Promise<void>((r) => (release = r));
  scenarios['hold'] = {
    steps: [
      { kind: 'script', run: () => gate },
      { kind: 'finish', result: 'done' },
    ],
  };
  h = brainHarness({
    // The fake adapter stands in for claude-sdk: the only runtime that carries `chrome`.
    adapter: { scenarios, runtime: 'claude-sdk' },
    compose: {
      workspaces: {
        projectsRoot: join(tmp, 'projects'),
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
    },
  });
});
afterEach(async () => {
  release?.();
  await h.dispose().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

async function setup(script: (s: BrainScript, ids: { a: Id; b: Id }) => void) {
  const dir = join(tmp, 'home', 'Shop');
  const project = (await h.commands.createProject({ name: 'Shop', workspace: dir })).value;
  await h.composed.workspaces!.prepareProject(project.id);
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  git(dir, 'add', 'f.txt');
  git(dir, 'commit', '-q', '-m', 'base');
  const mk = async (description: string) =>
    (await h.commands.createTask({ description, projectId: project.id })).value;
  const a = await mk('page a');
  const b = await mk('page b');
  const hq = await h.startBrain(
    harmonizerDefinition(),
    { runtime: 'claude-sdk', cwd: '/w/hq' },
    { scriptOptions: { strict: false } },
  );
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'claude-sdk', projectId: project.id, supervisorId: hq.agentId },
    { script: (s) => script(s, { a: a.id, b: b.id }) },
  );
  return { wk, a: a.id, b: b.id };
}

const launchQuestions = () => h.log.tables.questions.all().filter((q) => q.kind === 'launch');
const answerLaunch = (answer: string) =>
  h.commands.answerQuestion({
    questionId: launchQuestions()[0]!.id,
    answer,
    by: { type: 'user' },
  });

describe('spawn_steward with launch flags (P12-08)', () => {
  it('launchFlags opens a launch question, spawns nothing, returns waiting', async () => {
    let out: unknown;
    const { wk } = await setup((s, ids) =>
      s.once('go', async (t) => {
        out = await t.call('spawn_steward', {
          taskId: ids.a,
          instructions: 'Fix page a',
          launchFlags: FLAGS,
        });
      }),
    );
    wk.tell('go');
    await h.done();
    expect(out).toMatchObject({ waiting: true, questionId: launchQuestions()[0]!.id });
    expect(launchQuestions()).toHaveLength(1);
    expect(launchQuestions()[0]!.context.launch).toMatchObject({
      taskId: expect.any(String),
      instructions: 'Fix page a',
      flags: ['chrome'],
    });
    expect(h.queries.supervisedAgents(wk.agentId)).toEqual([]);
  });

  it('refuses unknown flags with the allowed names, and both fields together', async () => {
    const results: unknown[] = [];
    const { wk } = await setup((s, ids) =>
      s.once('go', async (t) => {
        results.push(
          await t.try('spawn_steward', {
            taskId: ids.a,
            instructions: 'x',
            launchFlags: { ...FLAGS, flags: ['dangerously-skip-permissions'] },
          }),
          await t.try('spawn_steward', {
            taskId: ids.a,
            instructions: 'x',
            launchFlags: FLAGS,
            launchApprovalId: 'q-1',
          }),
        );
      }),
    );
    wk.tell('go');
    await h.done();
    expect(results[0]).toMatchObject({
      ok: false,
      error: 'invalid',
      message: expect.stringMatching(/chrome/),
    });
    expect(results[1]).toMatchObject({ ok: false, error: 'invalid' });
    expect(launchQuestions()).toHaveLength(0);
  });

  it('launchApprovalId after approval spawns with the flags, the approved instructions, once', async () => {
    const reuse: unknown[] = [];
    const { wk, a } = await setup((s, ids) =>
      s
        .once('go', async (t) => {
          await t.call('spawn_steward', {
            taskId: ids.a,
            instructions: 'scenario:hold\nFix page a',
            launchFlags: FLAGS,
          });
        })
        .once(/was answered|answered/, async (t) => {
          const qid = launchQuestions()[0]!.id;
          await t.call('spawn_steward', {
            taskId: ids.a,
            instructions: 'ignored',
            launchApprovalId: qid,
          });
          release();
        })
        .on(/finished/, async (t) => {
          reuse.push(
            await t.try('spawn_steward', {
              taskId: ids.a,
              launchApprovalId: launchQuestions()[0]!.id,
            }),
          );
        }),
    );
    wk.tell('go');
    await h.until(() => launchQuestions().length > 0);
    await h.settle();
    await answerLaunch(APPROVE);
    await h.done();
    const steward = h.queries.supervisedAgents(wk.agentId)[0]!.agent;
    expect(steward.taskId).toBe(a);
    expect(launchOf(steward)).toMatchObject({
      flags: ['chrome'],
      expectedUse: FLAGS.expectedUse,
      check: FLAGS.check,
      approvalId: launchQuestions()[0]!.id,
      precedents: [],
    });
    expect(h.log.tables.tasks.get(a)!.meta?.['stewardInstructions']).toBe(
      'scenario:hold\nFix page a',
    );
    expect(reuse[0]).toMatchObject({ ok: false });
  });

  it('a provider that cannot carry the flags, chosen after the approval, is refused and keeps the approval', async () => {
    let started: unknown;
    const { wk } = await setup((s, ids) =>
      s
        .once('go', async (t) => {
          await t.call('spawn_steward', {
            taskId: ids.a,
            instructions: 'scenario:hold',
            launchFlags: FLAGS,
          });
        })
        .once(/answered/, async (t) => {
          started = await t.try('spawn_steward', {
            taskId: ids.a,
            launchApprovalId: launchQuestions()[0]!.id,
          });
        }),
    );
    wk.tell('go');
    await h.until(() => launchQuestions().length === 1);
    await h.settle();
    // The project moves to ChatGPT (codex) between the approval and its use.
    const project = h.log.tables.projects.all().find((p) => p.name === 'Shop')!;
    await h.commands.setProjectProvider({
      projectId: project.id,
      provider: 'chatgpt',
      by: { type: 'user' },
    });
    await answerLaunch(APPROVE);
    await h.settle();
    expect(started).toMatchObject({ ok: false, message: expect.stringMatching(/chrome/) });
    expect(h.log.tables.questions.get(launchQuestions()[0]!.id)!.meta?.['launchUsed']).not.toBe(
      true,
    );
    expect(h.log.tables.agents.all().filter((a) => a.role === 'steward')).toEqual([]);
  });

  it('a second chrome Steward while one is live is a conflict and keeps the approval', async () => {
    let second: unknown;
    const { wk } = await setup((s, ids) =>
      s
        .once('go a', async (t) => {
          await t.call('spawn_steward', {
            taskId: ids.a,
            instructions: 'scenario:hold',
            launchFlags: FLAGS,
          });
        })
        .once('go b', async (t) => {
          await t.call('spawn_steward', {
            taskId: ids.b,
            instructions: 'scenario:hold',
            launchFlags: FLAGS,
          });
        })
        .once(/question \S+ .*answered|answered/, async (t) => {
          const q = launchQuestions().find((x) => x.context.launch?.taskId === ids.a)!;
          await t.call('spawn_steward', { taskId: ids.a, launchApprovalId: q.id });
        })
        .once(/b-approved/, async (t) => {
          second = await t.try('spawn_steward', {
            taskId: ids.b,
            launchApprovalId: launchQuestions()[1]!.id,
          });
        }),
    );
    wk.tell('go a');
    await h.until(() => launchQuestions().length === 1);
    await h.settle();
    await answerLaunch(APPROVE);
    await h.settle();
    wk.tell('go b');
    await h.until(() => launchQuestions().length === 2);
    await h.settle();
    const qB = launchQuestions()[1]!;
    await h.commands.answerQuestion({ questionId: qB.id, answer: APPROVE, by: { type: 'user' } });
    wk.tell('b-approved');
    await h.settle();
    expect(second).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringMatching(/Chrome/),
    });
    expect(h.log.tables.questions.get(qB.id)!.meta?.['launchUsed']).not.toBe(true);
  });

  it("a live chrome Steward of another project's Waykeeper is a conflict too (one browser)", async () => {
    let started: unknown;
    const { wk, a } = await setup((s, ids) =>
      s
        .once('go', async (t) => {
          await t.call('spawn_steward', {
            taskId: ids.a,
            instructions: 'scenario:hold',
            launchFlags: FLAGS,
          });
        })
        .once(/answered/, async (t) => {
          started = await t.try('spawn_steward', {
            taskId: ids.a,
            launchApprovalId: launchQuestions()[0]!.id,
          });
        }),
    );
    // Another project, its own Waykeeper and a live chrome Steward on one of its tasks.
    const other = (
      await h.commands.createProject({ name: 'Blog', workspace: join(tmp, 'home', 'Blog') })
    ).value;
    const otherWk = (
      await h.commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'claude-sdk',
        prompt: 'scenario:hold',
        projectId: other.id,
        supervisorId: h.log.tables.agents.get(wk.agentId)!.supervisorId!,
      })
    ).value;
    const otherTask = (await h.commands.createTask({ description: 'blog', projectId: other.id }))
      .value;
    const busy = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'claude-sdk',
        prompt: 'scenario:hold',
        taskId: otherTask.id,
        supervisorId: otherWk.id,
        launchFlags: ['chrome'],
        launch: {
          flags: ['chrome'],
          expectedUse: 'x',
          check: 'y',
          approvalId: 'q-elsewhere',
          precedents: [],
        },
      })
    ).value;
    wk.tell('go');
    await h.until(() => launchQuestions().length === 1);
    await h.settle();
    await answerLaunch(APPROVE);
    await h.settle();
    expect(started).toMatchObject({
      ok: false,
      error: 'conflict',
      message: expect.stringContaining(busy.id),
    });
    expect(h.queries.supervisedAgents(wk.agentId).filter((x) => x.agent.taskId === a)).toEqual([]);
    expect(h.log.tables.questions.get(launchQuestions()[0]!.id)!.meta?.['launchUsed']).not.toBe(
      true,
    );
  });
});
