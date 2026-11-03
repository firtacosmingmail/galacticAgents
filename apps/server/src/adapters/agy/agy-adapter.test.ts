import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  GateCheckOptions,
  GateVerdict,
  ToolCall,
  ToolDefinition,
} from '@galactic/protocol';
import { registerAgyHookRoutes } from '../../http/agy-hook-routes.js';
import { ProcessSupervisor } from '../../runtime/supervisor.js';
import { AgyAdapter } from './agy-adapter.js';
import { FAKE_AGY } from './fake-agent.js';
import { globalEntriesInstalled, hooksFile, mcpConfigFile } from './global-entries.js';
import { HookBridge } from './hook-bridge.js';
import { brainDir } from './images.js';
import { isQuotaError, limitResetsAt, usageFrom } from './limits.js';
import { mapAgyCall } from './mapping.js';
import { parseModels } from './preflight.js';

/**
 * The Antigravity adapter on its own (P11-05), against the fake agy CLI (`fake-agy.mjs`, a real
 * child process that reads its hooks and MCP server from `$HOME/.gemini/config`, as agy does): the
 * flags it runs with, every tool call through the real hook process and the bridge, the server's
 * tools through the real tool server, `ask_user`, the image copy, the usage limit, the global
 * entries kept byte-exact, the model list, the usage and the preflight.
 */

const CAPS = { maxWallClockMs: 60_000, maxToolCalls: 100 };
type Verdict = (call: ToolCall) => GateVerdict;
const allowAll: Verdict = () => ({ decision: 'allow' });

interface Rig {
  adapter: AgyAdapter;
  supervisor: ProcessSupervisor;
  app: FastifyInstance;
  bridge: HookBridge;
  url: string;
  home: string;
  stateDir: string;
  cwd: string;
  events: AgentEvent[];
  checks: ToolCall[];
  recordFile: string;
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.adapter.dispose();
    await r.supervisor.dispose();
    await r.app.close();
  }
});

