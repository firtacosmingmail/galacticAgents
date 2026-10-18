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
import { FakeSdk, type FakeScript, type FakeSdkOptions } from './fake-sdk.js';
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
  opts: {
    spawnChild?: boolean;
    env?: Record<string, string | undefined>;
    fake?: Omit<FakeSdkOptions, 'script' | 'spawnChild'>;
    stewardSettingSources?: ('user' | 'project' | 'local')[];
  } = {},
) {
  const sdk = new FakeSdk({
    script,
    ...(opts.spawnChild === false ? { spawnChild: false } : {}),
    ...opts.fake,
  });
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 500, termMs: 300 } });
  const errors: { error: unknown; context: string }[] = [];
  const adapter = new ClaudeSdkAdapter({
    supervisor,
    sdk,
    graceMs: 500,
    streamEndGraceMs: 150,
    onError: (error, context) => errors.push({ error, context }),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.stewardSettingSources ? { stewardSettingSources: opts.stewardSettingSources } : {}),
  });
  const events = collect<AgentEvent>(adapter.events);
  rigs.push({ adapter, supervisor });
  return { sdk, supervisor, adapter, events, errors };
}

type NeedsInput = Extract<AgentEvent, { type: 'agent.needs_input' }>;
const questions = (events: AgentEvent[]) =>
  events.filter((e): e is NeedsInput => e.type === 'agent.needs_input');
