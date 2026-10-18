import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, GateCheckOptions, GateVerdict, ToolCall } from '@galactic/protocol';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import {
  ACP_PASS_ENV,
  AcpAdapter,
  CLIENT_CAPABILITIES,
  ISOLATED_SESSION_META,
  sessionMetaFor,
} from './acp-adapter.js';
import { FAKE_ACP_AGENT } from './fake-agent.js';

/**
 * The ACP adapter on its own (P8-07), against the fake ACP agent: what the conformance suite does
 * not pin — the capability set, block joining, the gate on calls the agent did not ask about,
 * typed form fields, error and refusal turns, a crash, cost, resume without `loadSession`, the
 * replay a load sends, and the spawns it refuses.
 */

const cwd = mkdtempSync(join(tmpdir(), 'galactic-acp-unit-'));
writeFileSync(join(cwd, 'README.md'), '# unit\n');
const state = mkdtempSync(join(tmpdir(), 'galactic-acp-unit-state-'));
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 100 };

type Verdict = (call: ToolCall) => GateVerdict;

interface Rig {
  adapter: AcpAdapter;
  supervisor: ProcessSupervisor;
  events: AgentEvent[];
  checks: ToolCall[];
  /** Whether each check reserved the call against the cap. */
  reserves: boolean[];
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.adapter.dispose();
    await r.supervisor.dispose();
  }
});

function rig(
  extraArgs: string[] = [],
  agent: Partial<ConstructorParameters<typeof AcpAdapter>[0]['agent']> = {},
): Rig {
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  const adapter = new AcpAdapter({
    supervisor,
    agent: {
      command: process.execPath,
      args: [FAKE_ACP_AGENT, '--state', state, ...extraArgs],
      ...agent,
    },
    graceMs: 2_000,
    startTimeoutMs: 10_000,
  });
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of adapter.events) events.push(e);
  })();
  const r = { adapter, supervisor, events, checks: [], reserves: [] };
  rigs.push(r);
  return r;
}

const allowAll: Verdict = () => ({ decision: 'allow' });

function spawnOpts(
  r: Rig,
  prompt: string,
  verdict: Verdict = allowAll,
  agentId = `a-${Math.random()}`,
) {
  return {
    agentId,
    role: 'steward' as const,
    cwd,
    prompt,
    caps: CAPS,
    gate: {
      check: (call: ToolCall, opts?: GateCheckOptions) => {
        r.checks.push(call);
        r.reserves.push(opts?.reserve ?? true);
        return verdict(call);
      },
    },
  };
}

const waitFor = (pred: () => boolean, what: string, ms = 8_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) resolve();
      else if (Date.now() - t0 > ms) reject(new Error(`timed out waiting for ${what}`));
      else setTimeout(tick, 10);
    };
    tick();
  });

const of = <T extends AgentEvent['type']>(r: Rig, type: T) =>
  r.events.filter((e) => e.type === type) as Extract<AgentEvent, { type: T }>[];
