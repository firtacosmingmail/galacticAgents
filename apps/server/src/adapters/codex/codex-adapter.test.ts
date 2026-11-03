import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  GateCheckOptions,
  GateVerdict,
  ToolCall,
  ToolDefinition,
} from '@galactic/protocol';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { APP_SERVER_ARGS, CodexAdapter } from './codex-adapter.js';
import { FAKE_CODEX_AGENT } from './fake-agent.js';
import { commandCall, unwrapShell } from './mapping.js';
import { isUsageLimit, limitResetsAt } from './limits.js';
import { KNOWN_CODEX_VERSIONS } from './preflight.js';

/**
 * The Codex adapter on its own (P11-04), against the fake Codex CLI (`fake-codex-agent.mjs`, a
 * real child process speaking app-server JSON-RPC): the safe settings it starts with, every
 * approval through the gate (never for the session), the server's tools as dynamic tools, MCP
 * elicitations declined, the usage limit as the one terminal event, the model, the preflight, the
 * model list and the usage, and the P11-01 transcripts replayed.
 */

const cwd = mkdtempSync(join(tmpdir(), 'galactic-codex-unit-'));
writeFileSync(join(cwd, 'README.md'), '# unit\n');
const state = mkdtempSync(join(tmpdir(), 'galactic-codex-unit-state-'));
const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 100 };

type Verdict = (call: ToolCall) => GateVerdict;

interface Rig {
  adapter: CodexAdapter;
  supervisor: ProcessSupervisor;
  events: AgentEvent[];
  checks: ToolCall[];
  reserves: boolean[];
  /** The fake's record: argv, then every message the adapter sent. */
  recordFile: string;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.adapter.dispose();
    await r.supervisor.dispose();
  }
});

function rig(env: Record<string, string> = {}): Rig {
  const recordFile = join(mkdtempSync(join(tmpdir(), 'galactic-codex-record-')), 'record.jsonl');
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  const adapter = new CodexAdapter({
    supervisor,
    command: process.execPath,
    args: [FAKE_CODEX_AGENT, '--state', state, '--record', recordFile],
    env,
    graceMs: 2_000,
    startTimeoutMs: 10_000,
  });
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of adapter.events) events.push(e);
  })();
  const r: Rig = { adapter, supervisor, events, checks: [], reserves: [], recordFile };
  rigs.push(r);
  return r;
}

const allowAll: Verdict = () => ({ decision: 'allow' });
const askAll: Verdict = () => ({ decision: 'ask', action: 'destructive', reasons: ['asks'] });

function spawnOpts(
  r: Rig,
  prompt: string,
  verdict: Verdict = allowAll,
  extra: { tools?: ToolDefinition[]; model?: string } = {},
) {
  return {
    agentId: `a-${Math.random()}`,
    role: 'steward' as const,
    cwd,
    prompt,
    caps: CAPS,
    ...extra,
    gate: {
      check: (call: ToolCall, opts?: GateCheckOptions) => {
        r.checks.push(call);
        r.reserves.push(opts?.reserve ?? true);
        return verdict(call);
      },
    },
  };
}

interface Recorded {
  argv?: string[];
  in?: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
}
const recorded = (r: Rig): Recorded[] =>
  existsSync(r.recordFile)
    ? readFileSync(r.recordFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Recorded)
    : [];
const sent = (r: Rig, method: string) =>
  recorded(r)
    .map((e) => e.in)
    .filter((m) => m?.method === method)
    .map((m) => m!.params ?? {});
/** The adapter's replies to server requests. */
const replies = (r: Rig) =>
  recorded(r)
    .map((e) => e.in)
    .filter((m) => m && m.method === undefined && m.id !== undefined && 'result' in m)
    .map((m) => m!.result as Record<string, unknown>);

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
const terminals = (r: Rig) =>
  r.events.filter((e) => ['agent.finished', 'agent.failed', 'agent.stopped'].includes(e.type));

