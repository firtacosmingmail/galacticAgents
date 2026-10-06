import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, GateVerdict, ToolCall } from '@galactic/protocol';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { AcpAdapter, CLIENT_CAPABILITIES } from './acp-adapter.js';
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
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.adapter.dispose();
    await r.supervisor.dispose();
  }
});

function rig(extraArgs: string[] = []): Rig {
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  const adapter = new AcpAdapter({
    supervisor,
    agent: { command: process.execPath, args: [FAKE_ACP_AGENT, '--state', state, ...extraArgs] },
    graceMs: 2_000,
    startTimeoutMs: 10_000,
  });
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of adapter.events) events.push(e);
  })();
  const r = { adapter, supervisor, events, checks: [] };
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
      check: (call: ToolCall) => {
        r.checks.push(call);
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

  it('a call the agent ran without asking: allowed is reported, `ask` adds a warning', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:unasked', () => ({
        decision: 'ask',
        action: 'push',
        reasons: ['git push'],
      })),
    );
    await waitFor(() => idles(r) === 1, 'idle');
    expect(r.checks[0]).toEqual({
      toolName: 'Bash',
      input: {
        command: 'git push origin main',
        acp: { kind: 'execute', title: 'git push origin main' },
      },
    });
    expect(of(r, 'agent.tool_call')).toHaveLength(1);
    expect(texts(r).some((t) => /without asking.*would have asked \(git push\)/.test(t))).toBe(
      true,
    );
    expect(texts(r)).toContain('after the command');
    expect(of(r, 'agent.needs_input')).toEqual([]);
  });

  it('a call the agent ran without asking that the table denies cancels the turn', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:unasked\ncommand: rm -rf dist', () => ({
        decision: 'deny',
        reason: 'destructive: denied by the table',
      })),
    );
    await waitFor(() => idles(r) === 1, 'idle');
    expect(of(r, 'agent.tool_call')).toEqual([]);
    expect(
      texts(r).some((t) => /permission denied for rm -rf dist.*turn is cancelled/.test(t)),
    ).toBe(true);
    expect(texts(r)).not.toContain('after the command');
  });

  it('asks one clarification per form field, re-asks an unreadable answer, sends typed values', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:form'));
    const question = async (n: number) => {
      await waitFor(() => of(r, 'agent.needs_input').length >= n, `question ${n}`);
      return of(r, 'agent.needs_input')[n - 1]!;
    };
    const q1 = await question(1);
    expect(q1.kind).toBe('clarification');
    expect(q1.question.text).toBe('Tell me about the release. — How many builds?');
    await r.adapter.answer(q1.questionId, 'lots');
    const q2 = await question(2);
    expect(q2.question.text).toMatch(/How many builds\? \(could not read "lots"/);
    await r.adapter.answer(q2.questionId, '3');
    const q3 = await question(3);
    expect(q3.question).toMatchObject({ options: ['yes', 'no'] });
    await r.adapter.answer(q3.questionId, 'yes');
    await waitFor(() => idles(r) === 1, 'idle');
    expect(texts(r)).toContain('form: {"count":3,"ship":true}');
    await expect(r.adapter.answer(q3.questionId, 'again')).rejects.toThrow(/no pending question/);
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
    rigs.push({ adapter, supervisor, events: [], checks: [] });
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
});
