import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  PERMISSION_POLICY_PRESETS,
  type Event,
  type EventOfType,
  type PermissionPolicy,
  type SpawnHandle,
  type SpawnOptions,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { SCENARIOS, type FakeScenario } from '../adapters/fake/scenario.js';
import { createWakeScope } from '../brains/seed.js';
import { WAKE_RULES, wakeLine } from '../brains/wake.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * Permission routing (P2-04): a permission request is decided by the agent's gate — the project's
 * current table, the one place a permission is decided — before any question exists. `allow` and
 * `deny` are answered by the system and logged as `permission.decided`; only `ask` opens a
 * question, held by the user, which no brain's mailbox ever receives.
 */

/**
 * The fake adapter as an adapter that never consults the gate itself would behave (a PTY or ACP
 * runtime that asks the server about every tool call): every call becomes a permission request.
 * The runtime's own gate still decides.
 */
class UngatedFake extends FakeAdapter {
  override spawn(opts: SpawnOptions): Promise<SpawnHandle> {
    return super.spawn({
      ...opts,
      gate: { check: () => ({ decision: 'ask', reasons: ['the runtime asks for every call'] }) },
    });
  }
}

const SCRIPTS: Record<string, FakeScenario> = {
  ...SCENARIOS,
  /** Two destructive calls: the policy can change between them. */
  twice: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'rm -rf a' },
        permissionAction: 'destructive',
      },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'rm -rf b' },
        permissionAction: 'destructive',
      },
      { kind: 'finish', result: 'cleaned' },
    ],
  },
  /** What a trusted project's Steward does on the dev machine (P2-22), then two pushes. */
  trusted: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'python -c "print(1)"' },
        permissionAction: 'run_workspace',
      },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'pip install requests' },
        permissionAction: 'network',
      },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'python3 -m venv /tmp/venv && /tmp/venv/bin/python -c "import x"' },
        permissionAction: 'outside_workspace',
      },
      {
        kind: 'permission',
        toolName: 'WebSearch',
        input: { query: 'pyarrow csv' },
        permissionAction: 'network',
      },
      {
        kind: 'permission',
        toolName: 'mcp__mine__lookup',
        input: { q: 'x' },
        permissionAction: 'network',
      },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'git push origin main' },
        permissionAction: 'push',
      },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'sh -c "git push origin main"' },
        permissionAction: 'push',
      },
      { kind: 'finish', result: 'shipped' },
    ],
  },
  /** A write in the workspace, then one into the project's deliverables folder (P9-06). */
  'deliverables-write': {
    steps: [
      {
        kind: 'permission',
        toolName: 'Write',
        input: { file_path: '/w/csv/src/a.ts', content: 'x' },
        permissionAction: 'edit_workspace',
      },
      {
        kind: 'permission',
        toolName: 'Write',
        input: { file_path: '/w/csv/deliverables/report.md', content: 'x' },
        permissionAction: 'edit_workspace',
      },
      { kind: 'finish', result: 'written' },
    ],
  },
};

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Harmonizer → Waykeeper → Steward on a task of a project with `policy`. */
async function hierarchy(opts: { policy?: PermissionPolicy; ungated?: boolean; prompt: string }) {
  const adapter = opts.ungated
    ? new UngatedFake({ speed: 0, scenarios: SCRIPTS })
    : new FakeAdapter({ speed: 0, scenarios: SCRIPTS });
  const c = composeRuntime(openDatabase(':memory:'), { adapters: [adapter], flushMs: 10 });
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
  const project = // The user's own choice on this machine (a remote one is floored, P2-21).
    (
      await commands.createProject(
        {
          name: 'CSV',
          workspace: '/w/csv',
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
  const task = (await commands.createTask({ description: 'clean', projectId: project.id })).value;
  const steward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: opts.prompt,
      taskId: task.id,
      supervisorId: waykeeper.id,
    })
  ).value;
  const events = (): Event[] => c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const ofType = <T extends Event['type']>(type: T) =>
    events().filter((e): e is EventOfType<T> => e.type === type);
  const state = () => c.statuses.get(steward.id)?.state;
  return { ...c, harmonizer, waykeeper, project, task, steward, events, ofType, state };
}

const SYSTEM = { type: 'system' };