async function rig(env: Record<string, string> = {}, prepareHome?: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), 'galactic-agy-home-'));
  prepareHome?.(home);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-agy-cwd-')));
  writeFileSync(join(cwd, 'README.md'), '# unit\n');
  const stateDir = mkdtempSync(join(tmpdir(), 'galactic-agy-state-'));
  const recordFile = join(stateDir, 'record.jsonl');
  const bridge = new HookBridge();
  const app = Fastify();
  registerAgyHookRoutes(app, { bridge });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agy-hook`;
  const supervisor = new ProcessSupervisor({ defaults: { graceMs: 2_000, termMs: 1_000 } });
  const adapter = new AgyAdapter({
    supervisor,
    command: process.execPath,
    args: [FAKE_AGY],
    hookUrl: () => url,
    bridge,
    home,
    stateDir,
    env: { FAKE_AGY_RECORD: recordFile, ...env },
    graceMs: 2_000,
    startTimeoutMs: 10_000,
  });
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const e of adapter.events) events.push(e);
  })();
  const r: Rig = {
    adapter,
    supervisor,
    app,
    bridge,
    url,
    home,
    stateDir,
    cwd,
    events,
    checks: [],
    recordFile,
  };
  rigs.push(r);
  return r;
}

function spawnOpts(
  r: Rig,
  prompt: string,
  verdict: Verdict = allowAll,
  extra: { tools?: ToolDefinition[]; model?: string; role?: 'steward' | 'harmonizer' } = {},
) {
  return {
    agentId: `a-${Math.random()}`,
    role: extra.role ?? ('steward' as const),
    cwd: r.cwd,
    prompt,
    caps: CAPS,
    ...(extra.tools ? { tools: extra.tools } : {}),
    ...(extra.model ? { model: extra.model } : {}),
    gate: {
      check: (call: ToolCall, _opts?: GateCheckOptions) => {
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

const of = <T extends AgentEvent['type']>(r: Rig, agentId: string, type: T) =>
  r.events.filter((e) => e.type === type && e.agentId === agentId) as Extract<
    AgentEvent,
    { type: T }
  >[];
const text = (r: Rig, agentId: string) =>
  of(r, agentId, 'agent.output')
    .map((e) => e.text)
    .join('\n');
const idles = (r: Rig, agentId: string) => of(r, agentId, 'agent.idle').length;
const recorded = (
  r: Rig,
): { argv: string[]; secret: boolean; url: string | null; home: string }[] =>
  existsSync(r.recordFile)
    ? readFileSync(r.recordFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
const turns = (r: Rig) => recorded(r).filter((e) => e.argv.includes('stream-json'));

describe('AgyAdapter', () => {
  it('canPublish is false', async () => {
    const r = await rig();
    expect(r.adapter.canPublish).toBe(false);
    expect(r.adapter.runtime).toBe('agy');
  });

  it('never skips permissions', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:happy');
    const handle = await r.adapter.spawn(opts);
    expect(handle.sessionRef).toMatch(/^agy:[\w-]+$/);
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    const [turn] = turns(r);
    expect(turn!.argv).not.toContain('--dangerously-skip-permissions');
    expect(turn!.argv.join(' ')).toContain('--output-format stream-json');
    expect(turn!.argv).toContain('--disable-slash-commands');
    expect(turn!.secret).toBe(true);
    expect(turn!.url).toBe(r.url);
    expect(turn!.home).toBe(r.home);
    // The command went through the hook and the gate, and ran.
    expect(r.checks).toContainEqual({ toolName: 'Bash', input: { command: 'cat README.md' } });
    expect(of(r, opts.agentId, 'agent.tool_call').map((e) => e.toolName)).toEqual(['Bash']);
    expect(text(r, opts.agentId)).toContain('done');
    expect(text(r, opts.agentId)).toContain('# readme');
  });

  it('model passed through', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:echo', allowAll, { model: 'gemini-3.8-flash-low' });
    const handle = await r.adapter.spawn(opts);
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    await r.adapter.send(handle.sessionId, 'please reply with the word delta');
    await waitFor(() => idles(r, opts.agentId) === 2, 'second idle');
    const [first, second] = turns(r);
    expect(first!.argv.join(' ')).toContain('--model gemini-3.8-flash-low');
    expect(second!.argv.join(' ')).toContain('--model gemini-3.8-flash-low');
    // The second turn continues the same conversation.
    expect(second!.argv.join(' ')).toContain(`--conversation ${handle.sessionRef!.slice(4)}`);
    expect(text(r, opts.agentId)).toContain('echo: please reply with the word delta');
  });

  it('server tool through the tool server', async () => {
    const r = await rig();
    const ran: unknown[] = [];
    const tools: ToolDefinition[] = [
      {
        name: 'request_publish',
        description: 'Ask the user to approve publishing text.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        handler: async (input) => {
          ran.push(input);
          return { ok: true };
        },
      },
    ];
    const opts = spawnOpts(r, 'scenario:tool', allowAll, { tools });
    await r.adapter.spawn(opts);
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    expect(ran).toEqual([{ text: 'hello' }]);
    // Gated under its bare name, reported once.
    expect(r.checks).toContainEqual({ toolName: 'request_publish', input: { text: 'hello' } });
    expect(of(r, opts.agentId, 'agent.tool_call').map((e) => e.toolName)).toEqual([
      'request_publish',
    ]);
    expect(text(r, opts.agentId)).toContain('tool said: {"ok":true}');
  });

  it('a server tool the gate refuses never runs', async () => {
    const r = await rig();
    const ran: unknown[] = [];
    const tools: ToolDefinition[] = [
      {
        name: 'request_publish',
        description: 'd',
        inputSchema: { type: 'object' },
        handler: async (input) => ran.push(input),
      },
    ];
    const opts = spawnOpts(r, 'scenario:tool', () => ({ decision: 'deny', reason: 'no' }), {
      tools,
    });
    await r.adapter.spawn(opts);
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    expect(ran).toEqual([]);
    expect(text(r, opts.agentId)).toContain('tool said: nothing');
    // The gate's reason is what agy tells the model.
    expect(text(r, opts.agentId)).toContain('tool call denied by pre-tool hook: no.');
  });

  it('generated image copied into the worktree', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:image');
    const handle = await r.adapter.spawn(opts);
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    const source = join(brainDir(r.home, handle.sessionRef!.slice(4)), 'img1.png');
    const copy = join(r.cwd, 'generated-images', 'img1.png');
    expect(existsSync(copy)).toBe(true);
    expect(readFileSync(copy).equals(readFileSync(source))).toBe(true);
    // Only images: the conversation's other files stay where they are.
    expect(existsSync(join(r.cwd, 'generated-images', 'notes.md'))).toBe(false);
    // The image tool went through the gate (an image costs quota); the subagent did not need to.
    expect(r.checks.map((c) => c.toolName)).toEqual(['agy:generate_image']);
  });

  it('limit ends with reason limit', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:limit');
    await r.adapter.spawn(opts);
    await waitFor(() => of(r, opts.agentId, 'agent.failed').length > 0, 'agent.failed');
    await new Promise((res) => setTimeout(res, 100));
    const failed = of(r, opts.agentId, 'agent.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: 'limit', resetsAt: '2026-11-07T08:31:33.000Z' });
    expect(idles(r, opts.agentId)).toBe(0);
    expect(of(r, opts.agentId, 'agent.stopped')).toHaveLength(0);
  });

  it('a quota reported only in the final result also ends with reason limit', async () => {
    const r = await rig({ FAKE_AGY_USAGE_EXHAUSTED: '1' });
    const opts = spawnOpts(r, 'scenario:limit-result');
    await r.adapter.spawn(opts);
    await waitFor(() => of(r, opts.agentId, 'agent.failed').length > 0, 'agent.failed');
    expect(of(r, opts.agentId, 'agent.failed')[0]).toMatchObject({
      reason: 'limit',
      resetsAt: '2026-11-07T08:31:33.000Z',
    });
    expect(idles(r, opts.agentId)).toBe(0);
  });

  it('a permission the gate asks about waits for the answer, then runs', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:permission', (call) =>
      call.toolName === 'Bash'
        ? { decision: 'ask', action: 'destructive', reasons: ['recursive delete'] }
        : { decision: 'allow' },
    );
    await r.adapter.spawn(opts);
    await waitFor(() => of(r, opts.agentId, 'agent.needs_input').length === 1, 'question');
    const q = of(r, opts.agentId, 'agent.needs_input')[0]!;
    expect(q.kind).toBe('permission');
    expect(q.question.toolCall).toEqual({
      toolName: 'Bash',
      input: { command: `rm -r ${join(r.cwd, 'build')}` },
    });
    expect(q.question.permissionAction).toBe('destructive');
    await new Promise((res) => setTimeout(res, 100));
    expect(idles(r, opts.agentId)).toBe(0);
    await r.adapter.answer(q.questionId, 'allow');
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    expect(text(r, opts.agentId)).toContain('cleaned');
    expect(of(r, opts.agentId, 'agent.tool_call')).toHaveLength(1);
  });

  it('ask_user becomes a clarification; its answer is the tool result', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:asks');
    await r.adapter.spawn(opts);
    await waitFor(() => of(r, opts.agentId, 'agent.needs_input').length === 1, 'question');
    const q = of(r, opts.agentId, 'agent.needs_input')[0]!;
    expect(q.kind).toBe('clarification');
    expect(q.question).toMatchObject({
      text: 'Which option do you prefer?',
      options: ['first option', 'second option'],
    });
    await r.adapter.answer(q.questionId, 'first option');
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    expect(text(r, opts.agentId)).toContain('You chose: first option');
    // Neither the question nor the read of the tool's descriptor is an action for the gate.
    expect(r.checks).toEqual([]);
    expect(of(r, opts.agentId, 'agent.tool_call')).toHaveLength(0);
  });

  it("writes to agy's configuration and browser tools are denied without asking", async () => {
    const r = await rig();
    const a = spawnOpts(r, 'scenario:write-config');
    await r.adapter.spawn(a);
    await waitFor(() => idles(r, a.agentId) === 1, 'idle');
    expect(text(r, a.agentId)).toContain('refused: tool call denied by pre-tool hook');
    expect(existsSync(join(r.cwd, '.agents', 'hooks.json'))).toBe(false);
    const b = spawnOpts(r, 'scenario:browser');
    await r.adapter.spawn(b);
    await waitFor(() => idles(r, b.agentId) === 1, 'idle');
    expect(text(r, b.agentId)).toContain('browser tools are not available');
    expect(r.checks).toEqual([]);
    expect(of(r, a.agentId, 'agent.needs_input')).toHaveLength(0);
    expect(of(r, b.agentId, 'agent.needs_input')).toHaveLength(0);
  });

  it("adds its global entries next to the user's and leaves the files byte-identical on dispose", async () => {
    const userHooks = '{\n    "mine": {"enabled": true, "PreToolUse": []}\n}\n';
    const r = await rig({}, (home) => {
      mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
      writeFileSync(hooksFile(home), userHooks);
      writeFileSync(mcpConfigFile(home), '');
    });
    const opts = spawnOpts(r, 'scenario:echo');
    await r.adapter.spawn(opts);
    await waitFor(() => idles(r, opts.agentId) === 1, 'idle');
    expect(globalEntriesInstalled(r.home)).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksFile(r.home), 'utf8'));
    expect(hooks.mine).toEqual({ enabled: true, PreToolUse: [] });
    expect(hooks.galactic).toMatchObject({ galactic: true, enabled: true });
    expect(hooks.galactic.PreToolUse[0].hooks[0].timeout).toBe(86_400);
    await r.adapter.dispose();
    expect(readFileSync(hooksFile(r.home), 'utf8')).toBe(userHooks);
    expect(readFileSync(mcpConfigFile(r.home), 'utf8')).toBe('');
  });

  it("refuses to take over a user's own galactic entry", async () => {
    const r = await rig({}, (home) => {
      mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
      writeFileSync(hooksFile(home), '{"galactic": {"enabled": true}}');
    });
    await expect(r.adapter.spawn(spawnOpts(r, 'scenario:echo'))).rejects.toThrow(/did not add/);
    expect(readFileSync(hooksFile(r.home), 'utf8')).toBe('{"galactic": {"enabled": true}}');
  });

  it('a workspace with its own agy hooks or MCP servers is refused', async () => {
    const r = await rig();
    mkdirSync(join(r.cwd, '.agents'));
    writeFileSync(join(r.cwd, '.agents', 'hooks.json'), '{}');
    await expect(r.adapter.spawn(spawnOpts(r, 'scenario:echo'))).rejects.toThrow(/\.agents/);
    expect(turns(r)).toEqual([]);
  });

  it('runs Stewards only, never bare', async () => {
    const r = await rig();
    await expect(
      r.adapter.spawn(spawnOpts(r, 'scenario:echo', allowAll, { role: 'harmonizer' })),
    ).rejects.toThrow(/Stewards only/);
    await expect(r.adapter.spawn({ ...spawnOpts(r, 'scenario:echo'), bare: true })).rejects.toThrow(
      /bare/,
    );
  });

  it('stops while a question is open; the session ends with one agent.stopped', async () => {
    const r = await rig();
    const opts = spawnOpts(r, 'scenario:asks');
    const handle = await r.adapter.spawn(opts);
    await waitFor(() => of(r, opts.agentId, 'agent.needs_input').length === 1, 'question');
    await r.adapter.stop(handle.sessionId);
    await new Promise((res) => setTimeout(res, 100));
    expect(of(r, opts.agentId, 'agent.stopped')).toHaveLength(1);
    expect(r.adapter.sessionCount).toBe(0);
  });

  it('lists the models with their capabilities and reads the usage', async () => {
    const r = await rig();
    const models = await r.adapter.models();
    expect(models.map((m) => m.id)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-low',
      'claude-sonnet-4-6',
      'gpt-oss-120b-medium',
    ]);
    expect(models[0]).toMatchObject({ capabilities: ['text', 'image'], family: 'gemini' });
    expect(models[2]).toMatchObject({ capabilities: ['text'], family: 'claude' });
    expect(models[3]).toMatchObject({ family: 'gpt' });
    const usage = await r.adapter.usage();
    expect(usage?.windows).toEqual([
      {
        label: 'Gemini Models · weekly',
        remainingFraction: 0.8020792007446289,
        resetsAt: '2026-11-07T08:31:33.000Z',
      },
      {
        label: 'Claude and GPT models · weekly',
        remainingFraction: 1,
        resetsAt: '2026-11-09T12:10:40.000Z',
      },
    ]);
  });

  it('preflight: logged in, and logged out with the fix', async () => {
    const r = await rig();
    const ok = await r.adapter.preflight();
    expect(ok).toMatchObject({ runtime: 'agy', provider: 'gemini', ok: true, loggedIn: true });
    expect(ok.version).toBe('1.4.12');
    const out = await rig({ FAKE_AGY_LOGGED_OUT: '1' });
    const pre = await out.adapter.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.problems[0]).toMatchObject({ code: 'not_logged_in' });
    const old = await rig({ FAKE_AGY_VERSION: '1.3.0' });
    expect((await old.adapter.preflight()).problems[0]).toMatchObject({
      code: 'check_failed',
      severity: 'warning',
    });
  });
});

describe('agy mapping and parsing', () => {
  const ctx = {
    cwd: '/tmp/work',
    home: '/Users/example',
    serverTools: new Set(['request_publish']),
  };

  it('maps agy tools to gate calls', () => {
    expect(mapAgyCall({ toolName: 'run_command', input: { CommandLine: 'ls' } }, ctx)).toEqual({
      kind: 'gate',
      call: { toolName: 'Bash', input: { command: 'ls' } },
    });
    expect(
      mapAgyCall({ toolName: 'run_command', input: { CommandLine: 'ls', Cwd: '/tmp/other' } }, ctx),
    ).toEqual({
      kind: 'gate',
      call: { toolName: 'Bash', input: { command: "cd '/tmp/other' && ls" } },
    });
    expect(
      mapAgyCall({ toolName: 'read_file', input: { Path: 'https://example.com' } }, ctx),
    ).toEqual({
      kind: 'gate',
      call: { toolName: 'WebFetch', input: { url: 'https://example.com' } },
    });
    expect(
      mapAgyCall({ toolName: 'edit_file', input: { Path: 'a.ts', Target: 'x' } }, ctx),
    ).toEqual({
      kind: 'gate',
      call: { toolName: 'Edit', input: { file_path: 'a.ts' } },
    });
  });

  it("reads of agy's built-in skills and Mission Control's tool descriptors need no gate", () => {
    expect(
      mapAgyCall(
        {
          toolName: 'view_file',
          input: {
            AbsolutePath: '/Users/example/.gemini/antigravity-cli/builtin/skills/x/SKILL.md',
          },
        },
        ctx,
      ),
    ).toEqual({ kind: 'allow' });
    expect(
      mapAgyCall(
        { toolName: 'read_file', input: { Path: '/Users/example/.gemini/config/hooks.json' } },
        ctx,
      ).kind,
    ).toBe('gate');
  });

  it('denies what it does not know, other MCP servers and agy config writes', () => {
    expect(mapAgyCall({ toolName: 'schedule', input: {} }, ctx).kind).toBe('deny');
    expect(mapAgyCall({ toolName: 'some_future_tool', input: {} }, ctx).kind).toBe('deny');
    expect(
      mapAgyCall(
        { toolName: 'call_mcp_tool', input: { ServerName: 'other', ToolName: 'x', Arguments: {} } },
        ctx,
      ).kind,
    ).toBe('deny');
    expect(
      mapAgyCall({ toolName: 'write_file', input: { Path: '~/.gemini/config/hooks.json' } }, ctx)
        .kind,
    ).toBe('deny');
    expect(mapAgyCall({ toolName: 'ask_question', input: {} }, ctx)).toMatchObject({
      kind: 'deny',
      reason: expect.stringContaining('ask_user'),
    });
  });

  it('reads the limit and the models', () => {
    const stderr =
      'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"message":"quota","retryable":false}\n';
    expect(isQuotaError(stderr)).toBe(true);
    expect(isQuotaError('AGY_ERROR: {"status":"UNAVAILABLE","code":503}')).toBe(false);
    expect(isQuotaError('something else')).toBe(false);
    const usage = readFileSync(new URL('./fixtures/usage.jsonl', import.meta.url), 'utf8');
    expect(limitResetsAt(usage, 'claude-sonnet-4-6')).toBe('2026-11-09T12:10:40.000Z');
    expect(limitResetsAt(usage)).toBe('2026-11-07T08:31:33.000Z');
    expect(usageFrom(usage)?.windows).toHaveLength(2);
    expect(parseModels('Fetching available models...\nx-1\tX One\n')).toEqual([
      { id: 'x-1', label: 'X One', isDefault: false, capabilities: ['text'], family: 'other' },
    ]);
  });
});