describe('CodexAdapter', () => {
  it('starts with the safe settings', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:echo'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    const argv = recorded(r)[0]!.argv!;
    expect(argv[0]).toBe('app-server');
    for (const feature of ['plugins', 'apps', 'image_generation', 'browser_use', 'computer_use']) {
      expect(argv.join(' ')).toContain(`--disable ${feature}`);
    }
    expect(argv).toEqual(['app-server', ...APP_SERVER_ARGS]);
    const init = sent(r, 'initialize')[0]!;
    expect(init['capabilities']).toMatchObject({ experimentalApi: true });
    const start = sent(r, 'thread/start')[0]!;
    expect(start['approvalPolicy']).toBe('untrusted');
    expect(start['approvalsReviewer']).toBe('user');
    expect(start['sandbox']).toBe('workspace-write');
    expect(start['cwd']).toBe(cwd);
    const config = start['config'] as Record<string, unknown>;
    expect(config['web_search']).toBe('disabled');
    expect(config['mcp_servers']).toEqual({});
    expect(config['sandbox_workspace_write']).toEqual({ network_access: false });
    expect(config['features']).toMatchObject({
      apps: false,
      plugins: false,
      image_generation: false,
    });
    const turn = sent(r, 'turn/start')[0]!;
    expect(turn['approvalPolicy']).toBe('untrusted');
    expect(turn['sandboxPolicy']).toMatchObject({ type: 'workspaceWrite', networkAccess: false });
  });

  it('command approval asks the gate', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:permission', askAll));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    const q = of(r, 'agent.needs_input')[0]!;
    expect(q.kind).toBe('permission');
    expect(q.question.toolCall?.toolName).toBe('Bash');
    expect(q.question.toolCall?.input).toEqual({ command: `rm -r ${join(cwd, 'build')}` });
    expect(q.question.permissionAction).toBe('destructive');
    expect(of(r, 'agent.tool_call')).toHaveLength(0);
    await r.adapter.answer(q.questionId, 'allow');
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(replies(r)).toContainEqual({ decision: 'accept' });
    expect(of(r, 'agent.tool_call')).toHaveLength(1);
    expect(of(r, 'agent.tool_call')[0]).toMatchObject({ toolName: 'Bash' });
    expect(texts(r).join('\n')).toContain('cleaned');
    expect(of(r, 'agent.needs_input')).toHaveLength(1);
  });

  it('deny declines', async () => {
    const r = rig();
    await r.adapter.spawn(
      spawnOpts(r, 'scenario:permission', () => ({ decision: 'deny', reason: 'no deletes here' })),
    );
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(replies(r)).toContainEqual({ decision: 'decline' });
    expect(of(r, 'agent.tool_call')).toHaveLength(0);
    expect(of(r, 'agent.needs_input')).toHaveLength(0);
    expect(texts(r).join('\n')).toContain('no deletes here');
    expect(texts(r).join('\n')).toContain('I was not allowed to clean.');
  });

  it('a permission answered with anything but allow declines', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:permission', askAll));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    await r.adapter.answer(of(r, 'agent.needs_input')[0]!.questionId, 'deny: not today');
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(replies(r)).toContainEqual({ decision: 'decline' });
    expect(of(r, 'agent.tool_call')).toHaveLength(0);
  });

  it('never accepts for the session', async () => {
    const r = rig();
    for (const scenario of ['happy', 'permission', 'file', 'perms', 'long']) {
      const agent = spawnOpts(r, `scenario:${scenario}`);
      await r.adapter.spawn(agent);
      await waitFor(
        () => of(r, 'agent.idle').some((e) => e.agentId === agent.agentId),
        `${scenario} idle`,
      );
    }
    const all = JSON.stringify(replies(r));
    expect(replies(r).length).toBeGreaterThan(5);
    expect(all).not.toContain('acceptForSession');
    expect(all).not.toContain('Amendment');
    expect(all).not.toContain('"session"');
  });

  it('serves a server tool', async () => {
    const r = rig();
    const inputs: unknown[] = [];
    const tool: ToolDefinition = {
      name: 'request_publish',
      description: 'Ask the user to approve publishing text.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      handler: async (input) => {
        inputs.push(input);
        return { ok: true, questionId: 'q-1' };
      },
    };
    await r.adapter.spawn(spawnOpts(r, 'scenario:tool', allowAll, { tools: [tool] }));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(inputs).toEqual([{ text: 'hello' }]);
    const start = sent(r, 'thread/start')[0]!;
    expect(start['dynamicTools']).toEqual([
      {
        type: 'function',
        name: 'request_publish',
        description: 'Ask the user to approve publishing text.',
        inputSchema: tool.inputSchema,
      },
    ]);
    expect(r.checks).toContainEqual({ toolName: 'request_publish', input: { text: 'hello' } });
    expect(replies(r)).toContainEqual({
      contentItems: [{ type: 'inputText', text: JSON.stringify({ ok: true, questionId: 'q-1' }) }],
      success: true,
    });
    expect(of(r, 'agent.tool_call')).toEqual([
      expect.objectContaining({ toolName: 'request_publish', input: { text: 'hello' } }),
    ]);
  });

  it('a tool it does not serve, or one whose handler throws, answers success false', async () => {
    const r = rig();
    const tool: ToolDefinition = {
      name: 'broken',
      description: 'Throws.',
      inputSchema: { type: 'object' },
      handler: async () => {
        throw new Error('it broke');
      },
    };
    await r.adapter.spawn(spawnOpts(r, 'scenario:tool tool:broken', allowAll, { tools: [tool] }));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(replies(r)).toContainEqual({
      contentItems: [{ type: 'inputText', text: 'it broke' }],
      success: false,
    });
    const r2 = rig();
    await r2.adapter.spawn(spawnOpts(r2, 'scenario:tool tool:nope'));
    await waitFor(() => of(r2, 'agent.idle').length === 1, 'idle');
    expect(replies(r2)[0]).toMatchObject({ success: false });
    expect(of(r2, 'agent.tool_call')).toHaveLength(0);
  });

  it('elicitation is declined', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:elicit'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(replies(r)).toContainEqual({ action: 'decline', content: null, _meta: null });
    expect(of(r, 'agent.needs_input')).toHaveLength(0);
    expect(texts(r).join('\n')).toContain('elicitation: decline');
  });

  it('usage limit ends with reason limit and the reset time', async () => {
    const r = rig({ FAKE_CODEX_RESETS_AT: '1800000000' });
    await r.adapter.spawn(spawnOpts(r, 'scenario:limit'));
    await waitFor(() => terminals(r).length === 1, 'terminal');
    await new Promise((res) => setTimeout(res, 100));
    expect(terminals(r)).toHaveLength(1);
    expect(terminals(r)[0]).toMatchObject({
      type: 'agent.failed',
      reason: 'limit',
      error: 'ChatGPT usage limit reached',
      resetsAt: new Date(1_800_000_000 * 1000).toISOString(),
    });
    expect(of(r, 'agent.idle')).toHaveLength(0);
    expect(sent(r, 'account/rateLimits/read').length).toBeGreaterThan(0);
  });

  it('model passed through', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:echo', allowAll, { model: 'gpt-5.6-terra' }));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(sent(r, 'turn/start')[0]!['model']).toBe('gpt-5.6-terra');
    expect(sent(r, 'thread/start')[0]!['model']).toBe('gpt-5.6-terra');
  });

  it('preflight logged out', async () => {
    const r = rig({ FAKE_CODEX_LOGGED_OUT: '1' });
    const pre = await r.adapter.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.installed).toBe(true);
    expect(pre.provider).toBe('chatgpt');
    expect(pre.problems).toContainEqual(
      expect.objectContaining({
        code: 'not_logged_in',
        severity: 'error',
        fix: 'Run codex login in Terminal',
      }),
    );
  });

  it('preflight warns on an unknown version', async () => {
    expect(KNOWN_CODEX_VERSIONS).toBe('>=0.166 <0.200');
    const r = rig({ FAKE_CODEX_VERSION: '0.250.1' });
    const pre = await r.adapter.preflight();
    expect(pre.ok).toBe(true);
    expect(pre.version).toBe('0.250.1');
    expect(pre.loggedIn).toBe(true);
    expect(pre.problems).toEqual([
      expect.objectContaining({
        code: 'check_failed',
        severity: 'warning',
        message: 'Codex 0.250.1 has not been tested with GalacticAgents',
      }),
    ]);
    const ok = await rig().adapter.preflight();
    expect(ok).toMatchObject({ ok: true, version: '0.166.0', problems: [] });
  });

  it('preflight refuses an API-key login and a missing CLI', async () => {
    const r = rig({ FAKE_CODEX_LOGIN_TEXT: 'Logged in using an API key - sk-***' });
    expect((await r.adapter.preflight()).problems).toContainEqual(
      expect.objectContaining({ code: 'not_subscription', severity: 'error' }),
    );
    const supervisor = new ProcessSupervisor();
    const missing = new CodexAdapter({ supervisor, command: '/nonexistent/codex' });
    const pre = await missing.preflight();
    expect(pre).toMatchObject({ ok: false, installed: false });
    expect(pre.problems[0]!.code).toBe('not_installed');
    await missing.dispose();
    await supervisor.dispose();
  });

  it('lists the visible models and the usage', async () => {
    const r = rig();
    const models = await r.adapter.models();
    expect(models).toEqual([
      {
        id: 'gpt-6-luna',
        label: 'GPT-6-Luna',
        isDefault: true,
        capabilities: ['text'],
        family: 'gpt',
      },
      {
        id: 'gpt-5.6-terra',
        label: 'GPT-5.6-Terra',
        isDefault: false,
        capabilities: ['text'],
        family: 'gpt',
      },
      {
        id: 'gpt-5.6-luna',
        label: 'GPT-5.6-Luna',
        isDefault: false,
        capabilities: ['text'],
        family: 'gpt',
      },
    ]);
    const usage = await r.adapter.usage();
    expect(usage).toEqual({
      plan: 'free',
      windows: [
        {
          label: '30 days',
          remainingFraction: 0.99,
          resetsAt: new Date(1796027861 * 1000).toISOString(),
        },
      ],
    });
    expect(JSON.stringify(usage)).not.toContain('example.com');
    const missing = new CodexAdapter({ supervisor: r.supervisor, command: '/nonexistent/codex' });
    expect(await missing.models()).toEqual([]);
    expect(await missing.usage()).toBeUndefined();
  });

  it('a file change asks about every path, reserved once; one refusal declines it', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:file'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(r.checks).toEqual([
      { toolName: 'Edit', input: { file_path: join(cwd, 'hello.txt') } },
      { toolName: 'Edit', input: { file_path: join(cwd, 'README.md') } },
    ]);
    expect(r.reserves).toEqual([true, false]);
    expect(replies(r)).toContainEqual({ decision: 'accept' });
    expect(of(r, 'agent.tool_call')).toHaveLength(1);

    const r2 = rig();
    await r2.adapter.spawn(
      spawnOpts(r2, 'scenario:file', (call) =>
        (call.input as { file_path: string }).file_path.endsWith('README.md')
          ? { decision: 'deny', reason: 'README is protected' }
          : { decision: 'allow' },
      ),
    );
    await waitFor(() => of(r2, 'agent.idle').length === 1, 'idle');
    expect(replies(r2)).toContainEqual({ decision: 'decline' });
    expect(of(r2, 'agent.tool_call')).toHaveLength(0);
    expect(texts(r2).join('\n')).toContain('README is protected');

    const r3 = rig();
    await r3.adapter.spawn(spawnOpts(r3, 'scenario:file', askAll));
    await waitFor(() => of(r3, 'agent.needs_input').length === 1, 'question');
    const q = of(r3, 'agent.needs_input')[0]!;
    expect(q.question.toolCall).toEqual({
      toolName: 'Edit',
      input: {
        file_path: join(cwd, 'hello.txt'),
        paths: [join(cwd, 'hello.txt'), join(cwd, 'README.md')],
      },
    });
    await r3.adapter.answer(q.questionId, 'allow');
    await waitFor(() => of(r3, 'agent.idle').length === 1, 'idle');
    expect(texts(r3).join('\n')).toContain('patched');
  });

  it('a permissions request is judged as codex:permissions and granted for the turn only', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:perms'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(r.checks[0]).toMatchObject({ toolName: 'codex:permissions' });
    expect(replies(r)).toContainEqual({
      permissions: { network: { enabled: true } },
      scope: 'turn',
    });
    const r2 = rig();
    await r2.adapter.spawn(
      spawnOpts(r2, 'scenario:perms', () => ({ decision: 'deny', reason: 'no network' })),
    );
    await waitFor(() => of(r2, 'agent.idle').length === 1, 'idle');
    expect(replies(r2)).toContainEqual({ permissions: {}, scope: 'turn' });
  });

  it('a clarification goes to the user and its answer back to the agent', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:asks'));
    await waitFor(() => of(r, 'agent.needs_input').length === 1, 'question');
    const q = of(r, 'agent.needs_input')[0]!;
    expect(q.kind).toBe('clarification');
    expect(q.question).toMatchObject({
      text: 'Option: Which option do you prefer?',
      options: ['first option', 'second option'],
    });
    await r.adapter.answer(q.questionId, 'second option');
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(replies(r)).toContainEqual({ answers: { choice: { answers: ['second option'] } } });
    expect(texts(r).join('\n')).toContain('You chose: second option');
  });

  it('reports the unasked node_repl tool as a tool call without asking the gate', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:unasked'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(r.checks).toEqual([]);
    expect(of(r, 'agent.tool_call')).toEqual([
      expect.objectContaining({ toolName: 'mcp__node_repl__js', input: { code: '1+1' } }),
    ]);
    expect(texts(r).join('\n')).toContain('tool result (node_repl.js): 2');
  });

  it('joins a streamed message into one block; a failed turn is a line and idle', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:happy'));
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    expect(texts(r)).toContain('Reading the README to get started.');
    expect(texts(r).filter((t) => t.startsWith('Reading'))).toHaveLength(1);
    expect(of(r, 'agent.progress')[0]).toMatchObject({ summary: 'report (1/2)' });
    expect(of(r, 'agent.output').some((e) => e.kind === 'thinking')).toBe(true);
    expect(texts(r).join('\n')).toContain('tool result (Bash: cat README.md) (exit 0): # readme');

    const r2 = rig();
    await r2.adapter.spawn(spawnOpts(r2, 'scenario:error'));
    await waitFor(() => of(r2, 'agent.idle').length === 1, 'idle');
    expect(texts(r2).join('\n')).toContain('stream disconnected before completion');
    expect(terminals(r2)).toHaveLength(0);
  });

  it('a process that dies mid-turn fails once with reason crash', async () => {
    const r = rig();
    await r.adapter.spawn(spawnOpts(r, 'scenario:dies'));
    await waitFor(() => terminals(r).length === 1, 'terminal');
    expect(terminals(r)[0]).toMatchObject({ type: 'agent.failed', reason: 'crash' });
  });

  it('refuses bare spawns, brains and session refs that are not codex ones', async () => {
    const r = rig();
    await expect(r.adapter.spawn({ ...spawnOpts(r, 'x'), bare: true })).rejects.toThrow(/bare/);
    await expect(
      r.adapter.spawn({ ...spawnOpts(r, 'x'), role: 'waykeeper' as const }),
    ).rejects.toThrow(/Stewards/);
    await expect(r.adapter.resumeSession('acp:abc', spawnOpts(r, 'x'))).rejects.toThrow(
      /not a codex session ref/,
    );
    expect(r.adapter.canPublish).toBe(true);
    expect(r.adapter.runtime).toBe('codex');
  });

  it('resumes a thread from its session ref in a new process', async () => {
    const r = rig();
    const opts = spawnOpts(r, 'scenario:echo');
    const handle = await r.adapter.spawn(opts);
    expect(handle.sessionRef).toMatch(/^codex:fake-thread-/);
    await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
    await r.adapter.stop(handle.sessionId);
    const r2 = rig();
    const resumed = await r2.adapter.resumeSession(handle.sessionRef!, {
      ...spawnOpts(r2, 'please reply with the word omega'),
      agentId: opts.agentId,
    });
    expect(resumed.sessionRef).toBe(handle.sessionRef);
    await waitFor(() => of(r2, 'agent.idle').length === 1, 'idle after resume');
    expect(sent(r2, 'thread/resume')[0]).toMatchObject({
      threadId: handle.sessionRef!.slice('codex:'.length),
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });
    expect(texts(r2).join('\n')).toContain('echo: please reply with the word omega');
    await expect(
      r2.adapter.resumeSession('codex:no-such-thread', spawnOpts(r2, 'x')),
    ).rejects.toThrow(/thread\/resume failed/);
  });

  describe('replays the P11-01 transcripts', () => {
    it('turn-ok: the answer and idle', async () => {
      const r = rig();
      await r.adapter.spawn(spawnOpts(r, 'scenario:replay-turn-ok'));
      await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
      expect(texts(r)).toEqual(['ok']);
    });

    it('approval-command: Bash with the unwrapped script', async () => {
      const r = rig();
      await r.adapter.spawn(spawnOpts(r, 'scenario:replay-approval-command'));
      await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
      expect(r.checks).toEqual([{ toolName: 'Bash', input: { command: 'touch probe.txt .' } }]);
      expect(replies(r)).toEqual([{ decision: 'accept' }]);
    });

    it('approval-file: Edit on the path the started item named', async () => {
      const r = rig();
      await r.adapter.spawn(spawnOpts(r, 'scenario:replay-approval-file'));
      await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
      expect(r.checks).toEqual([
        { toolName: 'Edit', input: { file_path: join(cwd, 'hello.txt') } },
      ]);
      expect(replies(r)).toEqual([{ decision: 'accept' }]);
    });

    it('dynamic-tool: the handler answers the call', async () => {
      const r = rig();
      const tool: ToolDefinition = {
        name: 'request_publish',
        description: 'd',
        inputSchema: { type: 'object' },
        handler: async (input) => ({ ok: true, echoed: input }),
      };
      await r.adapter.spawn(
        spawnOpts(r, 'scenario:replay-dynamic-tool', allowAll, { tools: [tool] }),
      );
      await waitFor(() => of(r, 'agent.idle').length === 1, 'idle');
      expect(replies(r)).toEqual([
        {
          contentItems: [{ type: 'inputText', text: '{"ok":true,"echoed":{"text":"hello"}}' }],
          success: true,
        },
      ]);
    });
  });
});

