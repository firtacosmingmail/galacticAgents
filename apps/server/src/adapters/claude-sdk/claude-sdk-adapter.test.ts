import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  GateVerdict,
  PermissionGate,
  SpawnOptions,
  ToolCall,
} from '@galactic/protocol';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { collect } from '../../test/collect.js';
import { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
import { FakeSdk, type FakeScript } from './fake-sdk.js';
import { jsonSchemaToZodShape } from './json-schema-to-zod.js';
import type { ZodTypeAny } from 'zod';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const types = (events: AgentEvent[]) => events.map((e) => e.type);
const has = (type: AgentEvent['type']) => (events: AgentEvent[]) =>
  events.some((e) => e.type === type);

/** A gate that answers from a table; unknown tools ask. */
function gate(table: Record<string, GateVerdict> = {}, seen: ToolCall[] = []): PermissionGate {
  return {
    check(call) {
      seen.push(call);
      return (
        table[call.toolName] ?? { decision: 'ask', reasons: [`${call.toolName}: policy asks`] }
      );
    },
  };
}

const spawnOpts = (prompt: string, extra: Partial<SpawnOptions> = {}): SpawnOptions => ({
  agentId: 'a-1',
  role: 'steward',
  cwd: process.cwd(),
  prompt,
  gate: gate({
    Read: { decision: 'allow' },
    Bash: { decision: 'ask', action: 'destructive', reasons: ['rm deletes files'] },
    Write: { decision: 'deny', reason: 'edit_workspace is denied' },
  }),
  caps: { maxWallClockMs: 60_000, maxToolCalls: 100 },
  ...extra,
});

const rigs: { adapter: ClaudeSdkAdapter; supervisor: ProcessSupervisor }[] = [];
function make(
  script: FakeScript,
  opts: { spawnChild?: boolean; env?: Record<string, string | undefined> } = {},
) {
  const sdk = new FakeSdk({ script, ...(opts.spawnChild === false ? { spawnChild: false } : {}) });
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 500, termMs: 300 } });
  const adapter = new ClaudeSdkAdapter({
    supervisor,
    sdk,
    graceMs: 500,
    ...(opts.env ? { env: opts.env } : {}),
  });
  const events = collect<AgentEvent>(adapter.events);
  rigs.push({ adapter, supervisor });
  return { sdk, supervisor, adapter, events };
}
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.adapter.dispose();
    await r.supervisor.dispose();
  }
});

describe('ClaudeSdkAdapter — message mapping', () => {
  it('maps text, thinking, an allowed tool call and the result to the normalised events', async () => {
    const seen: ToolCall[] = [];
    const { adapter, events, sdk } = make(() => [
      { thinking: 'let me look' },
      { tool: 'Read', input: { file_path: 'README.md' }, result: '# hello' },
      { text: 'All good.' },
    ]);
    const handle = await adapter.spawn(
      spawnOpts('look at the readme', { gate: gate({ Read: { decision: 'allow' } }, seen) }),
    );
    expect(handle.sessionRef).toBe(handle.sessionId);
    await events.waitFor(has('agent.idle'));
    expect(events.items).toEqual([
      { type: 'agent.output', agentId: 'a-1', kind: 'thinking', text: 'let me look' },
      {
        type: 'agent.tool_call',
        agentId: 'a-1',
        toolName: 'Read',
        toolUseId: 'toolu_1_Read',
        input: { file_path: 'README.md' },
      },
      { type: 'agent.output', agentId: 'a-1', kind: 'tool', text: 'tool result: # hello' },
      { type: 'agent.output', agentId: 'a-1', kind: 'text', text: 'All good.' },
      { type: 'agent.idle', agentId: 'a-1', cost: { usd: 0.01, inputTokens: 10, outputTokens: 5 } },
    ]);
    expect(seen).toEqual([{ toolName: 'Read', input: { file_path: 'README.md' } }]);
    const options = sdk.calls[0]!.options;
    expect(options).toMatchObject({
      cwd: process.cwd(),
      sessionId: handle.sessionId,
      permissionMode: 'default',
      includePartialMessages: false,
      settingSources: ['user', 'project', 'local'],
    });
    expect(options.resume).toBeUndefined();
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.canUseTool).toBeTypeOf('function');
  });

  it('the CLI runs under the supervisor in its own process group with a PID row', async () => {
    const { adapter, events, supervisor, sdk } = make(() => [{ text: 'hi' }]);
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    const proc = supervisor.get('a-1')!;
    expect(proc.state).toBe('running');
    expect(sdk.children[0]!.pid).toBe(proc.pid);
    expect(supervisor.processRecord('a-1')).toMatchObject({
      status: 'running',
      meta: { runtime: 'claude-sdk' },
    });
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(proc.pid)], {
      encoding: 'utf8',
    }).trim();
    expect(Number(pgid)).toBe(proc.pid);
  });

  it('a denied tool call never runs and is explained in the transcript', async () => {
    const { adapter, events } = make(() => [
      { tool: 'Write', input: { file_path: 'x' } },
      { text: 'skipped' },
    ]);
    await adapter.spawn(spawnOpts('write'));
    await events.waitFor(has('agent.idle'));
    expect(types(events.items)).toEqual([
      'agent.output',
      'agent.output',
      'agent.output',
      'agent.idle',
    ]);
    expect(events.items[0]).toMatchObject({
      kind: 'text',
      text: 'permission denied for Write: edit_workspace is denied',
    });
    expect(events.items[1]).toMatchObject({
      kind: 'tool',
      text: expect.stringContaining("tool error: The user doesn't want to proceed"),
    });
    expect(events.items.some((e) => e.type === 'agent.tool_call')).toBe(false);
  });

  it('a turn that ends in an SDK error result is reported and still goes idle', async () => {
    const { adapter, events } = make(() => [
      { text: 'trying' },
      { resultError: 'error_max_turns', errors: ['too many turns'] },
    ]);
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(events.items[1]).toMatchObject({
      type: 'agent.output',
      text: 'turn ended with error_max_turns: too many turns',
    });
  });
});

