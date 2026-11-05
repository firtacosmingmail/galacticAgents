import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  launchOf,
  OFF_SCRIPT_ACTIONS,
  type AgentLaunch,
  type Event,
  type EventOfType,
  type OffScriptContext,
  type PermissionPolicy,
  type ScopeJudge,
  type ScopeJudgeInput,
  type ScopeVerdict,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { createFakeScopeJudge } from '../adapters/fake/fake-scope-judge.js';
import { SCENARIOS, type FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';
import { precedentOf, ScopeWatch, type ScopeWatchCall } from './scope-watch.js';

const CHROME = 'mcp__claude-in-chrome__computer';
const TOKEN = 'ghp_' + 'x'.repeat(36);
const USER = { type: 'user' } as const;

const LAUNCH: AgentLaunch = {
  flags: ['chrome'],
  expectedUse: 'screenshots of the settings page for the PR',
  check: 'the screenshot is attached to the PR',
  approvalId: 'q-launch',
  precedents: [],
};

// ---------------------------------------------------------------------------------------------
// The watch alone (fake timers)

describe('ScopeWatch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function call(over: Partial<ScopeWatchCall> = {}) {
    const consistent = vi.fn<(reason: string) => void>();
    const offScript = vi.fn<(context: OffScriptContext) => void>();
    const c: ScopeWatchCall = {
      agentId: 'a-1',
      flag: 'chrome',
      toolCall: { toolName: CHROME, input: { action: 'screenshot' } },
      launch: LAUNCH,
      active: () => true,
      consistent,
      offScript,
      ...over,
    };
    return { c, consistent, offScript };
  }

  it('a consistent verdict allows, with the judge reason', async () => {
    const watch = new ScopeWatch({
      judge: createFakeScopeJudge(() => ({ verdict: 'consistent', reason: 'a screenshot' })),
    });
    const { c, consistent, offScript } = call();
    await watch.handle(c);
    expect(consistent).toHaveBeenCalledWith('a screenshot');
    expect(offScript).not.toHaveBeenCalled();
  });

  it('an off_script verdict asks the user, with the flag, the approval and the reason', async () => {
    const watch = new ScopeWatch({
      judge: createFakeScopeJudge(() => ({ verdict: 'off_script', reason: 'it buys things' })),
    });
    const { c, consistent, offScript } = call({ launch: { ...LAUNCH, precedents: ['p1'] } });
    await watch.handle(c);
    expect(consistent).not.toHaveBeenCalled();
    expect(offScript).toHaveBeenCalledWith({
      flag: 'chrome',
      expectedUse: LAUNCH.expectedUse,
      precedents: ['p1'],
      judgeReason: 'it buys things',
    });
  });

  it('judge never settles → off-script after 20 s, and the judge is aborted', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const judge: ScopeJudge = {
      judge: (_input, s) => {
        signal = s;
        return new Promise<ScopeVerdict>(() => {});
      },
    };
    const watch = new ScopeWatch({ judge });
    const { c, consistent, offScript } = call();
    const done = watch.handle(c);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(offScript).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(offScript).toHaveBeenCalledWith(
      expect.objectContaining({ judgeReason: expect.stringMatching(/20 s/) }),
    );
    expect(consistent).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
    expect(watch.inFlight).toBe(0);
  });

  it('judge throws → off-script', async () => {
    const watch = new ScopeWatch({
      judge: createFakeScopeJudge(() => {
        throw new Error('model down');
      }),
    });
    const { c, offScript } = call();
    await watch.handle(c);
    expect(offScript).toHaveBeenCalledWith(
      expect.objectContaining({ judgeReason: expect.stringMatching(/model down/) }),
    );
  });

  it('no judge configured → off-script (fail closed)', async () => {
    const watch = new ScopeWatch({ judge: undefined });
    const { c, offScript } = call();
    await watch.handle(c);
    expect(offScript).toHaveBeenCalledWith(
      expect.objectContaining({ judgeReason: expect.stringMatching(/no scope judge/) }),
    );
  });

  it('judge sees redacted input', async () => {
    const seen: ScopeJudgeInput[] = [];
    const watch = new ScopeWatch({
      judge: createFakeScopeJudge((input) => {
        seen.push(input);
        return { verdict: 'consistent', reason: 'ok' };
      }),
    });
    const { c } = call({
      toolCall: {
        toolName: CHROME,
        input: { actions: [{ action: 'type', text: TOKEN }] },
      },
    });
    await watch.handle(c);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain('ghp_');
    expect(seen[0]).toMatchObject({
      flag: 'chrome',
      expectedUse: LAUNCH.expectedUse,
      precedents: [],
      toolCall: { toolName: CHROME },
    });
  });

  it('an agent that ended meanwhile gets nothing; cancel aborts the judge', async () => {
    let signal: AbortSignal | undefined;
    let settle!: (v: ScopeVerdict) => void;
    const watch = new ScopeWatch({
      judge: {
        judge: (_i, s) => {
          signal = s;
          return new Promise<ScopeVerdict>((r) => (settle = r));
        },
      },
    });
    const { c, consistent, offScript } = call();
    const done = watch.handle(c);
    expect(watch.inFlight).toBe(1);
    watch.cancel('a-1');
    expect(signal?.aborted).toBe(true);
    settle({ verdict: 'off_script', reason: 'late' });
    await done;
    expect(consistent).not.toHaveBeenCalled();
    expect(offScript).not.toHaveBeenCalled();
    expect(watch.inFlight).toBe(0);

    const inactive = call({ active: () => false });
    await new ScopeWatch({
      judge: createFakeScopeJudge(() => ({ verdict: 'off_script', reason: 'x' })),
    }).handle(inactive.c);
    expect(inactive.offScript).not.toHaveBeenCalled();
    expect(inactive.consistent).not.toHaveBeenCalled();
  });

  it('a precedent is the tool name and a one-line, redacted, capped summary', () => {
    expect(precedentOf({ toolName: CHROME, input: { action: 'screenshot' } })).toBe(
      `${CHROME} {"action":"screenshot"}`,
    );
    const long = precedentOf({
      toolName: CHROME,
      input: { text: `line one\nline two ${TOKEN} ${'y'.repeat(600)}` },
    });
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).not.toContain('\n');
    expect(long).not.toContain('ghp_');
    expect(long.startsWith(`${CHROME} `)).toBe(true);
    expect(precedentOf({ toolName: CHROME })).toBe(CHROME);
  });
});

