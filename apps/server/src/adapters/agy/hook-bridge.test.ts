import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAgyHookRoutes } from '../../http/agy-hook-routes.js';
import { HookBridge, SECRET_ENV, URL_ENV, mcpText, type HookDecide } from './hook-bridge.js';

/**
 * The hook bridge (P11-05; TECHNOLOGY §3.7): the server side keyed by a session's secret, and
 * the hook process agy runs (`galactic-agy-hook.mjs`) — fail closed on every error.
 */

const HOOK = fileURLToPath(new URL('./galactic-agy-hook.mjs', import.meta.url));
const PAYLOAD = {
  artifactDirectoryPath: '/Users/example/.gemini/antigravity-cli/brain/c-1',
  conversationId: 'c-1',
  lastUserInput: 'run ls',
  modelName: 'gemini-3.8-flash-high',
  stepIdx: 2,
  toolCall: { name: 'run_command', args: { CommandLine: 'ls' } },
  transcriptPath: '/tmp/t.jsonl',
  workspacePaths: ['/tmp/work'],
};

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function bridgeServer(bridge: HookBridge): Promise<string> {
  const app: FastifyInstance = Fastify();
  registerAgyHookRoutes(app, { bridge });
  await app.listen({ host: '127.0.0.1', port: 0 });
  closers.push(() => app.close());
  return `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/agy-hook`;
}

/** Runs the hook process the way agy does: payload on stdin, one JSON decision on stdout. */
function runHook(
  env: Record<string, string | undefined>,
  stdin = JSON.stringify(PAYLOAD),
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdio: 'pipe',
    });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, code }));
    child.stdin.end(stdin);
  });
}

describe('HookBridge', () => {
  it('unknown secret is denied', async () => {
    const bridge = new HookBridge();
    bridge.register('known', async () => 'allow');
    expect((await bridge.handle('other', PAYLOAD)).decision).toBe('deny');
    expect((await bridge.handle('', PAYLOAD)).decision).toBe('deny');
  });

  it('gate allow and deny pass through', async () => {
    const bridge = new HookBridge();
    const seen: string[] = [];
    bridge.register('s-allow', async (call) => {
      seen.push(call.toolName);
      return 'allow';
    });
    bridge.register('s-deny', async () => ({ decision: 'deny', reason: 'policy says no' }));
    expect(await bridge.handle('s-allow', PAYLOAD)).toEqual({ decision: 'allow' });
    expect(await bridge.handle('s-deny', PAYLOAD)).toEqual({
      decision: 'deny',
      reason: 'policy says no',
    });
    expect(seen).toEqual(['run_command']);
  });

  it('ask waits for the answer', async () => {
    const bridge = new HookBridge();
    let answer!: (d: 'allow' | 'deny') => void;
    const decide: HookDecide = () => new Promise((r) => (answer = r));
    bridge.register('s', decide);
    let settled: unknown;
    const pending = bridge.handle('s', PAYLOAD).then((d) => (settled = d));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBeUndefined();
    answer('allow');
    await pending;
    expect(settled).toEqual({ decision: 'allow' });
  });

  it('a session that ends while a decision is pending denies it', async () => {
    const bridge = new HookBridge();
    bridge.register('s', () => new Promise(() => {}));
    const pending = bridge.handle('s', PAYLOAD);
    bridge.unregister('s');
    expect((await pending).decision).toBe('deny');
  });

  it('a payload without a tool call, or a decide that throws, is denied', async () => {
    const bridge = new HookBridge();
    bridge.register('s', async () => {
      throw new Error('boom');
    });
    expect((await bridge.handle('s', { nothing: true })).decision).toBe('deny');
    const thrown = await bridge.handle('s', PAYLOAD);
    expect(thrown.decision).toBe('deny');
    expect(thrown.reason).toContain('boom');
  });

  it("a tools/call reaches only the calling session's own tools (P11-06: request_publish)", async () => {
    const bridge = new HookBridge();
    const calls: string[] = [];
    const toolsOf = (who: string) => ({
      list: () => [{ name: 'request_publish', description: who, inputSchema: { type: 'object' } }],
      call: async (name: string) => {
        calls.push(`${who}:${name}`);
        return mcpText(who);
      },
    });
    bridge.register('secret-a', async () => 'deny' as const, toolsOf('steward-a'));
    bridge.register('secret-b', async () => 'deny' as const, toolsOf('steward-b'));
    expect(await bridge.callTool('secret-a', 'request_publish', {})).toEqual(mcpText('steward-a'));
    expect(await bridge.callTool('secret-b', 'request_publish', {})).toEqual(mcpText('steward-b'));
    expect((await bridge.callTool('secret-c', 'request_publish', {})).isError).toBe(true);
    expect(calls).toEqual(['steward-a:request_publish', 'steward-b:request_publish']);
  });
});