describe('ClaudeSdkAdapter — questions', () => {
  it('a gate "ask" becomes a permission question; allow runs the tool, no refuses it', async () => {
    const { adapter, events } = make(() => [
      { tool: 'Bash', input: { command: 'rm -rf dist' }, result: 'removed' },
      { tool: 'Bash', input: { command: 'rm -rf node_modules' } },
      { text: 'done' },
    ]);
    await adapter.spawn(spawnOpts('clean up'));
    await events.waitFor(has('agent.needs_input'));
    const q1 = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    expect(q1).toMatchObject({
      kind: 'permission',
      question: {
        text: 'Claude wants to run Bash',
        toolCall: { toolName: 'Bash', input: { command: 'rm -rf dist' } },
        permissionAction: 'destructive',
      },
    });
    expect(q1.questionId).toMatch(/^q-/);
    await adapter.answer(q1.questionId, 'allow');
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.needs_input').length === 2);
    const q2 = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.answer(q2.questionId, 'no');
    await events.waitFor(has('agent.idle'));
    const t = types(events.items);
    expect(t).toEqual([
      'agent.needs_input',
      'agent.tool_call',
      'agent.output',
      'agent.needs_input',
      'agent.output',
      'agent.output',
      'agent.idle',
    ]);
    expect(events.items[1]).toMatchObject({
      type: 'agent.tool_call',
      toolName: 'Bash',
      input: { command: 'rm -rf dist' },
    });
    expect(events.items[4]).toMatchObject({
      kind: 'tool',
      text: expect.stringContaining('The user refused: no'),
    });
    await expect(adapter.answer(q1.questionId, 'again')).rejects.toThrow(/no pending question/);
  });

  it('AskUserQuestion becomes a clarification with the option labels and is answered through updatedInput', async () => {
    const { adapter, events } = make(() => [
      { askUser: { question: 'Which format?', options: ['ISO', 'US'] } },
      { text: 'ok' },
    ]);
    await adapter.spawn(spawnOpts('ask me'));
    await events.waitFor(has('agent.needs_input'));
    const q = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    expect(q).toMatchObject({
      kind: 'clarification',
      question: { text: 'Which format?', options: ['ISO', 'US'] },
    });
    expect(q.question.toolCall).toBeUndefined();
    await adapter.answer(q.questionId, 'ISO');
    await events.waitFor(has('agent.idle'));
    expect(events.items.find((e) => e.type === 'agent.output' && e.kind === 'tool')).toMatchObject({
      text: expect.stringContaining('"Which format?":"ISO"'),
    });
    expect(events.items.some((e) => e.type === 'agent.tool_call')).toBe(false); // a question is not a tool call
  });

  it('a question pending when the turn is interrupted is withdrawn', async () => {
    const { adapter, events } = make(() => [
      { tool: 'Bash', input: { command: 'rm x' } },
      { text: 'after' },
    ]);
    const h = await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.needs_input'));
    const q = events.items.at(-1) as Extract<AgentEvent, { type: 'agent.needs_input' }>;
    await adapter.interrupt(h.sessionId);
    await events.waitFor(has('agent.idle'));
    await expect(adapter.answer(q.questionId, 'allow')).rejects.toThrow(/no pending question/);
    expect(events.items.some((e) => e.type === 'agent.tool_call')).toBe(false);
  });
});