// ---------------------------------------------------------------------------------------------
// The watch in the runtime (fake adapters, scripted judge)

const SCRIPTS: Record<string, FakeScenario> = {
  ...SCENARIOS,
  /** One Chrome call, then done. */
  chrome: {
    steps: [
      { kind: 'tool_call', toolName: CHROME, input: { action: 'screenshot' } },
      { kind: 'finish', result: 'shot' },
    ],
  },
  /** A Chrome call carrying a token. */
  'chrome-secret': {
    steps: [
      { kind: 'tool_call', toolName: CHROME, input: { text: TOKEN } },
      { kind: 'finish', result: 'typed' },
    ],
  },
  /** A plain command under an `ask` table. */
  bash: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'rm -rf dist' },
        permissionAction: 'destructive',
      },
      { kind: 'finish', result: 'cleaned' },
    ],
  },
};

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  vi.useRealTimers();
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Harmonizer → Waykeeper → a flagged Steward (a `claude-sdk` fake) on a project task. */
async function flagged(opts: {
  prompt: string;
  judge?: ScopeJudge;
  policy?: PermissionPolicy;
  launch?: AgentLaunch;
}) {
  const brains = new FakeAdapter({ speed: 0, scenarios: SCRIPTS });
  const sdk = new FakeAdapter({ speed: 0, runtime: 'claude-sdk', scenarios: SCRIPTS });
  const answers: { questionId: string; answer: string }[] = [];
  const answer = sdk.answer.bind(sdk);
  sdk.answer = async (questionId, text) => {
    answers.push({ questionId, answer: text });
    return answer(questionId, text);
  };
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [brains, sdk],
    flushMs: 10,
    ...(opts.judge ? { scopeJudge: opts.judge } : {}),
  });
  lives.push(c);
  const { commands } = c;
  const harmonizer = (
    await commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value;
  const project = (
    await commands.createProject(
      {
        name: 'Site',
        workspace: '/w/site',
        ...(opts.policy ? { permissionPolicy: opts.policy } : {}),
      },
      { origin: 'local' },
    )
  ).value;
  const waykeeper = (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      prompt: 'scenario:echo',
      projectId: project.id,
      supervisorId: harmonizer.id,
    })
  ).value;
  const task = (await commands.createTask({ description: 'shots', projectId: project.id })).value;
  const launch = opts.launch ?? LAUNCH;
  const steward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'claude-sdk',
      prompt: opts.prompt,
      taskId: task.id,
      supervisorId: waykeeper.id,
      launchFlags: launch.flags,
      launch,
    })
  ).value;
  const events = (): Event[] => c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const ofType = <T extends Event['type']>(type: T) =>
    events().filter((e): e is EventOfType<T> => e.type === type);
  const state = () => c.statuses.get(steward.id)?.state;
  const open = () => c.log.tables.questions.all().filter((q) => q.status === 'open');
  const row = () => c.log.tables.agents.get(steward.id)!;
  return { ...c, sdk, answers, waykeeper, project, steward, ofType, state, open, row };
}