describe('permission routing (P2-04)', () => {
  it("a Steward's own write into the project's deliverables folder asks (P9-06, decision 22)", async () => {
    const h = await hierarchy({ prompt: 'scenario:deliverables-write' });
    await until(() => h.ofType('question.opened').length > 0);
    const opened = h.ofType('question.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.question).toMatchObject({ kind: 'permission' });
    expect(JSON.stringify(opened[0]!.question)).toContain('/w/csv/deliverables/report.md');
    expect(JSON.stringify(opened[0]!.question)).not.toContain('/w/csv/src/a.ts');
    // The write in the workspace before it was allowed by the gate alone.
    const calls = h.ofType('agent.tool_call').filter((e) => e.agentId === h.steward.id);
    expect(calls.map((e) => (e.input as { file_path?: string }).file_path)).toContain(
      '/w/csv/src/a.ts',
    );
  });

  it('an allowed action never creates a question: the system answers and logs it', async () => {
    const h = await hierarchy({
      ungated: true,
      prompt: 'scenario:permission',
      policy: { rules: { destructive: 'allow' } },
    });
    await until(() => h.state() === 'finished');
    expect(h.log.tables.questions.all()).toEqual([]);
    expect(h.ofType('question.opened')).toEqual([]);
    expect(h.ofType('agent.needs_input')).toEqual([]);
    const decided = h.ofType('permission.decided');
    const rm = decided.find((d) => JSON.stringify(d.toolCall).includes('rm -rf dist'));
    expect(rm).toMatchObject({
      agentId: h.steward.id,
      questionId: expect.any(String),
      decision: 'allow',
      action: 'destructive',
      decidedBy: SYSTEM,
    });
    // The call ran: the adapter got "allow" and reported it.
    const calls = h.ofType('agent.tool_call').filter((e) => e.agentId === h.steward.id);
    expect(calls.map((e) => JSON.stringify(e.input))).toContain(
      JSON.stringify({ command: 'rm -rf dist' }),
    );
  });

  it('an action the gate allows by itself never even reaches the question path', async () => {
    const h = await hierarchy({
      prompt: 'scenario:permission',
      policy: { rules: { destructive: 'allow' } },
    });
    await until(() => h.state() === 'finished');
    expect(h.log.tables.questions.all()).toEqual([]);
    expect(h.ofType('agent.needs_input')).toEqual([]);
  });

  it('a denied action is refused at once, logged, and never creates a question', async () => {
    for (const ungated of [true, false]) {
      const h = await hierarchy({
        ungated,
        prompt: 'scenario:permission',
        policy: { rules: { destructive: 'deny' } },
      });
      await until(() => h.state() === 'finished');
      expect(h.log.tables.questions.all()).toEqual([]);
      const [denied] = h.ofType('permission.decided');
      expect(denied).toMatchObject({
        agentId: h.steward.id,
        toolCall: { toolName: 'Bash', input: { command: 'rm -rf dist' } },
        decision: 'deny',
        action: 'destructive',
        reason: expect.any(String),
        decidedBy: SYSTEM,
      });
      // The adapter's own request (ungated) is named; the gate's refusal in the hook has none.
      expect(denied?.questionId !== undefined).toBe(ungated);
      const ran = h
        .ofType('agent.tool_call')
        .some((e) => JSON.stringify(e.input).includes('rm -rf dist'));
      expect(ran).toBe(false);
    }
  });

  it('an asked action opens a user-held permission question that no brain mailbox receives', async () => {
    for (const ungated of [true, false]) {
      const h = await hierarchy({ ungated, prompt: 'scenario:permission' }); // default: destructive asks
      await until(() => h.log.tables.questions.all().length === 1);
      const [q] = h.log.tables.questions.all();
      expect(q).toMatchObject({
        kind: 'permission',
        holder: { type: 'user' },
        status: 'open',
        originAgentId: h.steward.id,
        context: { permissionAction: 'destructive', toolCall: { toolName: 'Bash' } },
      });
      expect(h.ofType('permission.decided')).toEqual([]);

      // The user answers; the Steward runs the call and finishes.
      await h.commands.answerQuestion({ questionId: q!.id, answer: 'allow', by: { type: 'user' } });
      await until(() => h.state() === 'finished');

      // Neither supervisor's mailbox gets a line for any event of the permission's life.
      for (const brain of [h.waykeeper, h.harmonizer]) {
        const scope = createWakeScope(h.log.tables, {
          brainId: brain.id,
          role: brain.role,
          ...(brain.projectId ? { projectId: brain.projectId } : {}),
        });
        const lines = h
          .events()
          .filter((e) => e.type.startsWith('question.') || e.type === 'permission.decided')
          .map((e) => wakeLine(e, scope));
        expect(
          lines.filter((l) => l !== undefined),
          brain.role,
        ).toEqual([]);
      }
    }
  });

  it('permission.decided has no wake rule: a system decision never enters a mailbox', () => {
    expect(EVENT_TYPES).toContain('permission.decided');
    expect(WAKE_RULES['permission.decided']).toBeUndefined();
  });

  it('a policy change is not re-evaluated against an open question, and applies to the next call', async () => {
    const h = await hierarchy({ prompt: 'scenario:twice' });
    await until(() => h.log.tables.questions.all().length === 1);
    const [first] = h.log.tables.questions.all();

    await h.commands.updateProject(
      h.project.id,
      { permissionPolicy: { rules: { destructive: 'allow' } } },
      { origin: 'local' },
    );
    // The open card stays with the user: a loosened table never approves it silently.
    expect(h.log.tables.questions.get(first!.id)).toMatchObject({
      status: 'open',
      holder: { type: 'user' },
    });

    await h.commands.answerQuestion({
      questionId: first!.id,
      answer: 'allow',
      by: { type: 'user' },
    });
    await until(() => h.state() === 'finished');
    // The second `rm` ran under the new table, without a question.
    expect(h.log.tables.questions.all()).toHaveLength(1);
    const calls = h.ofType('agent.tool_call').map((e) => JSON.stringify(e.input));
    expect(calls).toContain(JSON.stringify({ command: 'rm -rf a' }));
    expect(calls).toContain(JSON.stringify({ command: 'rm -rf b' }));
  });

  it('an agent outside any project keeps the policy it was spawned with', async () => {
    const c = composeRuntime(openDatabase(':memory:'), {
      adapters: [new UngatedFake({ speed: 0 })],
      flushMs: 10,
    });
    lives.push(c);
    const result = await c.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:permission',
      cwd: '/scratch',
      permissionPolicy: { rules: { destructive: 'allow' } },
    });
    expect(result.ok).toBe(true);
    const id = result.ok ? result.agent.id : '';
    await until(() => c.statuses.get(id)?.state === 'finished');
    expect(c.log.tables.questions.all()).toEqual([]);
  });

  it('logs the tool input redacted', async () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const scripts: Record<string, FakeScenario> = {
      leaky: {
        steps: [
          {
            kind: 'permission',
            toolName: 'Bash',
            input: { command: `rm -rf dist && echo ${secret}` },
            permissionAction: 'destructive',
          },
          { kind: 'finish' },
        ],
      },
    };
    const c = composeRuntime(openDatabase(':memory:'), {
      adapters: [new UngatedFake({ speed: 0, scenarios: scripts })],
      flushMs: 10,
    });
    lives.push(c);
    const result = await c.runtime.spawn({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:leaky',
      cwd: '/scratch',
      permissionPolicy: { rules: { destructive: 'deny' } },
    });
    const id = result.ok ? result.agent.id : '';
    await until(() => c.statuses.get(id)?.state === 'finished');
    const logged = JSON.stringify(c.log.eventsSince(0, Number.MAX_SAFE_INTEGER));
    expect(logged).toContain('permission.decided');
    expect(logged).not.toContain(secret);
  });

  it('a trusted project: opaque commands, installs and unknown tools run with no question; a push asks the user (P2-22)', async () => {
    for (const ungated of [true, false]) {
      const h = await hierarchy({
        ungated,
        prompt: 'scenario:trusted',
        policy: PERMISSION_POLICY_PRESETS.trusted,
      });
      await until(() => h.log.tables.questions.all().length === 1);
      const [push] = h.log.tables.questions.all();
      expect(push).toMatchObject({
        kind: 'permission',
        holder: { type: 'user' },
        originAgentId: h.steward.id,
        context: {
          permissionAction: 'push',
          toolCall: { input: { command: 'git push origin main' } },
        },
      });
      // Everything before the push ran without a card.
      const ran = () =>
        h
          .ofType('agent.tool_call')
          .filter((e) => e.agentId === h.steward.id)
          .map((e) => JSON.stringify(e.input));
      for (const input of [
        { command: 'python -c "print(1)"' },
        { command: 'pip install requests' },
        { query: 'pyarrow csv' },
        { q: 'x' },
      ]) {
        expect(ran(), JSON.stringify(input)).toContain(JSON.stringify(input));
      }
      await h.commands.answerQuestion({
        questionId: push!.id,
        answer: 'allow',
        by: { type: 'user' },
      });
      // The push hidden in `sh -c` asks too.
      await until(() => h.log.tables.questions.all().length === 2);
      const hidden = h.log.tables.questions.all().find((q) => q.id !== push!.id);
      expect(hidden).toMatchObject({
        kind: 'permission',
        holder: { type: 'user' },
        context: { permissionAction: 'push' },
      });
      await h.commands.answerQuestion({
        questionId: hidden!.id,
        answer: 'allow',
        by: { type: 'user' },
      });
      await until(() => h.state() === 'finished');
    }
  });
});