describe('ClaudeSdkAdapter — turns, interrupt, send', () => {
  it('send starts the next turn when idle and rejects mid-turn without interrupt', async () => {
    const { adapter, events } = make((m) => [{ delayMs: 60 }, { text: `echo ${m}` }]);
    const h = await adapter.spawn(spawnOpts('one'));
    await expect(adapter.send(h.sessionId, 'two')).rejects.toThrow(/mid-turn/);
    await events.waitFor(has('agent.idle'));
    await adapter.send(h.sessionId, 'two');
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.idle').length === 2);
    expect(
      events.items
        .filter((e) => e.type === 'agent.output')
        .map((e) => (e as { text: string }).text),
    ).toEqual(['echo one', 'echo two']);
    // Cost is cumulative across turns, as the real SDK reports it.
    expect((events.items.at(-1) as { cost: { usd: number } }).cost.usd).toBeCloseTo(0.02);
  });

  it('an interrupting send cancels the turn (idle, no failure) and starts the new one', async () => {
    const { adapter, events } = make((m) =>
      m === 'slow' ? [{ delayMs: 400 }, { text: 'never' }] : [{ text: `echo ${m}` }],
    );
    const h = await adapter.spawn(spawnOpts('slow'));
    await sleep(30);
    await adapter.send(h.sessionId, 'urgent', { interrupt: true });
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.idle').length === 2);
    expect(types(events.items)).toEqual(['agent.idle', 'agent.output', 'agent.idle']);
    expect(events.items[1]).toMatchObject({ text: 'echo urgent' });
    expect(events.items.some((e) => e.type === 'agent.failed')).toBe(false);
  });

  it('interrupt() alone ends the turn with idle', async () => {
    const { adapter, events } = make(() => [{ delayMs: 400 }, { text: 'never' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await sleep(30);
    await adapter.interrupt(h.sessionId);
    await events.waitFor(has('agent.idle'));
    expect(types(events.items)).toEqual(['agent.idle']);
  });
});

describe('ClaudeSdkAdapter — pause, stop, crash, resume', () => {
  it('pause SIGSTOPs the CLI group and resume SIGCONTs it', async () => {
    const { adapter, events, supervisor } = make(() => [{ delayMs: 300 }, { text: 'late' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await adapter.pause(h.sessionId);
    await adapter.pause(h.sessionId); // idempotent
    await sleep(50);
    const pid = supervisor.get('a-1')!.pid;
    expect(
      execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    ).toMatch(/^T/);
    await adapter.resume(h.sessionId);
    await sleep(50);
    expect(
      execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
    ).not.toMatch(/^T/);
    await events.waitFor(has('agent.idle'));
    expect(types(events.items)).toEqual([
      'agent.paused',
      'agent.resumed',
      'agent.output',
      'agent.idle',
    ]);
  });

  it('stop runs the graceful sequence and ends with exactly one agent.stopped', async () => {
    const { adapter, events, supervisor } = make((m) =>
      m === 'long' ? [{ delayMs: 2_000 }, { text: 'never' }] : [{ text: 'hi' }],
    );
    const h = await adapter.spawn(spawnOpts('long'));
    await sleep(30);
    await adapter.stop(h.sessionId);
    await events.waitFor(has('agent.stopped'));
    await sleep(100);
    expect(types(events.items)).toEqual(['agent.stopped']);
    expect(supervisor.get('a-1')?.state).toBe('exited');
    expect(supervisor.processRecord('a-1')?.status).toBe('exited');
    await expect(adapter.send(h.sessionId, 'x')).rejects.toThrow(/has stopped/);
    await adapter.stop(h.sessionId); // no-op
  });

  it('stop while idle and while paused also ends cleanly', async () => {
    const { adapter, events } = make(() => [{ delayMs: 300 }, { text: 'hi' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await adapter.pause(h.sessionId);
    await adapter.stop(h.sessionId);
    await events.waitFor(has('agent.stopped'));
    expect(types(events.items)).toEqual(['agent.paused', 'agent.stopped']);
  });

  it('a CLI that dies is one agent.failed(crash), nothing after', async () => {
    const { adapter, events, supervisor } = make(() => [{ delayMs: 2_000 }, { text: 'never' }]);
    await adapter.spawn(spawnOpts('x'));
    await sleep(30);
    process.kill(supervisor.get('a-1')!.pid, 'SIGKILL');
    await events.waitFor(has('agent.failed'));
    await sleep(100);
    expect(events.items).toEqual([
      {
        type: 'agent.failed',
        agentId: 'a-1',
        error: 'claude exited unexpectedly (SIGKILL)',
        reason: 'crash',
      },
    ]);
  });

  it('resumeSession re-opens the session id with `resume` and no fresh session id', async () => {
    const { adapter, events, sdk } = make(() => [{ text: 'back' }]);
    const h = await adapter.resumeSession(
      '11111111-2222-3333-4444-555555555555',
      spawnOpts('what was it?'),
    );
    expect(h).toEqual({
      sessionId: '11111111-2222-3333-4444-555555555555',
      sessionRef: '11111111-2222-3333-4444-555555555555',
    });
    await events.waitFor(has('agent.idle'));
    expect(sdk.calls[0]!.options).toMatchObject({ resume: '11111111-2222-3333-4444-555555555555' });
    expect(sdk.calls[0]!.options.sessionId).toBeUndefined();
    await expect(adapter.resumeSession('fake:x:y:0', spawnOpts('x'))).rejects.toThrow(
      /not a claude-sdk session ref/,
    );
  });
});

describe('ClaudeSdkAdapter — brains, bare, tools', () => {
  it('a brain gets its own system prompt, no setting sources and its tools as an in-process MCP server', async () => {
    const calls: unknown[] = [];
    const { adapter, events, sdk } = make(() => [{ text: 'planned' }]);
    await adapter.spawn(
      spawnOpts('plan', {
        role: 'waykeeper',
        systemPrompt: 'You are the Waykeeper.',
        tools: [
          {
            name: 'get_agent_status',
            description: 'Status of an agent',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string', description: 'the id' },
                verbose: { type: 'boolean' },
              },
              required: ['agentId'],
            },
            handler: async (input) => {
              calls.push(input);
              return { state: 'working' };
            },
          },
        ],
      }),
    );
    await events.waitFor(has('agent.idle'));
    const options = sdk.calls[0]!.options;
    expect(options.systemPrompt).toBe('You are the Waykeeper.');
    expect(options.settingSources).toEqual([]);
    expect(options.allowedTools).toEqual(['mcp__galactic__get_agent_status']);
    expect(sdk.servers[0]?.name).toBe('galactic');
    const tool = sdk.tools[0]!;
    expect(tool.name).toBe('get_agent_status');
    const out = await tool.handler({ agentId: 'a-9' });
    expect(out).toEqual({ content: [{ type: 'text', text: '{"state":"working"}' }] });
    expect(calls).toEqual([{ agentId: 'a-9' }]);
  });

  it('a steward with a system prompt appends it to the Claude Code preset', async () => {
    const { adapter, events, sdk } = make(() => [{ text: 'ok' }]);
    await adapter.spawn(spawnOpts('x', { systemPrompt: 'Work in this worktree only.' }));
    await events.waitFor(has('agent.idle'));
    expect(sdk.calls[0]!.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Work in this worktree only.',
    });
  });

  it('bare needs an API key and passes --bare', async () => {
    const without = make(() => [{ text: 'x' }]);
    await expect(without.adapter.spawn(spawnOpts('x', { bare: true }))).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
    const withKey = make(() => [{ text: 'x' }], {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000000000' },
    });
    await withKey.adapter.spawn(spawnOpts('x', { bare: true }));
    await withKey.events.waitFor(has('agent.idle'));
    expect(withKey.sdk.calls[0]!.options.extraArgs).toEqual({ bare: null });
    expect(withKey.sdk.calls[0]!.options.env?.['ANTHROPIC_API_KEY']).toBe(
      'sk-ant-test-0000000000000000000000',
    );
  });

  it('converts JSON Schema tool inputs to a zod shape the SDK accepts', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'who' },
        kind: { type: 'string', enum: ['planet', 'moon'] },
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        anything: {},
      },
      required: ['name', 'kind'],
    }) as Record<string, ZodTypeAny>;
    expect(Object.keys(shape)).toEqual(['name', 'kind', 'count', 'tags', 'nested', 'anything']);
    expect(shape['name']!.safeParse('x').success).toBe(true);
    expect(shape['name']!.safeParse(undefined).success).toBe(false);
    expect(shape['kind']!.safeParse('asteroid').success).toBe(false);
    expect(shape['count']!.safeParse(undefined).success).toBe(true);
    expect(shape['count']!.safeParse(1.5).success).toBe(false);
    expect(shape['tags']!.safeParse(['a']).success).toBe(true);
    expect(shape['nested']!.safeParse({ ok: true }).success).toBe(true);
    expect(shape['nested']!.safeParse({}).success).toBe(false);
    expect(shape['name']!.description).toBe('who');
  });
});

describe('ClaudeSdkAdapter — without a child process (pure in-process SDK)', () => {
  it('finishes when the stream ends on its own', async () => {
    const { adapter, events } = make(() => [{ text: 'bye' }], { spawnChild: false });
    const h = await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    await adapter.stop(h.sessionId);
    await events.waitFor(has('agent.stopped'));
    expect(types(events.items)).toEqual(['agent.output', 'agent.idle', 'agent.stopped']);
  });
});