const offScriptJudge = (reason = 'not a screenshot') =>
  createFakeScopeJudge(() => ({ verdict: 'off_script', reason }));

describe('scope watch in the runtime (P12-06)', () => {
  it('consistent verdict allows the call and logs permission.decided by the Waykeeper', async () => {
    const h = await flagged({
      prompt: 'scenario:chrome',
      judge: createFakeScopeJudge(() => ({ verdict: 'consistent', reason: 'a screenshot' })),
    });
    await until(() => h.state() === 'finished');
    expect(h.log.tables.questions.all()).toEqual([]);
    expect(h.ofType('question.opened')).toEqual([]);
    const decided = h.ofType('permission.decided').filter((d) => d.agentId === h.steward.id);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      decision: 'allow',
      decidedBy: { type: 'agent', id: h.waykeeper.id },
      toolCall: { toolName: CHROME },
      reason: "consistent with the Steward's approvals: a screenshot",
    });
    expect(h.answers.map((a) => a.answer)).toEqual(['allow']);
  });

  it('off_script opens a user-held permission question with offScript context', async () => {
    const h = await flagged({ prompt: 'scenario:chrome', judge: offScriptJudge() });
    await until(() => h.open().length === 1);
    const [q] = h.open();
    expect(q!.kind).toBe('permission');
    expect(q!.holder.type).toBe('user');
    expect(q!.context.offScript).toEqual({
      flag: 'chrome',
      expectedUse: LAUNCH.expectedUse,
      precedents: [],
      judgeReason: 'not a screenshot',
    });
    expect(q!.context.options).toEqual([...OFF_SCRIPT_ACTIONS]);
    expect(h.answers).toEqual([]);
    // The event and the question in one transaction, as for any asked permission.
    expect(h.ofType('agent.needs_input')).toHaveLength(1);
    await until(() => h.state() === 'waiting_for_input');
  });

  it('judge never settles → off-script question after 20 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = await flagged({
      prompt: 'scenario:chrome',
      judge: { judge: () => new Promise<ScopeVerdict>(() => {}) },
    });
    await until(() => h.ofType('agent.spawned').some((e) => e.agentId === h.steward.id));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.open()).toEqual([]);
    await vi.advanceTimersByTimeAsync(20_000);
    await until(() => h.open().length === 1);
    expect(h.open()[0]!.context.offScript?.judgeReason).toMatch(/20 s/);
    expect(h.answers).toEqual([]);
  });

  it('judge throws → off-script question', async () => {
    const h = await flagged({
      prompt: 'scenario:chrome',
      judge: createFakeScopeJudge(() => {
        throw new Error('model down');
      }),
    });
    await until(() => h.open().length === 1);
    expect(h.open()[0]!.context.offScript?.judgeReason).toMatch(/model down/);
  });

  it('no judge configured → off-script question', async () => {
    const h = await flagged({ prompt: 'scenario:chrome' });
    await until(() => h.open().length === 1);
    expect(h.open()[0]!.context.offScript).toBeDefined();
  });

  it('Approve and continue allows and records a precedent', async () => {
    const h = await flagged({ prompt: 'scenario:chrome', judge: offScriptJudge() });
    await until(() => h.open().length === 1);
    const q = h.open()[0]!;
    await h.commands.answerQuestion({ questionId: q.id, answer: 'Approve and continue', by: USER });
    await until(() => h.state() === 'finished');
    expect(h.answers.map((a) => a.answer)).toEqual(['allow']);
    const precedents = launchOf(h.row())!.precedents;
    expect(precedents).toHaveLength(1);
    expect(precedents[0]).toContain(CHROME);
    // The precedent rides in the command that records the answer.
    const all = h.log.eventsSince(0, Number.MAX_SAFE_INTEGER);
    const answered = all.find((e) => e.event.type === 'question.answered')!;
    const updated = all.find(
      (e) => e.event.type === 'agent.updated' && e.event.agentId === h.steward.id,
    )!;
    expect(updated.seq).toBe(answered.seq + 1);
    expect(h.ofType('question.answered')[0]).toMatchObject({ answer: 'Approve and continue' });
  });

  it('Stop the Steward denies and stops', async () => {
    const h = await flagged({ prompt: 'scenario:chrome', judge: offScriptJudge() });
    await until(() => h.open().length === 1);
    const q = h.open()[0]!;
    await h.commands.answerQuestion({ questionId: q.id, answer: 'Stop the Steward', by: USER });
    await until(() => h.state() === 'stopped');
    expect(h.answers).toHaveLength(1);
    expect(h.answers[0]!.answer).toMatch(/^deny/);
    expect(launchOf(h.row())!.precedents).toEqual([]);
    // The user's stop, as from the panel's stop action.
    expect(h.ofType('control.stop').find((e) => e.target.id === h.steward.id)).toMatchObject({
      by: USER,
    });
  });

  it('dismissing the off-script card denies without stopping', async () => {
    const h = await flagged({ prompt: 'scenario:chrome', judge: offScriptJudge() });
    await until(() => h.open().length === 1);
    const q = h.open()[0]!;
    await h.commands.dismissQuestion({ questionId: q.id, by: USER, origin: 'local' });
    await until(() => h.state() === 'finished');
    expect(h.answers.map((a) => a.answer)).not.toContain('allow');
    expect(h.ofType('agent.stopped').filter((e) => e.agentId === h.steward.id)).toEqual([]);
    expect(launchOf(h.row())!.precedents).toEqual([]);
  });

  it('judge sees redacted input, and so does the log', async () => {
    const seen: ScopeJudgeInput[] = [];
    const h = await flagged({
      prompt: 'scenario:chrome-secret',
      judge: createFakeScopeJudge((input) => {
        seen.push(input);
        return { verdict: 'off_script', reason: 'typing' };
      }),
    });
    await until(() => h.open().length === 1);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toContain('ghp_');
    const q = h.open()[0]!;
    await h.commands.answerQuestion({ questionId: q.id, answer: 'Approve and continue', by: USER });
    await until(() => h.state() === 'finished');
    expect(JSON.stringify(h.log.eventsSince(0, Number.MAX_SAFE_INTEGER))).not.toContain('ghp_');
    expect(JSON.stringify(h.row().meta)).not.toContain('ghp_');
  });

  it('non-flag calls of a flagged Steward still follow the policy', async () => {
    const seen: ScopeJudgeInput[] = [];
    const h = await flagged({
      prompt: 'scenario:bash',
      policy: { rules: { destructive: 'ask' } },
      judge: createFakeScopeJudge((input) => {
        seen.push(input);
        return { verdict: 'consistent', reason: 'x' };
      }),
    });
    await until(() => h.open().length === 1);
    const q = h.open()[0]!;
    expect(q.kind).toBe('permission');
    expect(q.context.offScript).toBeUndefined();
    expect(q.context.options).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('offScript question is never escalated nor answerable by an agent, and takes only its two answers', async () => {
    const h = await flagged({ prompt: 'scenario:chrome', judge: offScriptJudge() });
    await until(() => h.open().length === 1);
    const q = h.open()[0]!;
    const waykeeper = { type: 'agent', id: h.waykeeper.id } as const;
    await expect(
      h.commands.answerQuestion({
        questionId: q.id,
        answer: 'Approve and continue',
        by: waykeeper,
      }),
    ).rejects.toThrow(/user only/);
    await expect(h.commands.escalateQuestion(q.id, waykeeper)).rejects.toThrow();
    await expect(h.commands.reassignQuestion(q.id, waykeeper, 'hand over')).rejects.toThrow();
    await expect(
      h.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER }),
    ).rejects.toThrow(/Approve and continue/);
    // "Allow similar" (decision 138) is refused: the preview offers nothing, the answer is refused.
    const preview = h.commands.similarPreview(q.id, { origin: 'local' });
    expect(preview.refused).toMatch(/off-script/);
    expect(preview.options).toEqual([]);
    expect(preview.allowed).toBe(false);
    await expect(
      h.commands.allowSimilar({
        questionId: q.id,
        scope: 'exact',
        digest: 'x',
        by: USER,
        origin: 'local',
      }),
    ).rejects.toThrow();
    expect(h.answers).toEqual([]);
    expect(h.open()).toHaveLength(1);
    expect(h.open()[0]!.holder.type).toBe('user');
  });

  it('resume keeps launch flags and precedents', async () => {
    const launch = { ...LAUNCH, precedents: [`${CHROME} {"action":"scroll"}`] };
    const h = await flagged({ prompt: 'scenario:chrome', judge: offScriptJudge(), launch });
    await until(() => h.open().length === 1);
    const before = launchOf(h.row());
    const q = h.open()[0]!;
    await h.runtime.shutdown();
    expect(h.log.tables.questions.get(q.id)!.status).toBe('cancelled');
    const result = await h.runtime.recoverAgent(h.steward.id);
    expect(result.ok).toBe(true);
    expect(launchOf(h.row())).toEqual(before);
    expect(h.sdk.launchFlagsOf(h.steward.id)).toEqual(['chrome']);
  });
});
