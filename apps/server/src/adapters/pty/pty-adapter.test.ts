import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  AgentEvent,
  GateCheckOptions,
  GateVerdict,
  ToolCall,
} from '@galactic/protocol';
import { MemoryProcessStore } from '../../runtime/process-store.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { FAKE_PTY_AGENT, FAKE_PTY_CLARIFICATIONS, FAKE_PTY_IDLE } from './fake-agent.js';
import {
  checkPassEnv,
  PTY_SESSION_TOOL,
  PtyAdapter,
  TABLE_NO_LONGER_ALLOWS,
  type PtyAgentCommand,
} from './pty-adapter.js';
import { ensureSpawnHelper, signalName } from './pty-child.js';

/**
 * The PTY adapter on its own (P8-08), against the scripted terminal agent: what the conformance
 * suite does not pin — the trust rule, the two transcript forms, exit codes, a question the CLI
 * moved on from, the user's typing, the silence rule, and the supervisor's bookkeeping (PID table,
 * agent marker, process group, environment).
 */

const cwd = mkdtempSync(join(tmpdir(), 'galactic-pty-unit-'));
writeFileSync(join(cwd, 'README.md'), '# unit\n');
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 100 };

interface Rig {
  adapter: PtyAdapter;
  supervisor: ProcessSupervisor;
  store: MemoryProcessStore;
  events: AgentEvent[];
  checks: { call: ToolCall; reserve: boolean }[];
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.adapter.dispose();
    await r.supervisor.dispose();
  }
});

function rig(agent: { [K in keyof PtyAgentCommand]?: PtyAgentCommand[K] | undefined } = {}): Rig {
  const store = new MemoryProcessStore();
  const supervisor = new ProcessSupervisor({ store, defaults: { graceMs: 2_000, termMs: 1_000 } });
  const adapter = new PtyAdapter({
    supervisor,
    agent: Object.fromEntries(
      Object.entries({
        command: 'bash',
        args: [FAKE_PTY_AGENT],
        idlePattern: FAKE_PTY_IDLE,
        clarificationPatterns: FAKE_PTY_CLARIFICATIONS,
        quietMs: 120,
        ...agent,
      }).filter(([, v]) => v !== undefined),
    ) as unknown as PtyAgentCommand,
    graceMs: 2_000,
    interruptIdleMs: 2_000,
  });
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of adapter.events) events.push(e);
  })();
  const r: Rig = { adapter, supervisor, store, events, checks: [] };
  rigs.push(r);
  return r;
}

const allow = (): GateVerdict => ({ decision: 'allow' });