describe('the hook process', () => {
  it('bridge unreachable means deny', async () => {
    // A port nothing listens on: the connection is refused.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const started = Date.now();
    const { stdout, code } = await runHook({
      [SECRET_ENV]: 'secret',
      [URL_ENV]: `http://127.0.0.1:${port}/api/agy-hook`,
      // It waits a while for a server that is still starting, then denies.
      GALACTIC_AGY_CONNECT_WAIT_MS: '600',
    });
    expect(code).toBe(0);
    expect(stdout).toBe('{"decision":"deny"}');
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
  });

  it('crashing bridge means deny', async () => {
    const server: Server = createServer((_req, res) => {
      res.statusCode = 500;
      res.end('{"decision":"allow"}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => server.close(r)));
    const port = (server.address() as AddressInfo).port;
    const { stdout, code } = await runHook({
      [SECRET_ENV]: 'secret',
      [URL_ENV]: `http://127.0.0.1:${port}/api/agy-hook`,
    });
    expect(code).toBe(0);
    expect(stdout).toBe('{"decision":"deny"}');
  });

  it('a bridge that answers garbage, or stdin that is not JSON, means deny', async () => {
    const server: Server = createServer((_req, res) => res.end('not json'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise((r) => server.close(r)));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/agy-hook`;
    expect((await runHook({ [SECRET_ENV]: 's', [URL_ENV]: url })).stdout).toBe(
      '{"decision":"deny"}',
    );
    const bridge = new HookBridge();
    bridge.register('s', async () => 'allow');
    const real = await bridgeServer(bridge);
    expect((await runHook({ [SECRET_ENV]: 's', [URL_ENV]: real }, 'garbage')).stdout).toBe(
      '{"decision":"deny"}',
    );
  });

  it('allow is printed as auto_approve, deny with its reason; an unknown secret is denied', async () => {
    const bridge = new HookBridge();
    bridge.register('good', async () => 'allow');
    bridge.register('bad', async () => ({ decision: 'deny', reason: 'not here' }));
    const url = await bridgeServer(bridge);
    expect(JSON.parse((await runHook({ [SECRET_ENV]: 'good', [URL_ENV]: url })).stdout)).toEqual({
      decision: 'auto_approve',
    });
    expect(JSON.parse((await runHook({ [SECRET_ENV]: 'bad', [URL_ENV]: url })).stdout)).toEqual({
      decision: 'deny',
      reason: 'not here',
    });
    const unknown = JSON.parse((await runHook({ [SECRET_ENV]: 'nope', [URL_ENV]: url })).stdout);
    expect(unknown.decision).toBe('deny');
  });

  it("passes through for a run Mission Control did not start (the user's own agy)", async () => {
    const { stdout, code } = await runHook({ [SECRET_ENV]: undefined, [URL_ENV]: undefined });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ decision: 'allow' });
  });

  it('never answers ask or force_ask', async () => {
    const bridge = new HookBridge();
    bridge.register('s', async () => ({ decision: 'ask' }) as never);
    const url = await bridgeServer(bridge);
    expect(JSON.parse((await runHook({ [SECRET_ENV]: 's', [URL_ENV]: url })).stdout)).toEqual({
      decision: 'deny',
    });
  });
});