const procStat = (pid: number) =>
  execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();
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

  it("loads the configured settings for a Steward (the real-Claude checks exclude the user's own)", async () => {
    const { adapter, events, sdk } = make(() => [{ text: 'hi' }], {
      stewardSettingSources: ['project', 'local'],
    });
    await adapter.spawn(spawnOpts('hello'));
    await events.waitFor(has('agent.idle'));
    expect(sdk.calls[0]!.options.settingSources).toEqual(['project', 'local']);
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
  it('two permission requests at once (parallel tool calls) are both pending and both answerable', async () => {
    // The real CLI calls canUseTool for parallel tool calls concurrently (two WebSearch calls in one
    // turn). One pending slot per session let the second overwrite the first: answering the first
    // threw "no pending question" (a 500 in the panel) and its tool call waited forever.
    const { sdk, adapter, events } = make(() => [{ delayMs: 200 }, { text: 'done' }]);
    await adapter.spawn(spawnOpts('search twice'));
    await events.waitFor(() => sdk.calls.length > 0);
    const canUseTool = sdk.calls[0]!.options.canUseTool!;
    const signal = new AbortController().signal;
    const first = canUseTool('WebSearch', { query: 'a' }, { signal, toolUseID: 'tu-1' });
    const second = canUseTool('WebSearch', { query: 'b' }, { signal, toolUseID: 'tu-2' });
    await events.waitFor((e) => e.filter((x) => x.type === 'agent.needs_input').length === 2);
    const [q1, q2] = events.items.filter((x) => x.type === 'agent.needs_input') as Extract<
      AgentEvent,
      { type: 'agent.needs_input' }
    >[];
    await adapter.answer(q1!.questionId, 'allow');
    await adapter.answer(q2!.questionId, 'no');
    await expect(first).resolves.toMatchObject({ behavior: 'allow' });
    await expect(second).resolves.toMatchObject({ behavior: 'deny' });
    await expect(adapter.answer(q1!.questionId, 'again')).rejects.toThrow(/no pending question/);
  });

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

  it('a dismissed AskUserQuestion is refused with what the user did (P9-14)', async () => {
    const { adapter, events } = make(() => [
      { askUser: { question: 'Which format?' } },
      { text: 'carrying on' },
    ]);
    await adapter.spawn(spawnOpts('ask me'));
    await events.waitFor((e) => questions(e).length === 1);
    const [q] = questions(events.items);
    await adapter.dismiss(q!.questionId, 'dismissed by the user');
    await events.waitFor(has('agent.idle'));
    expect(questions(events.items)).toHaveLength(1);
    const result = events.items.find((e) => e.type === 'agent.output' && e.kind === 'tool');
    expect(result).toMatchObject({
      text: expect.stringContaining(
        'The user did not answer this question: it was dismissed by the user. Do not wait',
      ),
    });
    expect(events.items.some((e) => e.type === 'agent.output' && e.text === 'carrying on')).toBe(
      true,
    );
    await expect(adapter.dismiss(q!.questionId, 'again')).rejects.toThrow(/no pending question/);
  });

  it('a dismissed permission request is denied, never run (P9-14)', async () => {
    const { adapter, events } = make(() => [
      { tool: 'Bash', input: { command: 'rm -rf dist' }, result: 'removed' },
      { text: 'done' },
    ]);
    await adapter.spawn(spawnOpts('clean up'));
    await events.waitFor(has('agent.needs_input'));
    const q = questions(events.items)[0]!;
    await adapter.dismiss(q.questionId, 'dismissed by the user');
    await events.waitFor(has('agent.idle'));
    expect(events.items.some((e) => e.type === 'agent.tool_call')).toBe(false);
    expect(events.items.find((e) => e.type === 'agent.output' && e.kind === 'tool')).toMatchObject({
      text: expect.stringContaining('The user refused: the permission request was dismissed'),
    });
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

  it("tells the gate each MCP call's server and provenance; a brain loads no other server", async () => {
    const seen: ToolCall[] = [];
    const tool = {
      name: 'declare_deliverable',
      description: 'Declare',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => 'ok',
    };
    const { adapter, events, sdk } = make(() => [
      { tool: 'mcp__galactic__declare_deliverable', input: {} },
      // A repository's `.mcp.json` server named `galactic` (the CLI reports its source).
      {
        tool: 'mcp__galactic__declare_deliverable',
        input: {},
        mcpServer: { name: 'galactic', source: 'project' },
      },
      { tool: 'Read', input: { file_path: 'a' } },
      { text: 'done' },
    ]);
    await adapter.spawn(
      spawnOpts('declare', {
        tools: [tool],
        gate: gate(
          {
            mcp__galactic__declare_deliverable: { decision: 'allow' },
            Read: { decision: 'allow' },
          },
          seen,
        ),
      }),
    );
    await events.waitFor(has('agent.idle'));
    expect(seen.map((c) => c.mcpServer)).toEqual([
      { name: 'galactic', source: 'sdk' },
      { name: 'galactic', source: 'project' },
      undefined,
    ]);
    // A Steward keeps the repository's servers; a brain gets none but its own.
    expect(sdk.calls[0]!.options.strictMcpConfig).toBeUndefined();
    const brain = make(() => [{ text: 'ok' }]);
    await brain.adapter.spawn(spawnOpts('x', { role: 'harmonizer', tools: [tool] }));
    await brain.events.waitFor(has('agent.idle'));
    expect(brain.sdk.calls[0]!.options.strictMcpConfig).toBe(true);
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

describe('ClaudeSdkAdapter — the gate, once per toolUseId (P1-30)', () => {
  it('an asked call is checked once and reported as one tool_call', async () => {
    const seen: ToolCall[] = [];
    const { adapter, events } = make(() => [
      { tool: 'Bash', input: { command: 'rm -rf dist' } },
      { text: 'done' },
    ]);
    await adapter.spawn(
      spawnOpts('x', {
        gate: gate({ Bash: { decision: 'ask', action: 'destructive', reasons: ['rm'] } }, seen),
      }),
    );
    await events.waitFor(has('agent.needs_input'));
    await adapter.answer(questions(events.items)[0]!.questionId, 'allow');
    await events.waitFor(has('agent.idle'));
    expect(seen).toHaveLength(1);
    expect(events.items.filter((e) => e.type === 'agent.tool_call')).toHaveLength(1);
  });

  it('a hook allow is reused when the CLI also calls canUseTool: no second check or tool_call', async () => {
    const seen: ToolCall[] = [];
    const { adapter, events } = make(
      () => [
        { tool: 'Read', input: { file_path: 'a' } },
        { tool: 'Read', input: { file_path: 'b' } },
      ],
      { fake: { canUseToolAfterAllow: true } },
    );
    await adapter.spawn(spawnOpts('x', { gate: gate({ Read: { decision: 'allow' } }, seen) }));
    await events.waitFor(has('agent.idle'));
    expect(seen).toHaveLength(2); // one per call, not two
    const calls = events.items.filter((e) => e.type === 'agent.tool_call');
    expect(calls.map((c) => (c as { toolUseId?: string }).toolUseId)).toEqual([
      'toolu_1_Read',
      'toolu_1_Read_2',
    ]);
  });

  it('a gate that throws denies the call (hook) and reports the error', async () => {
    const throwing: PermissionGate = {
      check() {
        throw new Error('policy table corrupt');
      },
    };
    const { adapter, events, errors } = make(() => [
      { tool: 'Bash', input: { command: 'ls' }, result: 'ran' },
      { text: 'after' },
    ]);
    await adapter.spawn(spawnOpts('x', { gate: throwing }));
    await events.waitFor(has('agent.idle'));
    expect(events.items.some((e) => e.type === 'agent.tool_call')).toBe(false);
    expect(events.items.some((e) => e.type === 'agent.needs_input')).toBe(false);
    expect(events.items.find((e) => e.type === 'agent.output' && e.kind === 'tool')).toMatchObject({
      text: expect.stringContaining('permission check failed: policy table corrupt'),
    });
    expect(errors.map((e) => e.context)).toContain('PreToolUse a-1');
  });

  it('canUseTool without a hook verdict asks the gate itself, and a throwing gate denies there too', async () => {
    const seen: ToolCall[] = [];
    let explode = false;
    const g: PermissionGate = {
      check(call) {
        seen.push(call);
        if (explode) throw new Error('boom');
        return { decision: 'allow' };
      },
    };
    const { adapter, events, sdk } = make(() => [{ delayMs: 200 }]);
    await adapter.spawn(spawnOpts('x', { gate: g }));
    const canUseTool = sdk.calls[0]!.options.canUseTool!;
    const signal = new AbortController().signal;
    await expect(canUseTool('Read', { file_path: 'a' }, { signal })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'a' },
    });
    expect(seen).toHaveLength(1);
    explode = true;
    await expect(canUseTool('Read', { file_path: 'b' }, { signal })).resolves.toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('boom'),
    });
    await events.waitFor(has('agent.idle'));
    expect(events.items.filter((e) => e.type === 'agent.tool_call')).toHaveLength(1);
  });
});

describe('ClaudeSdkAdapter — the query loop ends with the CLI alive (P1-32)', () => {
  it('a stream that throws mid-turn fails the session and stops the CLI', async () => {
    const { adapter, events, supervisor } = make(() => [
      { text: 'working' },
      { throwStream: 'socket hang up' },
    ]);
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.failed'));
    expect(events.items.at(-1)).toMatchObject({
      type: 'agent.failed',
      reason: 'runtime',
      error: 'socket hang up',
    });
    await supervisor.get('a-1')!.exited;
    await sleep(50);
    expect(types(events.items)).toEqual(['agent.output', 'agent.failed']);
    expect(adapter.sessionCount).toBe(0);
  });

  it('a stream that throws while interrupting fails the session instead of wedging it', async () => {
    const { adapter, events, supervisor } = make(() => [{ delayMs: 2_000 }], {
      fake: { throwOnInterrupt: true },
    });
    const h = await adapter.spawn(spawnOpts('x'));
    await sleep(30);
    await adapter.interrupt(h.sessionId);
    await events.waitFor(has('agent.failed'));
    expect(events.items.at(-1)).toMatchObject({ type: 'agent.failed', reason: 'runtime' });
    await supervisor.get('a-1')!.exited;
    await expect(adapter.send(h.sessionId, 'more')).rejects.toThrow(/has failed/);
  });

  it('a stop whose interrupt never settles still ends the CLI and reports agent.stopped', async () => {
    const { adapter, events, supervisor, sdk } = make(() => [{ delayMs: 5_000 }], {
      fake: { wedgeOnInterrupt: true },
    });
    const h = await adapter.spawn(spawnOpts('x'));
    await sleep(30);
    const started = Date.now();
    await adapter.stop(h.sessionId, { graceMs: 200 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sdk.interrupts).toBe(1);
    expect(types(events.items)).toEqual(['agent.stopped']);
    expect(supervisor.get('a-1')?.state).toBe('exited');
  });
});

describe('ClaudeSdkAdapter — mapping gaps (P1-36)', () => {
  it('AskUserQuestion with several questions is one question set: every row at once, one result after the last answer (P8-20)', async () => {
    const { adapter, events } = make(() => [
      {
        askUsers: [
          { question: 'Which format?', options: ['ISO', 'US'] },
          { question: 'Which fields?', options: ['date', 'time', 'zone'], multiSelect: true },
          { question: 'Anything else?' },
        ],
      },
      { text: 'ok' },
    ]);
    await adapter.spawn(spawnOpts('ask me'));
    await events.waitFor((e) => questions(e).length === 3);
    const [q1, q2, q3] = questions(events.items);
    const setId = q1!.question.set?.id;
    expect(setId).toMatch(/^qs-/);
    expect(q1).toMatchObject({
      kind: 'clarification',
      question: {
        text: 'Which format?',
        options: ['ISO', 'US'],
        set: { id: setId, index: 0, total: 3, title: 'Questions from the Steward' },
      },
    });
    expect(q1!.question.multiSelect).toBeUndefined();
    // Multi-select is native on the card: no "(separate the labels with commas)" suffix.
    expect(q2!.question).toEqual({
      text: 'Which fields?',
      options: ['date', 'time', 'zone'],
      multiSelect: true,
      set: { id: setId, index: 1, total: 3, title: 'Questions from the Steward' },
    });
    expect(q3!.question).toEqual({
      text: 'Anything else?',
      set: { id: setId, index: 2, total: 3, title: 'Questions from the Steward' },
    });
    const toolResult = () =>
      events.items.find((e) => e.type === 'agent.output' && e.kind === 'tool');
    // Answered out of order; the tool result waits for every row.
    await adapter.answer(q2!.questionId, 'date, zone');
    await adapter.answer(q1!.questionId, 'US');
    await sleep(50);
    expect(toolResult()).toBeUndefined();
    await adapter.answer(q3!.questionId, '(skipped by the user)');
    await events.waitFor(has('agent.idle'));
    expect(toolResult()).toMatchObject({
      text: expect.stringContaining(
        JSON.stringify({
          'Which format?': 'US',
          'Which fields?': 'date, zone',
          'Anything else?': '(skipped by the user)',
        }),
      ),
    });
    expect(questions(events.items)).toHaveLength(3);
  });

  it('one dismissed row of a question set refuses the whole AskUserQuestion call (P8-20)', async () => {
    const { adapter, events } = make(() => [
      { askUsers: [{ question: 'Which format?' }, { question: 'Which fields?' }] },
      { text: 'carrying on' },
    ]);
    await adapter.spawn(spawnOpts('ask me'));
    await events.waitFor((e) => questions(e).length === 2);
    const [q1, q2] = questions(events.items);
    await adapter.dismiss(q1!.questionId, 'dismissed by the user');
    await adapter.answer(q2!.questionId, 'all of them');
    await events.waitFor(has('agent.idle'));
    const result = events.items.find((e) => e.type === 'agent.output' && e.kind === 'tool');
    expect(result).toMatchObject({
      text: expect.stringContaining(
        'The user did not answer this question: it was dismissed by the user. Do not wait',
      ),
    });
    expect(questions(events.items)).toHaveLength(2);
  });

  it('an interrupt while a question set is open withdraws every row and ends the turn (P8-20)', async () => {
    const { adapter, events } = make(() => [
      { askUsers: [{ question: 'A?' }, { question: 'B?' }, { question: 'C?' }] },
      { text: 'never' },
    ]);
    const h = await adapter.spawn(spawnOpts('ask me'));
    await events.waitFor((e) => questions(e).length === 3);
    const [q1, q2, q3] = questions(events.items);
    await adapter.answer(q1!.questionId, 'yes');
    await adapter.interrupt(h.sessionId);
    await events.waitFor(has('agent.idle'));
    expect(events.items.some((e) => e.type === 'agent.output' && e.kind === 'tool')).toBe(false);
    expect(events.items.some((e) => e.type === 'agent.output' && e.text === 'never')).toBe(false);
    await expect(adapter.answer(q2!.questionId, 'late')).rejects.toThrow(/no pending question/);
    await expect(adapter.answer(q3!.questionId, 'late')).rejects.toThrow(/no pending question/);
  });

  it('interrupt() while paused thaws the CLI first (agent.resumed), then ends the turn', async () => {
    const { adapter, events, supervisor } = make(() => [{ delayMs: 2_000 }, { text: 'never' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await sleep(30);
    await adapter.pause(h.sessionId);
    const pid = supervisor.get('a-1')!.pid;
    await sleep(30);
    expect(procStat(pid)).toMatch(/^T/);
    await adapter.interrupt(h.sessionId);
    await events.waitFor(has('agent.idle'));
    expect(types(events.items)).toEqual(['agent.paused', 'agent.resumed', 'agent.idle']);
    expect(procStat(pid)).not.toMatch(/^T/);
    await adapter.resume(h.sessionId); // already running: no second agent.resumed
    expect(types(events.items).filter((t) => t === 'agent.resumed')).toHaveLength(1);
  });

  it('pause is refused when there is no process to freeze', async () => {
    const { adapter, events } = make(() => [{ delayMs: 200 }], { spawnChild: false });
    const h = await adapter.spawn(spawnOpts('x'));
    await expect(adapter.pause(h.sessionId)).rejects.toThrow(/no claude process to freeze/);
    await events.waitFor(has('agent.idle'));
    expect(events.items.some((e) => e.type === 'agent.paused')).toBe(false);
  });

  it('a stop while paused clears the pause: the CLI exits on its own after SIGCONT', async () => {
    const { adapter, events, supervisor } = make(() => [{ text: 'hi' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    await adapter.pause(h.sessionId);
    await adapter.stop(h.sessionId);
    expect(types(events.items)).toEqual([
      'agent.output',
      'agent.idle',
      'agent.paused',
      'agent.stopped',
    ]);
    expect(supervisor.get('a-1')?.exit).toMatchObject({ code: 0, signal: null });
  });

  it('a success result with is_error: true is reported as an errored turn, then idle', async () => {
    const { adapter, events } = make(() => [
      { text: 'trying' },
      { resultIsError: 'Prompt is too long' },
    ]);
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(events.items.slice(1)).toEqual([
      {
        type: 'agent.output',
        agentId: 'a-1',
        kind: 'text',
        text: 'turn ended with an error: Prompt is too long',
      },
      expect.objectContaining({ type: 'agent.idle' }),
    ]);
  });

  it('the cost counts prompt-cache reads and writes as input tokens', async () => {
    const { adapter, events } = make(() => [{ text: 'hi' }], {
      fake: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1_000,
          cache_creation_input_tokens: 200,
          output_tokens: 5,
        },
      },
    });
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(events.items.at(-1)).toMatchObject({
      type: 'agent.idle',
      cost: { usd: 0.01, inputTokens: 1_210, outputTokens: 5 },
    });
  });

  it('a rate_limit_event becomes a readable agent.progress (nothing while allowed)', async () => {
    const { adapter, events } = make(() => [
      { rateLimit: { status: 'allowed' } },
      { rateLimit: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.92 } },
      { rateLimit: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1_790_000_000 } },
      { text: 'done' },
    ]);
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(
      events.items
        .filter((e) => e.type === 'agent.progress')
        .map((e) => (e as { summary: string }).summary),
    ).toEqual([
      'close to the five hour rate limit (92% used)',
      'waiting on the five hour rate limit until 2026-09-21T14:13:20Z',
    ]);
  });

  it('an idle stop closes the input: the CLI exits on stdin EOF, no SIGTERM', async () => {
    const { adapter, events, supervisor, sdk } = make(() => [{ text: 'hi' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    await adapter.stop(h.sessionId);
    expect(sdk.inputClosed).toBe(1);
    expect(supervisor.get('a-1')?.exit).toMatchObject({ code: 0, signal: null });
    expect(types(events.items)).toEqual(['agent.output', 'agent.idle', 'agent.stopped']);
  });

  it('ended sessions are freed; their late calls are no-ops or say how they ended', async () => {
    const { adapter, events } = make(() => [{ text: 'hi' }]);
    const h = await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(adapter.sessionCount).toBe(1);
    await adapter.stop(h.sessionId);
    expect(adapter.sessionCount).toBe(0);
    await adapter.interrupt(h.sessionId);
    await adapter.pause(h.sessionId);
    await adapter.resume(h.sessionId);
    await adapter.stop(h.sessionId);
    await expect(adapter.send(h.sessionId, 'x')).rejects.toThrow(/has stopped/);
    await expect(adapter.send('nope', 'x')).rejects.toThrow(/unknown claude-sdk session/);
  });

  it('after a same-agent resume, the old session’s late events are dropped', async () => {
    const { adapter, events } = make(
      (m) => (m === 'old' ? [{ delayMs: 200 }, { text: 'stale' }] : [{ text: 'fresh' }]),
      { spawnChild: false },
    );
    await adapter.spawn(spawnOpts('old'));
    await adapter.resumeSession('11111111-2222-3333-4444-555555555555', spawnOpts('new'));
    await events.waitFor(has('agent.idle'));
    await sleep(300);
    expect(events.items).toEqual([
      { type: 'agent.output', agentId: 'a-1', kind: 'text', text: 'fresh' },
      expect.objectContaining({ type: 'agent.idle' }),
    ]);
  });

  it('a resumed session whose init reports another session id is reported via onError', async () => {
    const { adapter, events, errors } = make(() => [{ text: 'hi' }], {
      fake: { initSessionId: '99999999-0000-0000-0000-000000000000' },
    });
    await adapter.resumeSession('11111111-2222-3333-4444-555555555555', spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(errors).toEqual([
      {
        error: expect.objectContaining({
          message:
            'claude reported session 99999999-0000-0000-0000-000000000000, expected 11111111-2222-3333-4444-555555555555 (resume)',
        }),
        context: 'init a-1',
      },
    ]);
  });

  it('stderr is reported once, by the supervisor capture only', async () => {
    const { adapter, events, sdk } = make(() => [{ text: 'hi' }]);
    await adapter.spawn(spawnOpts('x'));
    await events.waitFor(has('agent.idle'));
    expect(sdk.calls[0]!.options.stderr).toBeUndefined();
  });
});

describe('ClaudeSdkAdapter — slash commands (P8-13)', () => {
  const reported = [
    {
      name: 'compact',
      description: 'Clear history but keep a summary',
      argumentHint: '',
      builtin: true,
    },
    { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
    { name: 'plugin:deploy', description: 'Deploy\nnow', argumentHint: '[env]', aliases: ['ship'] },
  ];
  const idles = (n: number) => (e: AgentEvent[]) =>
    e.filter((x) => x.type === 'agent.idle').length >= n;

  it('maps supportedCommands() after init, caches it, and sends a slash command as the user message', async () => {
    const { adapter, events, sdk } = make((message) => [{ text: `ran ${message}` }], {
      fake: { commands: reported },
    });
    const handle = await adapter.spawn(spawnOpts('hello'));
    await events.waitFor(has('agent.idle'));
    const commands = await adapter.commands(handle.sessionId);
    expect(commands).toEqual([
      { name: 'compact', description: 'Clear history but keep a summary', builtin: true },
      { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
      {
        name: 'plugin:deploy',
        description: 'Deploy now',
        argumentHint: '[env]',
        aliases: ['ship'],
      },
    ]);
    // Prefetched at init, then cached: one call to the CLI.
    expect(await adapter.commands(handle.sessionId)).toBe(commands);
    expect(sdk.commandCalls).toBe(1);
    // A message that starts with `/name` reaches the CLI unchanged: the CLI runs the command.
    await adapter.send(handle.sessionId, '/review 12');
    await events.waitFor(idles(2));
    expect(events.items).toContainEqual({
      type: 'agent.output',
      agentId: 'a-1',
      kind: 'text',
      text: 'ran /review 12',
    });
  });

  it('replaces the cache on a commands_changed push', async () => {
    const { adapter, events } = make(
      (_m, turn) =>
        turn === 2
          ? [{ commandsChanged: [{ name: 'fresh', description: 'new skill', argumentHint: '' }] }]
          : [],
      { fake: { commands: reported } },
    );
    const handle = await adapter.spawn(spawnOpts('hello'));
    await events.waitFor(has('agent.idle'));
    expect(await adapter.commands(handle.sessionId)).toHaveLength(3);
    await adapter.send(handle.sessionId, 'look around');
    await events.waitFor(idles(2));
    expect(await adapter.commands(handle.sessionId)).toEqual([
      { name: 'fresh', description: 'new skill' },
    ]);
  });

  it('gives [] for an SDK without the call, a failing call, and an ended or unknown session', async () => {
    const plain = make(() => []);
    const h1 = await plain.adapter.spawn(spawnOpts('hello'));
    await plain.events.waitFor(has('agent.idle'));
    expect(await plain.adapter.commands(h1.sessionId)).toEqual([]);

    const failing = make(() => [], {
      fake: {
        commands: () => {
          throw new Error('control request failed');
        },
      },
    });
    const h2 = await failing.adapter.spawn(spawnOpts('hello', { agentId: 'a-2' }));
    await failing.events.waitFor(has('agent.idle'));
    expect(await failing.adapter.commands(h2.sessionId)).toEqual([]);
    expect(failing.errors.some((e) => e.context.startsWith('supportedCommands'))).toBe(true);

    await failing.adapter.stop(h2.sessionId);
    expect(await failing.adapter.commands(h2.sessionId)).toEqual([]);
    expect(await failing.adapter.commands('nope')).toEqual([]);
  });

  it("shows a local command's output: the stdout message, or the result of a turn that said nothing else (review S4)", async () => {
    const { adapter, events } = make((message) => {
      if (message === '/context') return [{ localCommand: 'Context: 12k / 200k tokens' }];
      if (message === '/cost')
        return [
          { localCommand: 'Total cost: $0.12' },
          { resultText: '<local-command-stdout>Total cost: $0.12</local-command-stdout>' },
        ];
      if (message === '/usage') return [{ resultText: 'Session: 3 turns' }];
      return [{ text: `said ${message}` }];
    });
    const handle = await adapter.spawn(spawnOpts('hello'));
    await events.waitFor(has('agent.idle'));
    for (const [i, command] of ['/context', '/cost', '/usage'].entries()) {
      await adapter.send(handle.sessionId, command);
      await events.waitFor(idles(i + 2));
    }
    const texts = events.items
      .filter((e) => e.type === 'agent.output' && e.kind === 'text')
      .map((e) => (e as Extract<AgentEvent, { type: 'agent.output' }>).text);
    // One line each: the stdout tags stripped; a result is not repeated after its stdout, and an
    // ordinary turn's result (its last text) is not repeated either.
    expect(texts).toEqual([
      'said hello',
      'Context: 12k / 200k tokens',
      'Total cost: $0.12',
      'Session: 3 turns',
    ]);
  });
});