function spawnOpts(
  r: Rig,
  prompt: string,
  verdict: () => GateVerdict = allow,
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
        r.checks.push({ call, reserve: opts?.reserve ?? true });
        return verdict();
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
const outputs = (r: Rig, kind: 'text' | 'terminal') =>
  of(r, 'agent.output')
    .filter((e) => e.kind === kind)
    .map((e) => e.text)
    .join('');

describe('PtyAdapter', () => {
  it('runs only where the table allows what it cannot classify (decision 112)', async () => {
    const r = rig();
    const ask = (): GateVerdict => ({ decision: 'ask', reasons: ['unclassified'] });
    await expect(r.adapter.spawn(spawnOpts(r, 'scenario:happy', ask))).rejects.toThrow(
      /trusted.*unclassified/,
    );
    expect(r.checks).toEqual([
      {
        call: { toolName: PTY_SESSION_TOOL, input: { command: `bash ${FAKE_PTY_AGENT}`, cwd } },
        reserve: false,
      },
    ]);
    expect(r.supervisor.list()).toEqual([]); // nothing forked
    const deny = (): GateVerdict => ({ decision: 'deny', reason: 'denied by policy' });
    await expect(r.adapter.spawn(spawnOpts(r, 'scenario:happy', deny))).rejects.toThrow(
      /denied by policy/,
    );
    expect(r.events).toEqual([]);
    // A push in the command line: its own reason (a push always asks, decision 49).
    const push = (): GateVerdict => ({
      decision: 'ask',
      action: 'push',
      reasons: ['the command mentions git push, which leaves the machine'],
    });
    await expect(r.adapter.spawn(spawnOpts(r, 'scenario:happy', push))).rejects.toThrow(
      /mentions a push, and a push always asks the user \(decision 49\)/,
    );
  });

  it('streams raw terminal chunks and their stripped text; exit 0 finishes with the last lines', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:happy'));
    await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
    expect(outputs(r, 'terminal')).toContain('\x1b[32mreading\x1b[0m');
    const text = outputs(r, 'text');
    expect(text).toContain('reading the README');
    expect(text).not.toContain('\x1b');
    expect(of(r, 'agent.progress')[0]?.summary).toBeTruthy();
    expect(of(r, 'agent.finished')[0]!.result).toContain('all done');
    expect(of(r, 'agent.finished')[0]).not.toHaveProperty('cost');
  });

  it('a non-zero exit fails as runtime, with its last line', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:fails'));
    await waitFor(() => of(r, 'agent.failed').length === 1, 'failed');
    expect(of(r, 'agent.failed')[0]).toMatchObject({
      reason: 'runtime',
      error: expect.stringMatching(/code 3: something broke/),
    });
  });

  it('goes through the supervisor: PID row, agent marker, own process group, passEnv only', async () => {
    process.env['PTY_TEST_SECRET'] = 'not-for-the-cli';
    try {
      const r = rig();
      const agentId = `pty-env-${Math.random()}`;
      await r.adapter.spawn(spawnOpts(r, 'scenario:env', allow, agentId));
      const pid = r.supervisor.get(agentId)!.pid;
      expect(r.store.get(agentId)).toMatchObject({ pid, status: 'running' });
      await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
      expect(outputs(r, 'text')).toContain(`agent=${agentId} pgid=${pid} secret=none`);

      const r2 = rig({ passEnv: ['PTY_TEST_SECRET'] });
      await r2.adapter.spawn(spawnOpts(r2, 'scenario:env'));
      await waitFor(() => of(r2, 'agent.finished').length === 1, 'finished');
      expect(outputs(r2, 'text')).toContain('secret=not-for-the-cli');
    } finally {
      delete process.env['PTY_TEST_SECRET'];
    }
    expect(() => checkPassEnv(['GALACTIC_TOKEN'])).toThrow(/GALACTIC_/);
    expect(() => rig({ passEnv: ['galactic_x'] })).toThrow(/GALACTIC_/);
  });

  it('a permission question carries no tool call; allow types y, anything else n', async () => {
    for (const [answer, said] of [
      ['allow', 'deleted build'],
      ['deny: not now', 'kept build'],
    ] as const) {
      const r = rig();
      await r.adapter.spawn(spawnOpts(r, 'scenario:permission'));
      await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
      const q = of(r, 'agent.needs_input')[0]!;
      expect(q.kind).toBe('permission');
      expect(q.question.toolCall).toBeUndefined();
      expect(q.question.text).toMatch(
        /cannot see what it would do[\s\S]*about to clean up[\s\S]*> Delete the build folder\? \[y\/N\]/,
      );
      await r.adapter.answer(q.questionId, answer);
      await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
      expect(outputs(r, 'text')).toContain(said);
      await expect(r.adapter.answer(q.questionId, 'again')).rejects.toThrow(/no pending question/);
    }
  });

  it('a dismissed permission types n, never y; a dismissed clarification types nothing (P9-14)', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:permission'));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    const q = of(r, 'agent.needs_input')[0]!;
    // Refused: the agent goes on (unblocked).
    expect(await r.adapter.dismiss(q.questionId, 'dismissed by the user')).toBe(true);
    await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
    expect(outputs(r, 'text')).toContain('kept build');

    const r2 = rig();
    await r2.adapter.spawn(spawnOpts(r2, 'scenario:asks'));
    await waitFor(() => of(r2, 'agent.needs_input').length === 1, 'clarification');
    const c = of(r2, 'agent.needs_input')[0]!;
    // Nothing typed: the prompt is still up, the agent is not unblocked.
    expect(await r2.adapter.dismiss(c.questionId, 'dismissed by the user')).toBe(false);
    await waitFor(() => outputs(r2, 'text').includes('nothing was typed'), 'the note');
    expect(outputs(r2, 'text')).not.toContain('you chose');
    await expect(r2.adapter.dismiss(c.questionId, 'again')).rejects.toThrow(/no pending question/);
  });

  it('a question the CLI moved on from is answered without typing', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:movesOn'));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    expect(of(r, 'agent.needs_input')[0]!.kind).toBe('clarification');
    await waitFor(() => outputs(r, 'text').includes('carrying on'), 'carrying on');
    await r.adapter.answer(of(r, 'agent.needs_input')[0]!.questionId, 'the first');
    await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
    const text = outputs(r, 'text');
    expect(text).toContain('the answer was not typed');
    expect(text).not.toContain('the first');
  });

  it('the user types into the terminal at any time; a paused one refuses', async () => {
    const r = rig();
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    await r.adapter.input(sessionId, 'typed\nby hand');
    await waitFor(() => outputs(r, 'text').includes('echo: typed by hand'), 'echo');
    // Typed while idle, the line opened a turn: the idle prompt coming back ends it.
    await waitFor(() => of(r, 'agent.idle').length === 2, 'the typed turn ends');
    await r.adapter.pause(sessionId);
    await expect(r.adapter.input(sessionId, 'x')).rejects.toThrow(/paused/);
    await r.adapter.resume(sessionId);
  });

  it('without an idle prompt, idleAfterMs of silence ends a turn', async () => {
    const r = rig({ idlePattern: undefined, idleAfterMs: 400 });
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle by silence');
    await r.adapter.send(sessionId, 'hello');
    await waitFor(() => of(r, 'agent.idle').length === 2, 'idle again');
    expect(outputs(r, 'text')).toContain('echo: hello');
  });

  it('a mid-turn send without interrupt is refused', async () => {
    const r = rig();
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    await r.adapter.send(sessionId, 'hi');
    await expect(r.adapter.send(sessionId, 'again')).rejects.toThrow(/mid-turn/);
  });

  it('a send the table no longer allows ends the agent with the reason (decision 112)', async () => {
    const r = rig();
    let verdict: GateVerdict = { decision: 'allow' };
    const agentId = `pty-tightened-${Math.random()}`;
    const { sessionId } = await r.adapter.spawn(
      spawnOpts(r, 'scenario:echo', () => verdict, agentId),
    );
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    verdict = { decision: 'ask', reasons: ['now cautious'] };
    await expect(r.adapter.send(sessionId, 'hi')).rejects.toThrow(TABLE_NO_LONGER_ALLOWS);
    expect(of(r, 'agent.failed')).toEqual([
      { type: 'agent.failed', agentId, error: TABLE_NO_LONGER_ALLOWS, reason: 'runtime' },
    ]);
    await waitFor(() => r.supervisor.get(agentId)?.state === 'exited', 'process stopped');
    expect(outputs(r, 'text')).not.toContain('echo: hi');
    await expect(r.adapter.send(sessionId, 'again')).rejects.toThrow(/has failed/);
    expect(r.adapter.sessionCount).toBe(0);
  });

  it('a clarification answer re-checks the table; a permission answer is the user own', async () => {
    const r = rig();
    let verdict: GateVerdict = { decision: 'allow' };
    await r.adapter.spawn(spawnOpts(r, 'scenario:asks', () => verdict));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    const q = of(r, 'agent.needs_input')[0]!;
    expect(q.kind).toBe('clarification');
    verdict = { decision: 'deny', reason: 'tightened' };
    await expect(r.adapter.answer(q.questionId, 'blue')).rejects.toThrow(TABLE_NO_LONGER_ALLOWS);
    expect(of(r, 'agent.failed')[0]).toMatchObject({ error: TABLE_NO_LONGER_ALLOWS });
    expect(outputs(r, 'text')).not.toContain('you chose');
  });

  it('fails closed: a question no clarification pattern matched is a free-form permission', async () => {
    for (const [answer, said] of [
      ['allow', 'you chose: '],
      ['no', 'interrupted'],
    ] as const) {
      const r = rig({ clarificationPatterns: undefined });
      await r.adapter.spawn(spawnOpts(r, 'scenario:asks'));
      await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
      const q = of(r, 'agent.needs_input')[0]!;
      expect(q.kind).toBe('permission');
      expect(q.question.toolCall).toBeUndefined();
      expect(q.question.text).toMatch(/Allow presses Enter.*Refuse interrupts it/);
      await r.adapter.answer(q.questionId, answer);
      if (answer === 'allow') {
        await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
        expect(outputs(r, 'text')).toContain(said);
      } else {
        // Ctrl-C: the fixture drops back to its prompt, the turn ends; nothing was typed.
        await waitFor(() => of(r, 'agent.idle').length === 1, 'idle after the interrupt');
        expect(outputs(r, 'text')).not.toContain('you chose');
      }
    }
  });

  it("an aider-style prompt is a permission; allow types y, refuse n (the style's tokens)", async () => {
    for (const [answer, typed] of [
      ['allow', 'answer=y'],
      ['refuse', 'answer=n'],
    ] as const) {
      const r = rig();
      await r.adapter.spawn(spawnOpts(r, 'scenario:aider'));
      await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
      const q = of(r, 'agent.needs_input')[0]!;
      expect(q.kind).toBe('permission');
      expect(q.question.text).toContain('(Y)es/(N)o [Yes]:');
      await r.adapter.answer(q.questionId, answer);
      await waitFor(() => outputs(r, 'text').includes(typed), typed);
    }
  });

  it('no control character reaches the terminal: first prompt, messages, answers, typing', async () => {
    const r = rig();
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:echo\x03\x15'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    await r.adapter.send(sessionId, 'one\x03two\x15three\x1b[31mred\x7f\x9bX');
    await waitFor(() => outputs(r, 'text').includes('echo: onetwothree[31mredX'), 'send');
    await waitFor(() => of(r, 'agent.idle').length === 2, 'idle again');
    await r.adapter.input(sessionId, 'kill\x03 \x04line\x15');
    await waitFor(() => outputs(r, 'text').includes('echo: kill line'), 'typed');
    expect(of(r, 'agent.failed')).toEqual([]);

    const r2 = rig();
    await r2.adapter.spawn(spawnOpts(r2, 'scenario:asks'));
    await waitFor(() => of(r2, 'agent.needs_input').length === 1, 'question');
    await r2.adapter.answer(of(r2, 'agent.needs_input')[0]!.questionId, 'bl\x03ue\x1b[0m');
    await waitFor(() => of(r2, 'agent.finished').length === 1, 'finished');
    expect(outputs(r2, 'text')).toContain('you chose: blue[0m');
  });

  it('a long first prompt or message goes through a 0600 file, removed at the end', async () => {
    const dir = join(cwd, '.galactic', 'pty');
    const r = rig();
    const long = `scenario:size ${'x'.repeat(3_000)} THE-END-MARK`;
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, long));
    await waitFor(() => outputs(r, 'text').includes('task bytes:'), 'size');
    expect(outputs(r, 'text')).toContain('instructions read from a file');
    expect(outputs(r, 'text')).toContain(`task bytes: ${long.length} ends: THE-END-MARK`);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    await r.adapter.send(sessionId, `${'y'.repeat(2_000)}LAST-CHARS-1`);
    await waitFor(
      () => outputs(r, 'text').includes('file echo: 2012 bytes, ends: LAST-CHARS-1'),
      'echo',
    );
    await r.adapter.stop(sessionId);
    expect(existsSync(dir)).toBe(false);
  });

  it('{promptFile} passes the first prompt as a file; nothing is typed', async () => {
    const r = rig({ args: [FAKE_PTY_AGENT, '--prompt-file', '{promptFile}'] });
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:size short'));
    await waitFor(() => outputs(r, 'text').includes('task bytes:'), 'size');
    expect(outputs(r, 'text')).toMatch(/task from \S+\.galactic\/pty\/\S+\.txt/);
    expect(outputs(r, 'text')).toContain('ends: o:size short');
    // Judged as configured: the placeholder, not the prompt.
    expect(r.checks[0]!.call.input).toMatchObject({
      command: `bash ${FAKE_PTY_AGENT} --prompt-file {promptFile}`,
    });
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(outputs(r, 'text')).not.toContain('echo:');
    await r.adapter.stop(sessionId);
    expect(existsSync(join(cwd, '.galactic', 'pty'))).toBe(false);
  });

  it('carriage-return redraws (a spinner) are coalesced into about one chunk a second', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:spinner'));
    await waitFor(() => of(r, 'agent.finished').length === 1, 'finished');
    const chunks = of(r, 'agent.output').filter((e) => e.kind === 'terminal');
    const frames = chunks.filter((e) => e.text.includes('working'));
    // 20 frames over 2 s: ten-a-second batching would give about 20 rows.
    expect(frames.length).toBeLessThanOrEqual(6);
    expect(chunks.map((e) => e.text).join('')).toContain('working 20');
    expect(outputs(r, 'text')).toContain('spun');
  });

  it('a long answer or typed line is typed as is, with a warning in the transcript', async () => {
    const r = rig();
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    await r.adapter.input(sessionId, 'z'.repeat(1_500));
    await waitFor(() => outputs(r, 'text').includes('Warning: a 1500-byte line'), 'warning');
  });

  it('refuses brains and bare mode', async () => {
    const r = rig();
    await expect(
      r.adapter.spawn({
        ...spawnOpts(r, 'x'),
        tools: [{ name: 't', description: 'd', inputSchema: {}, handler: async () => 1 }],
      }),
    ).rejects.toThrow(/claude-sdk/);
    await expect(r.adapter.spawn({ ...spawnOpts(r, 'x'), bare: true })).rejects.toThrow(/bare/);
    expect((r.adapter as AgentAdapter).resumeSession).toBeUndefined();
  });

  it('helpers: signal names, the spawn helper made executable', () => {
    expect(signalName(9)).toBe('SIGKILL');
    expect(signalName(0)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'galactic-pty-helper-'));
    const helper = join(dir, 'spawn-helper');
    writeFileSync(helper, '#!/bin/sh\n', { mode: 0o644 });
    expect(ensureSpawnHelper([helper])).toEqual([]);
    expect(ensureSpawnHelper([join(dir, 'missing')])).toEqual([join(dir, 'missing')]);
  });
});