const texts = (r: Rig) => of(r, 'agent.output').map((e) => e.text);
const idles = (r: Rig) => of(r, 'agent.idle').length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AcpAdapter', () => {
  it('advertises form elicitation only: no fs/*, no terminal/*', () => {
    expect(CLIENT_CAPABILITIES).toEqual({ elicitation: { form: {} } });
  });

  it('the fake agent refuses a client that advertises fs or terminal methods', async () => {
    const child = spawn(process.execPath, [FAKE_ACP_AGENT, '--state', state], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const conn = acp
      .client({ name: 'test' })
      .connect(
        acp.ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ),
      );
    try {
      await expect(
        conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true }, terminal: true },
        }),
      ).rejects.toThrow(/fs\/\* is advertised.*terminal|unexpected client capabilities/);
    } finally {
      conn.close();
      child.kill();
    }
  });

  it('joins streamed chunks into one output per block and reports thinking apart', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:happy'));
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('Reading the README to get started.');
    expect(texts(r)).toContain('done');
    expect(of(r, 'agent.output').find((e) => e.kind === 'thinking')?.text).toBe(
      'Thinking about it.',
    );
    // The read went through the gate as the engine's Read on the file, once.
    expect(r.checks).toEqual([
      { toolName: 'Read', input: expect.objectContaining({ file_path: join(cwd, 'README.md') }) },
    ]);
    expect(of(r, 'agent.tool_call')).toHaveLength(1);
    expect(of(r, 'agent.progress')[0]?.progress).toMatchObject({ done: 1, total: 2 });
    // Cost: the session's dollars from usage_update, tokens from the prompt response.
    expect(of(r, 'agent.idle')[0]?.cost).toEqual({
      usd: 0.0021,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('keeps the cost cumulative across turns', async () => {
    const r = rig();
    const h = await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => idles(r) === 1, 'first idle');
    await r.adapter.send(h.sessionId, 'again');
    await waitFor(() => idles(r) === 2, 'second idle');
    expect(of(r, 'agent.idle')[1]?.cost).toEqual({
      usd: 0.0042,
      inputTokens: 200,
      outputTokens: 40,
    });
    expect(texts(r)).toContain('echo: again');
  });

  it('reports no cost when the agent reports none ("cost not reported")', async () => {
    const r = rig(['--no-cost']);
    await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => idles(r) === 1, 'idle');
    expect(of(r, 'agent.idle')[0]?.cost).toBeUndefined();
  });

  const askPush: Verdict = (call) =>
    /push/.test(JSON.stringify(call.input))
      ? { decision: 'ask', action: 'push', reasons: ['git push'] }
      : { decision: 'allow' };

  it('a call the agent ran without asking that the table would ask about holds: turn cancelled, a permission card, carry on when allowed', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:unasked', askPush));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
    expect(r.checks[0]).toEqual({
      toolName: 'Bash',
      input: {
        command: 'git push origin main',
        acp: { kind: 'execute', title: 'git push origin main' },
      },
    });
    const q = of(r, 'agent.needs_input')[0]!;
    expect(q).toMatchObject({
      kind: 'permission',
      question: {
        text: expect.stringMatching(
          /ran git push origin main without asking.*would have asked \(git push\)/,
        ),
        toolCall: { toolName: 'Bash', input: { command: 'git push origin main' } },
        permissionAction: 'push',
      },
    });
    expect(of(r, 'agent.tool_call')).toHaveLength(1); // it ran: reported
    // The turn is cancelled and does not end in idle: the agent waits on the answer.
    await new Promise((res) => setTimeout(res, 500));
    expect(texts(r)).not.toContain('after the command');
    expect(idles(r)).toBe(0);
    await r.adapter.answer(q.questionId, 'allow');
    await waitFor(() => idles(r) === 1, 'idle after the new turn');
    expect(texts(r).some((t) => /^echo: GalacticAgents stopped your last turn/.test(t))).toBe(true);
    expect(of(r, 'agent.failed')).toEqual([]);
  });

  it('a hold the user refuses stops the agent: failed (runtime) with the reason', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:unasked', askPush));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
    await r.adapter.answer(of(r, 'agent.needs_input')[0]!.questionId, 'deny: not now');
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(of(r, 'agent.failed')[0]).toMatchObject({
      reason: 'runtime',
      error: expect.stringMatching(
        /ran git push origin main without asking and was not allowed.*not now/,
      ),
    });
    expect(idles(r)).toBe(0);
    await waitFor(() => r.supervisor.runningCount === 0, 'no process');
  });

  it('a dismissed hold is refused like a deny: the agent is stopped (P9-14)', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:unasked', askPush));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
    await r.adapter.dismiss(of(r, 'agent.needs_input')[0]!.questionId, 'dismissed by the user');
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(of(r, 'agent.failed')[0]?.error).toMatch(/not allowed.*dismissed by the user/);
  });

  it('a dismissal is refused whatever its reason reads, an "allow" included (wave-6 review)', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:unasked', askPush));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
    await r.adapter.dismiss(of(r, 'agent.needs_input')[0]!.questionId, 'allow');
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(of(r, 'agent.failed')[0]?.error).toMatch(/not allowed.*: allow$/);
  });

  it('an interrupt withdraws a hold: the agent goes idle', async () => {
    const r = rig();
    const h = await r.adapter.spawn(spawnOpts(r, 'scenario:unasked', askPush));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
    await r.adapter.interrupt(h.sessionId);
    await waitFor(() => idles(r) === 1, 'idle');
    await expect(
      r.adapter.answer(of(r, 'agent.needs_input')[0]!.questionId, 'allow'),
    ).rejects.toThrow(/no pending question/);
    expect(of(r, 'agent.failed')).toEqual([]);
  });

  it('a call the agent ran without asking that the table denies stops the agent for the user', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:unasked\ncommand: rm -rf dist', () => ({
        decision: 'deny',
        reason: 'destructive: denied by the table',
      })),
    );
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(of(r, 'agent.tool_call')).toEqual([]);
    expect(of(r, 'agent.failed')[0]).toMatchObject({
      reason: 'runtime',
      error: expect.stringMatching(
        /ran rm -rf dist without asking, and the permission table denies it \(destructive/,
      ),
    });
    expect(texts(r)).not.toContain('after the command');
    expect(r.events.filter((e) => /finished|failed|stopped/.test(e.type))).toHaveLength(1);
    await waitFor(() => r.supervisor.runningCount === 0, 'no process');
  });

  it('a call reported as failed at once is still judged', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:failsUnasked', () => ({ decision: 'deny', reason: 'denied' })),
    );
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({ toolName: 'Bash', input: { command: 'rm -rf /tmp/x' } });
  });

  it("a call the agent's own rules refused before it ran is not judged, held or reported (claude-agent-acp)", async () => {
    // Real trace (P8-07): claude-agent-acp reports a call its permission rules denied as `failed`
    // with a denial marker, without asking; nothing ran, so there is nothing to ask the user.
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:refusesItself', () => ({
        decision: 'ask',
        action: 'destructive',
        reasons: ['rm'],
      })),
    );
    await waitFor(() => idles(r) === 1, 'idle');
    expect(r.checks).toEqual([]);
    expect(of(r, 'agent.needs_input')).toEqual([]);
    expect(of(r, 'agent.tool_call')).toEqual([]);
    expect(
      texts(r).some((t) => /^tool failed \(rm -rf scratch-dir\): Permission denied/.test(t)),
    ).toBe(true);
    expect(texts(r)).toContain('I could not run it.');
  });

  it('a call whose input changes after it was judged is judged once more, not reserved again', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:rewrites', askPush));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
    expect(r.checks.map((c) => (c.input as { command: string }).command)).toEqual([
      'ls',
      'git push origin main',
    ]);
    expect(r.reserves).toEqual([true, false]);
  });

  it('a call judged when it started and then asked about is reserved against the cap once', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:startsThenAsks'));
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('tested');
    expect(r.checks).toHaveLength(2);
    expect(r.reserves).toEqual([true, false]);
    expect(of(r, 'agent.tool_call')).toHaveLength(1);
  });

  describe('session modes (decision 108)', () => {
    it('refuses an agent whose mode runs tool calls without asking', async () => {
      const r = rig(['--mode', 'bypassPermissions']);
      await expect(r.adapter.spawn(spawnOpts(r, 'scenario:echo'))).rejects.toThrow(
        /mode "Bypass Permissions", which runs tool calls without asking.*acp\.mode.*allowPermissiveMode/,
      );
      await waitFor(() => r.supervisor.runningCount === 0, 'no process');
      expect(r.events).toEqual([]);
    });

    it('accepts it when the config opts in', async () => {
      const r = rig(['--mode', 'bypassPermissions'], { allowPermissiveMode: true });
      await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
      await waitFor(() => idles(r) === 1, 'idle');
    });

    it('sets the configured mode (set_mode, or the mode config option) before the first prompt', async () => {
      for (const extra of [[], ['--config-modes']]) {
        const r = rig(['--mode', 'bypassPermissions', ...extra], { mode: 'default' });
        await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
        await waitFor(() => idles(r) === 1, 'idle');
      }
      const named = rig(['--mode', 'default'], { mode: 'plan mode' }); // by name, any case
      await named.adapter.spawn(spawnOpts(named, 'scenario:echo'));
      await waitFor(() => idles(named) === 1, 'idle');
    });

    it('refuses a configured mode the agent does not have, or a permissive one', async () => {
      const r = rig(['--mode', 'default'], { mode: 'careful' });
      await expect(r.adapter.spawn(spawnOpts(r, 'scenario:echo'))).rejects.toThrow(
        /no mode "careful" \(acp\.mode; its modes: default, plan, acceptEdits, bypassPermissions\)/,
      );
      const p = rig(['--mode', 'default'], { mode: 'acceptEdits' });
      await expect(p.adapter.spawn(spawnOpts(p, 'scenario:echo'))).rejects.toThrow(
        /without asking/,
      );
    });

    it('an agent without modes is allowed', async () => {
      const r = rig([], { mode: 'default' });
      await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
      await waitFor(() => idles(r) === 1, 'idle');
    });

    it('a switch away from the expected mode holds; refused, the agent is stopped', async () => {
      const r = rig(['--mode', 'default']);
      await r.adapter.spawn(spawnOpts(r, 'scenario:switches'));
      await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
      const q = of(r, 'agent.needs_input')[0]!;
      expect(q.kind).toBe('permission');
      expect(q.question.toolCall).toBeUndefined(); // never decided by the table: the user's
      expect(q.question.text).toMatch(
        /switched itself to mode "Bypass Permissions", which runs tool calls without asking/,
      );
      expect(texts(r)).not.toContain('after the switch');
      await r.adapter.answer(q.questionId, 'no');
      await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
      expect(of(r, 'agent.failed')[0]?.error).toMatch(/switched itself to mode/);
    });

    it('a switch the user allows becomes the expected mode', async () => {
      const r = rig(['--mode', 'default']);
      const h = await r.adapter.spawn(spawnOpts(r, 'scenario:switches\nmode:plan'));
      await waitFor(() => of(r, 'agent.needs_input').length === 1, 'hold');
      expect(of(r, 'agent.needs_input')[0]!.question.text).toMatch(/mode "Plan Mode"\. Let it/);
      await r.adapter.answer(of(r, 'agent.needs_input')[0]!.questionId, 'yes');
      await waitFor(() => idles(r) === 1, 'idle');
      await r.adapter.send(h.sessionId, 'again');
      await waitFor(() => texts(r).includes('echo: again'), 'echo');
      expect(of(r, 'agent.needs_input')).toHaveLength(1);
    });
  });

  describe('isolated settings (decision 108 amendment)', () => {
    it('asks for no filesystem settings and no bypass mode by default; userSettings and sessionMeta open it', () => {
      expect(ISOLATED_SESSION_META).toEqual({ claudeCode: { options: { settingSources: [] } } });
      expect(sessionMetaFor({ command: 'x' })).toEqual({
        claudeCode: { options: { settingSources: [], allowDangerouslySkipPermissions: false } },
      });
      expect(sessionMetaFor({ command: 'x', userSettings: true })).toEqual({
        claudeCode: { options: { allowDangerouslySkipPermissions: false } },
      });
      expect(
        sessionMetaFor({ command: 'x', userSettings: true, allowPermissiveMode: true }),
      ).toBeUndefined();
      // sessionMeta merges deeply over the defaults, its values winning.
      expect(
        sessionMetaFor({
          command: 'x',
          sessionMeta: {
            claudeCode: { options: { settingSources: ['project'] } },
            other: { a: 1 },
          },
        }),
      ).toEqual({
        claudeCode: {
          options: { settingSources: ['project'], allowDangerouslySkipPermissions: false },
        },
        other: { a: 1 },
      });
    });

    it('sends the isolation _meta with session/new', async () => {
      const r = rig();
      await r.adapter.spawn(spawnOpts(r, 'scenario:meta'));
      await waitFor(() => idles(r) === 1, 'idle');
      expect(texts(r)).toContain(
        'meta: {"claudeCode":{"options":{"settingSources":[],"allowDangerouslySkipPermissions":false}}}',
      );
    });

    it('sends the configured _meta, and none with userSettings and allowPermissiveMode', async () => {
      const r = rig([], { userSettings: true, allowPermissiveMode: true });
      await r.adapter.spawn(spawnOpts(r, 'scenario:meta'));
      await waitFor(() => idles(r) === 1, 'idle');
      expect(texts(r)).toContain('meta: null');
    });
  });

  it('passes routing variables by default, never a credential; refuses GALACTIC_* in passEnv', () => {
    for (const secret of [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'OPENAI_API_KEY',
    ]) {
      expect(ACP_PASS_ENV).not.toContain(secret);
    }
    expect(ACP_PASS_ENV.every((k) => !/TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD/i.test(k))).toBe(true);
    const supervisor = new ProcessSupervisor();
    expect(
      () =>
        new AcpAdapter({
          supervisor,
          agent: { command: 'x', passEnv: ['GEMINI_API_KEY', 'GALACTIC_TOKEN'] },
        }),
    ).toThrow(/GALACTIC_TOKEN/);
    void supervisor.dispose();
  });

  it('a form of several fields is one question set: every row at once, typed values once all are answered (P8-20)', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:asks-set'));
    await waitFor(() => of(r, 'agent.needs_input').length === 3, 'every row');
    const [q1, q2, q3] = of(r, 'agent.needs_input');
    const setId = q1!.question.set?.id;
    expect(setId).toMatch(/^qs-/);
    const set = (index: number) => ({ id: setId, index, total: 3, title: 'Export details' });
    expect(q1!.question).toEqual({
      text: 'Before I start the export: — Date format',
      options: ['ISO 8601', 'US', 'EU'],
      set: set(0),
    });
    // Multi-select is native on the card: no "(one or more: …)" suffix.
    expect(q2!.question).toEqual({
      text: 'Before I start the export: — Columns',
      options: ['date', 'amount', 'note'],
      multiSelect: true,
      set: set(1),
    });
    expect(q3!.question).toEqual({
      text: 'Before I start the export: — Anything else?',
      set: set(2),
    });
    await r.adapter.answer(q2!.questionId, 'date, note');
    await r.adapter.answer(q1!.questionId, 'EU');
    await sleep(50);
    expect(texts(r).some((t) => t.startsWith('set:'))).toBe(false);
    await r.adapter.answer(q3!.questionId, 'no');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('set: {"format":"EU","columns":["date","note"],"note":"no"}');
  });

  it('an untitled form set is "Questions from the Steward"; an unreadable answer is asked again alone', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:form'));
    await waitFor(() => of(r, 'agent.needs_input').length === 2, 'both rows');
    const [q1, q2] = of(r, 'agent.needs_input');
    expect(q1!.kind).toBe('clarification');
    expect(q1!.question).toMatchObject({
      text: 'Tell me about the release. — How many builds?',
      set: { index: 0, total: 2, title: 'Questions from the Steward' },
    });
    expect(q2!.question).toMatchObject({ options: ['yes', 'no'], set: { index: 1, total: 2 } });
    await r.adapter.answer(q1!.questionId, 'lots');
    await r.adapter.answer(q2!.questionId, 'yes');
    await waitFor(() => of(r, 'agent.needs_input').length === 3, 'the re-ask');
    const again = of(r, 'agent.needs_input')[2]!;
    expect(again.question.text).toMatch(/How many builds\? \(could not read "lots"/);
    expect(again.question.set).toBeUndefined();
    await r.adapter.answer(again.questionId, '3');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('form: {"count":3,"ship":true}');
    await expect(r.adapter.answer(again.questionId, 'again')).rejects.toThrow(
      /no pending question/,
    );
  });

  it("claude-agent-acp's question tool: one clarification, the answer matched to its choice, no hold", async () => {
    // Real trace (P8-07): AskUserQuestion is a tool call of kind `other` the agent never asks
    // about; its form has the choice and an optional "Other" box. One question, not two, and the
    // tool call completing after the answer is not an unasked call to hold.
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:asksTool', () => ({ decision: 'ask', reasons: ['unclassified'] })),
    );
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    const q = of(r, 'agent.needs_input')[0]!;
    expect(q).toMatchObject({
      kind: 'clarification',
      question: { text: 'Which option do you prefer?', options: ['First option', 'Second option'] },
    });
    await r.adapter.answer(q.questionId, 'the first option');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('You chose: First option');
    expect(of(r, 'agent.needs_input')).toHaveLength(1);
    expect(r.checks).toEqual([]);
    expect(of(r, 'agent.tool_call')).toEqual([]);
  });

  it('a dismissed row of a form set declines the whole elicitation (P9-14, P8-20)', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:form'));
    await waitFor(() => of(r, 'agent.needs_input').length === 2, 'both rows');
    const [q1, q2] = of(r, 'agent.needs_input');
    await r.adapter.dismiss(q1!.questionId, 'dismissed by the user');
    await r.adapter.answer(q2!.questionId, 'yes');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('form: undefined'); // declined: no content
    expect(of(r, 'agent.needs_input')).toHaveLength(2);
  });

  it('a dismissed permission request answers reject_once, never allow (P9-14)', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:permission', () => ({ decision: 'ask', reasons: ['rm -rf'] })),
    );
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    await r.adapter.dismiss(of(r, 'agent.needs_input')[0]!.questionId, 'dismissed by the user');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('Skipped: the permission was refused.');
    expect(texts(r).some((t) => /permission denied for .*dismissed by the user/.test(t))).toBe(
      true,
    );
    expect(of(r, 'agent.tool_call')).toEqual([]);
  });

  it('an answer that names no choice goes to the "Other" box', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:asksTool'));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    await r.adapter.answer(of(r, 'agent.needs_input')[0]!.questionId, 'a third one');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('You chose: a third one');
  });

  it('a permission request asked of the user: allow answers allow_once and reports the call', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:permission', () => ({
        decision: 'ask',
        action: 'destructive',
        reasons: ['rm -rf'],
      })),
    );
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    const q = of(r, 'agent.needs_input')[0]!;
    expect(q).toMatchObject({
      kind: 'permission',
      question: {
        text: 'May the agent run rm -rf dist? (rm -rf)',
        toolCall: { toolName: 'Bash', input: { command: 'rm -rf dist' } },
        permissionAction: 'destructive',
      },
    });
    expect(of(r, 'agent.tool_call')).toEqual([]);
    await r.adapter.answer(q.questionId, 'allow');
    await waitFor(() => idles(r) === 1, 'idle');
    // The fake agent fails the turn if it is ever answered with allow_always.
    expect(texts(r)).toContain('cleaned');
    expect(of(r, 'agent.tool_call')).toHaveLength(1);
    expect(r.checks).toHaveLength(1); // one gate check for the call, not a second when it ran
  });

  it('an error answering the prompt is a transcript line and an idle; the session goes on', async () => {
    const r = rig();
    const h = await r.adapter.spawn(spawnOpts(r, 'scenario:error'));
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r).some((t) => /turn ended with an error: .*model is unavailable/.test(t))).toBe(
      true,
    );
    await r.adapter.send(h.sessionId, 'still there?');
    await waitFor(() => texts(r).includes('echo: still there?'), 'echo');
    expect(of(r, 'agent.failed')).toEqual([]);
  });

  it('a refusal stop reason is said in the transcript', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:refusal'));
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('turn ended: refusal');
  });

  it('an agent that exits on its own mid-turn fails with reason crash, once', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:dies'));
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(of(r, 'agent.failed')[0]).toMatchObject({ reason: 'crash', error: /code 3/ });
    await new Promise((res) => setTimeout(res, 100));
    expect(r.events.filter((e) => /finished|failed|stopped/.test(e.type))).toHaveLength(1);
    expect(r.adapter.sessionCount).toBe(0);
  });

  it('resumes with session/load and keeps the replayed conversation out of the transcript', async () => {
    const first = rig();
    const agentId = 'resumed-agent';
    const h = await first.adapter.spawn(spawnOpts(first, 'scenario:echo', allowAll, agentId));
    await waitFor(() => idles(first) === 1, 'idle');
    expect(h.sessionRef).toMatch(/^acp:fake-/);
    await first.adapter.stop(h.sessionId);
    const second = rig();
    const again = await second.adapter.resumeSession(
      h.sessionRef!,
      spawnOpts(second, 'continue please', allowAll, agentId),
    );
    expect(again.sessionRef).toBe(h.sessionRef);
    await waitFor(() => idles(second) === 1, 'idle after resume');
    expect(texts(second)).toEqual(['echo: continue please']);
    // session/load carries the isolation _meta too (the fake agent saves what it got).
    const saved = JSON.parse(
      readFileSync(join(state, `${h.sessionRef!.slice(4).replace(/[^\w-]/g, '_')}.json`), 'utf8'),
    ) as { loadMeta: unknown };
    expect(saved.loadMeta).toEqual(sessionMetaFor({ command: 'x' }));
  });

  it('cannot resume without loadSession: the resume fails and no process is left', async () => {
    const r = rig(['--no-load']);
    await expect(
      r.adapter.resumeSession('acp:fake-anything', spawnOpts(r, 'continue', allowAll, 'nl')),
    ).rejects.toThrow(/no loadSession capability/);
    expect(r.supervisor.runningCount).toBe(0);
    expect(r.events).toEqual([]);
  });

  it('a resume of a session the agent does not know fails cleanly', async () => {
    const r = rig();
    await expect(
      r.adapter.resumeSession('acp:fake-unknown', spawnOpts(r, 'continue', allowAll, 'unk')),
    ).rejects.toThrow(/session\/load failed/);
    await waitFor(() => r.supervisor.runningCount === 0, 'no process');
    await expect(r.adapter.resumeSession('not a ref', spawnOpts(r, 'x'))).rejects.toThrow(
      /not an acp session ref/,
    );
  });

  it('refuses brains (server tools), bare spawns and a missing working directory', async () => {
    const r = rig();
    await expect(
      r.adapter.spawn({
        ...spawnOpts(r, 'x'),
        role: 'waykeeper',
        tools: [{ name: 't', description: 'd', inputSchema: {}, handler: async () => 'ok' }],
      }),
    ).rejects.toThrow(/claude-sdk runtime/);
    await expect(r.adapter.spawn({ ...spawnOpts(r, 'x'), bare: true })).rejects.toThrow(/bare/);
    await expect(
      r.adapter.spawn({ ...spawnOpts(r, 'x'), cwd: join(cwd, 'missing') }),
    ).rejects.toThrow(/does not exist/);
    expect(r.supervisor.runningCount).toBe(0);
  });

  it('a command that does not exist fails the spawn', async () => {
    const supervisor = new ProcessSupervisor();
    const adapter = new AcpAdapter({
      supervisor,
      agent: { command: join(cwd, 'no-such-agent') },
      startTimeoutMs: 5_000,
    });
    rigs.push({ adapter, supervisor, events: [], checks: [], reserves: [] });
    await expect(adapter.spawn(spawnOpts(rigs.at(-1)!, 'x'))).rejects.toThrow(
      /exited during initialize/,
    );
  });

  it('pause freezes the agent; interrupt while paused thaws it first', async () => {
    const r = rig();
    const h = await r.adapter.spawn(spawnOpts(r, 'scenario:long'));
    await waitFor(() => of(r, 'agent.progress').length > 0, 'progress');
    await r.adapter.pause(h.sessionId);
    const n = r.events.length;
    await new Promise((res) => setTimeout(res, 300));
    expect(r.events.length).toBe(n + 0);
    await r.adapter.interrupt(h.sessionId);
    await waitFor(() => idles(r) === 1, 'idle');
    const types = r.events.map((e) => e.type);
    expect(types.indexOf('agent.resumed')).toBeLessThan(types.indexOf('agent.idle'));
  });

  it('keeps the commands of available_commands_update, also across a load (P8-13)', async () => {
    const r = rig(['--commands']);
    const h = await r.adapter.spawn(spawnOpts(r, 'hello'));
    await waitFor(() => idles(r) === 1, 'idle');
    const expected = [
      { name: 'research_codebase', description: 'Research the codebase', argumentHint: '<topic>' },
      { name: 'create_plan', description: 'Write a plan for the task' },
    ];
    // Announced just after session/new: poll until it has arrived.
    let commands = await r.adapter.commands(h.sessionId);
    for (let i = 0; i < 50 && commands.length === 0; i++) {
      await new Promise((res) => setTimeout(res, 10));
      commands = await r.adapter.commands(h.sessionId);
    }
    expect(commands).toEqual(expected);
    // Not transcript.
    expect(texts(r).join(' ')).not.toContain('research_codebase');

    await r.adapter.stop(h.sessionId);
    expect(await r.adapter.commands(h.sessionId)).toEqual([]);
    const resumed = await r.adapter.resumeSession(
      h.sessionRef!,
      spawnOpts(r, 'again', allowAll, 'a-load'),
    );
    await waitFor(() => idles(r) >= 2, 'idle after load');
    expect(await r.adapter.commands(resumed.sessionId)).toEqual(expected);
  });

  it('reports no commands for an agent that announces none', async () => {
    const r = rig();
    const h = await r.adapter.spawn(spawnOpts(r, 'hello'));
    await waitFor(() => idles(r) === 1, 'idle');
    expect(await r.adapter.commands(h.sessionId)).toEqual([]);
  });
});
