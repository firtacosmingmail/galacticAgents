import { mkdtempSync, writeFileSync } from 'node:fs';
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
import { FAKE_PTY_AGENT, FAKE_PTY_IDLE } from './fake-agent.js';
import { checkPassEnv, PTY_SESSION_TOOL, PtyAdapter, type PtyAgentCommand } from './pty-adapter.js';
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
  it('runs only where the table allows what it cannot classify (proposed decision 110)', async () => {
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

  it('a send re-checks the table; a mid-turn send without interrupt is refused', async () => {
    const r = rig();
    let verdict: GateVerdict = { decision: 'allow' };
    const { sessionId } = await r.adapter.spawn(spawnOpts(r, 'scenario:echo', () => verdict));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    verdict = { decision: 'ask', reasons: ['now cautious'] };
    await expect(r.adapter.send(sessionId, 'hi')).rejects.toThrow(/now cautious/);
    verdict = { decision: 'allow' };
    await r.adapter.send(sessionId, 'hi');
    await expect(r.adapter.send(sessionId, 'again')).rejects.toThrow(/mid-turn/);
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
