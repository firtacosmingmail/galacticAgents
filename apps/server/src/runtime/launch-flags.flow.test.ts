import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isWaykeeperApproval,
  launchOf,
  type Event,
  type EventOfType,
  type Id,
  type ScopeJudgeInput,
} from '@galactic/protocol';
import { ClaudeSdkAdapter } from '../adapters/claude-sdk/claude-sdk-adapter.js';
import { FakeSdk } from '../adapters/claude-sdk/fake-sdk.js';
import { createFakeScopeJudge } from '../adapters/fake/fake-scope-judge.js';
import { SCENARIOS, type FakeScenario, type FakeToolResult } from '../adapters/fake/scenario.js';
import { brainHarness, type BrainHarness } from '../brains/testing/index.js';
import { harmonizerDefinition } from '../brains/testing/canned.js';
import { waykeeperDefinition } from '../brains/waykeeper/index.js';
import { gitRunner } from '../workspace/git.js';
import { ProcessSupervisor } from './supervisor.js';

/**
 * P12-10: Steward launch flags end to end — a scripted Waykeeper, the fake runtime as the
 * Steward's `claude-sdk`, and a scripted scope judge that reads the precedents:
 *
 *   1. `spawn_steward` with `launchFlags` opens a `launch` question;
 *   2. "Approve and start" wakes the Waykeeper, which spawns with `launchApprovalId` (the
 *      Claude adapter turns the flags into `extraArgs { chrome: null }`);
 *   3. a Chrome call to the local page is `consistent`: allowed, no question;
 *   4. a call to another site is `off_script`: a user-held question; "Approve and continue"
 *      allows it and stores a precedent;
 *   5. the same host again is `consistent` (the judge sees the precedent);
 *   6. a comment on another repository's PR is `off_script`; "Stop the Steward" stops it.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
  });

const NAVIGATE = 'mcp__claude-in-chrome__navigate';
const FORM = 'mcp__claude-in-chrome__form_input';
const LOCAL = 'http://localhost:5173';
const HN = 'https://news.ycombinator.com';
const OTHER_PR = 'https://github.com/someone-else/other-repo/pull/7';
const USER = { type: 'user' } as const;

const FLAGS = {
  flags: ['chrome'],
  reason: 'Screenshot the settings page for the PR',
  expectedUse: `Open ${LOCAL}, take a screenshot and attach it to this task's PR`,
  check: 'the PR has a screenshot of the settings page',
};

/** Hosts in a call's (redacted) input, nested `actions` included. */
function hostsOf(input: unknown): string[] {
  const text = JSON.stringify(input ?? {});
  return [...text.matchAll(/https?:\/\/([^/"\\:]+)/g)].map((m) => m[1]!);
}

/**
 * The scripted judge: the local page is what was approved; a host the user approved before
 * (a precedent) is consistent; anything else is off-script.
 */
function precedentAwareJudge(seen: ScopeJudgeInput[]) {
  return createFakeScopeJudge((input) => {
    seen.push(input);
    const hosts = hostsOf(input.toolCall.input);
    if (hosts.length > 0 && hosts.every((h) => h === 'localhost')) {
      return { verdict: 'consistent', reason: 'the approved local page' };
    }
    if (hosts.length > 0 && hosts.every((h) => input.precedents.some((p) => p.includes(h)))) {
      return { verdict: 'consistent', reason: 'the user approved this host before' };
    }
    return { verdict: 'off_script', reason: `not the approved page: ${hosts.join(', ')}` };
  });
}

let tmp: string;
let h: BrainHarness;
let judged: ScopeJudgeInput[];
let results: { label: string; result: FakeToolResult | 'cancelled' }[];

/** The Steward: four Chrome calls in one turn, each after the previous one's result. */
function stewardScenario(): FakeScenario {
  const call = async (
    io: Parameters<Extract<FakeScenario['steps'][number], { kind: 'script' }>['run']>[0],
    label: string,
    toolName: string,
    input: unknown,
  ) => {
    try {
      results.push({ label, result: await io.toolCall(toolName, input) });
    } catch {
      results.push({ label, result: 'cancelled' });
      throw new Error('cancelled');
    }
  };
  return {
    steps: [
      {
        kind: 'script',
        run: async (io) => {
          await call(io, 'local', NAVIGATE, { tabId: 1, url: `${LOCAL}/settings` });
          await call(io, 'hn', NAVIGATE, { tabId: 1, url: HN });
          await call(io, 'hn again', NAVIGATE, { tabId: 1, url: `${HN}/newest` });
          await call(io, 'other pr', FORM, {
            tabId: 1,
            ref: 'new_comment_field',
            value: `Looks good! ${OTHER_PR}`,
          });
        },
      },
      { kind: 'finish', result: 'done' },
    ],
  };
}

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-launch-flow-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  judged = [];
  results = [];
  const scenarios: Record<string, FakeScenario> = { ...SCENARIOS, shots: stewardScenario() };
  h = brainHarness({
    adapter: { scenarios, runtime: 'claude-sdk' },
    compose: {
      scopeJudge: precedentAwareJudge(judged),
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
  await h.dispose().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

describe('Steward launch flags end to end (P12-10)', () => {
  it('ask, approve, spawn with --chrome, judge live, approve once, precedent, stop', async () => {
    // -- a project with a git workspace, a task, the Harmonizer and a scripted Waykeeper ------
    const dir = join(tmp, 'home', 'Site');
    const project = (await h.commands.createProject({ name: 'Site', workspace: dir })).value;
    await h.composed.workspaces!.prepareProject(project.id);
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    git(dir, 'add', 'f.txt');
    git(dir, 'commit', '-q', '-m', 'base');
    const task = (
      await h.commands.createTask({ description: 'settings page', projectId: project.id })
    ).value;
    const hq = await h.startBrain(
      harmonizerDefinition(),
      { runtime: 'claude-sdk', cwd: '/w/hq' },
      { scriptOptions: { strict: false } },
    );
    const spawnResults: unknown[] = [];
    const launchQuestions = () => h.log.tables.questions.all().filter((q) => q.kind === 'launch');
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'claude-sdk', projectId: project.id, supervisorId: hq.agentId },
      {
        // Later wakes (the Steward stopped) are not scripted here.
        scriptOptions: { strict: false },
        script: (s) =>
          s
            .once('go', async (t) => {
              spawnResults.push(
                await t.call('spawn_steward', {
                  taskId: task.id,
                  instructions: 'scenario:shots\nScreenshot the settings page for the PR',
                  launchFlags: FLAGS,
                }),
              );
            })
            .once(/answered/, async (t) => {
              spawnResults.push(
                await t.call('spawn_steward', {
                  taskId: task.id,
                  launchApprovalId: launchQuestions()[0]!.id,
                }),
              );
            }),
      },
    );

    const events = (): Event[] => h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
    const openQuestions = () => h.log.tables.questions.all().filter((q) => q.status === 'open');
    const steward = () => h.queries.supervisedAgents(wk.agentId)[0]?.agent;

    // -- 1. the Waykeeper asks; a launch question opens and nothing spawns -------------------
    wk.tell('go');
    await h.until(() => launchQuestions().length === 1, { what: 'the launch question' });
    await h.settle();
    const launchQ = launchQuestions()[0]!;
    expect(spawnResults[0]).toMatchObject({ waiting: true, questionId: launchQ.id });
    expect(launchQ.holder.type).toBe('user');
    expect(launchQ.context.launch).toMatchObject({ flags: ['chrome'], taskId: task.id });
    expect(steward()).toBeUndefined();

    // -- 2. the user approves; the Waykeeper is woken and spawns the flagged Steward ---------
    await h.commands.answerQuestion({
      questionId: launchQ.id,
      answer: 'Approve and start',
      by: USER,
    });
    await h.until(() => steward() !== undefined, { what: 'the flagged Steward' });
    const s = steward()!;
    expect(s.taskId).toBe(task.id);
    expect(launchOf(s)).toMatchObject({
      flags: ['chrome'],
      expectedUse: FLAGS.expectedUse,
      check: FLAGS.check,
      approvalId: launchQ.id,
    });
    expect(h.adapter.launchFlagsOf(s.id)).toEqual(['chrome']);

    // -- 3. the local page is consistent: allowed, no question -------------------------------
    // -- 4. another site is off-script: a user-held question; approve once -------------------
    await h.until(() => openQuestions().length === 1, {
      what: 'the off-script question',
      timeoutMs: 5000,
    });
    expect(results.map((r) => r.label)).toEqual(['local']);
    expect(results[0]!.result).toMatchObject({ status: 'ran' });
    const offScript1 = openQuestions()[0]!;
    expect(offScript1).toMatchObject({
      kind: 'permission',
      originAgentId: s.id,
      holder: { type: 'user' },
    });
    expect(offScript1.context.offScript).toMatchObject({
      flag: 'chrome',
      expectedUse: FLAGS.expectedUse,
      precedents: [],
      judgeReason: expect.stringContaining('news.ycombinator.com'),
    });
    await h.commands.answerQuestion({
      questionId: offScript1.id,
      answer: 'Approve and continue',
      by: USER,
    });

    // -- 5. the same host again is consistent (the judge saw the precedent) -----------------
    // -- 6. a comment on another repository's PR is off-script; stop the Steward ------------
    await h.until(() => openQuestions().length === 1 && openQuestions()[0]!.id !== offScript1.id, {
      what: 'the second off-script question',
      timeoutMs: 5000,
    });
    expect(results.map((r) => [r.label, (r.result as FakeToolResult).status])).toEqual([
      ['local', 'ran'],
      ['hn', 'ran'],
      ['hn again', 'ran'],
    ]);
    const precedents = launchOf(h.log.tables.agents.get(s.id)!)!.precedents;
    expect(precedents).toHaveLength(1);
    expect(precedents[0]).toContain('news.ycombinator.com');
    expect(judged.map((j) => j.precedents.length)).toEqual([0, 0, 1, 1]);
    const offScript2 = openQuestions()[0]!;
    expect(offScript2.context.offScript).toMatchObject({
      precedents,
      judgeReason: expect.stringContaining('github.com'),
    });
    await h.commands.answerQuestion({
      questionId: offScript2.id,
      answer: 'Stop the Steward',
      by: USER,
    });
    await h.until(() => h.statuses.get(s.id)?.state === 'stopped', {
      what: 'the Steward stopped',
      timeoutMs: 5000,
    });
    await h.settle();
    expect(results.at(-1)).toMatchObject({ label: 'other pr' });
    expect(results.at(-1)!.result).not.toMatchObject({ status: 'ran' });
    expect(openQuestions()).toEqual([]);
    expect(h.problems()).toEqual([]);

    // -- the whole sequence is in the log, in order -------------------------------------------
    const sid = s.id;
    const story = events().flatMap((e): string[] => {
      switch (e.type) {
        case 'question.opened':
          return e.question.kind === 'launch'
            ? ['launch asked']
            : e.question.originAgentId === sid && e.question.context.offScript
              ? ['off-script asked']
              : [];
        case 'question.answered': {
          const q = h.log.tables.questions.get(e.questionId)!;
          return q.kind === 'launch' || q.context.offScript ? [`answered: ${e.answer}`] : [];
        }
        case 'question.launch_used':
          return ['launch approval used'];
        case 'agent.spawned':
          return e.agentId === sid ? ['steward spawned'] : [];
        case 'permission.decided':
          return e.agentId === sid && e.toolCall.toolName.startsWith('mcp__claude-in-chrome__')
            ? [`${e.decision} ${e.toolCall.toolName.split('__').at(-1)}`]
            : [];
        case 'agent.tool_call':
          return e.agentId === sid ? [`ran ${e.toolName.split('__').at(-1)}`] : [];
        case 'agent.updated':
          return e.agentId === sid && e.changes.meta ? ['precedent stored'] : [];
        case 'control.stop':
          return e.target.id === sid ? [`stop by ${e.by.type}`] : [];
        case 'agent.stopped':
          return e.agentId === sid ? ['steward stopped'] : [];
        default:
          return [];
      }
    });
    expect(story).toEqual([
      'launch asked',
      'answered: Approve and start',
      'launch approval used',
      'steward spawned',
      'allow navigate', // 3. the local page: consistent, the Waykeeper's judge allows
      'ran navigate',
      'off-script asked', // 4. news.ycombinator.com: held, the user decides
      'answered: Approve and continue', // the user's answer is the decision (no permission.decided)
      'precedent stored',
      'ran navigate', // the held call runs only now
      'allow navigate', // 5. the same host: consistent through the precedent
      'ran navigate',
      'off-script asked', // 6. a comment on another repository's PR
      'answered: Stop the Steward',
      'stop by user',
      'steward stopped',
    ]);
    // A scope-watch allow is not a Waykeeper approval (final review M2): no "Approved by" line
    // in the Steward's transcript, no marker on the decision.
    h.composed.transcripts.flush();
    expect(h.composed.transcripts.read(sid).filter((c) => c.text.includes('Approved by'))).toEqual(
      [],
    );
    const allows = events().filter(
      (e): e is EventOfType<'permission.decided'> =>
        e.type === 'permission.decided' && e.agentId === sid && e.decision === 'allow',
    );
    expect(allows).toHaveLength(2);
    expect(allows.every((e) => e.decidedBy.type === 'agent')).toBe(true);
    expect(allows.every((e) => !isWaykeeperApproval(e))).toBe(true);
  }, 20_000);

  it('the Claude adapter launches the approved flags as extraArgs { chrome: null }', async () => {
    // The flow above runs the Steward on the fake runtime; this is the same spawn through the
    // Claude adapter (scripted SDK, no child), with the flags the runtime passed.
    const sdk = new FakeSdk({ script: () => [{ text: 'ok' }], spawnChild: false });
    const supervisor = new ProcessSupervisor({ defaults: { graceMs: 200, termMs: 100 } });
    const adapter = new ClaudeSdkAdapter({ supervisor, sdk, graceMs: 200, streamEndGraceMs: 50 });
    try {
      await adapter.spawn({
        agentId: 'a-1' as Id,
        role: 'steward',
        cwd: tmp,
        prompt: 'x',
        gate: { check: () => ({ decision: 'allow' }) },
        caps: { maxWallClockMs: 10_000, maxToolCalls: 10 },
        launchFlags: ['chrome'],
      });
      expect(sdk.calls[0]!.options.extraArgs).toEqual({ chrome: null });
    } finally {
      await adapter.dispose();
      await supervisor.dispose();
    }
  });
});