describe('codex mapping and limits', () => {
  it('unwraps the shell Codex wraps a command in', () => {
    expect(unwrapShell(`/bin/zsh -lc 'touch probe.txt .'`)).toBe('touch probe.txt .');
    expect(unwrapShell(`bash -c 'echo '\\''hi'\\'''`)).toBe(`echo 'hi'`);
    expect(unwrapShell('ls -la')).toBe('ls -la');
    expect(commandCall({ command: `/bin/zsh -lc 'ls'`, cwd: '/elsewhere' }, '/work')).toEqual({
      toolName: 'Bash',
      input: { command: `cd '/elsewhere' && ls` },
    });
  });

  it('reads the usage-limit error and its reset', () => {
    expect(isUsageLimit({ error: { message: 'x', codexErrorInfo: 'usageLimitExceeded' } })).toBe(
      true,
    );
    expect(
      isUsageLimit({ error: { message: "You've hit your usage limit.", codexErrorInfo: null } }),
    ).toBe(true);
    expect(
      isUsageLimit({ error: { message: 'slow down', codexErrorInfo: 'rateLimitExceeded' } }),
    ).toBe(false);
    expect(
      limitResetsAt({
        rateLimits: {
          primary: { usedPercent: 40, resetsAt: 2_000_000_000 },
          secondary: { usedPercent: 100, resetsAt: 1_900_000_000 },
        },
      }),
    ).toBe(new Date(1_900_000_000_000).toISOString());
    expect(limitResetsAt({})).toBeUndefined();
  });
});
