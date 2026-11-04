import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { HookBridge, HOOK_SECRET_HEADER, mcpText } from '../adapters/agy/hook-bridge.js';
import { registerAgyHookRoutes } from './agy-hook-routes.js';

/** `POST /api/agy-hook[/tools|/call]` (P11-05): loopback only, keyed by the session's secret. */

const PAYLOAD = { toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } };

function app() {
  const bridge = new HookBridge();
  const fastify = Fastify();
  registerAgyHookRoutes(fastify, { bridge });
  return { bridge, fastify };
}

describe('agy hook routes', () => {
  it('answers the decision of the session the secret names; an unknown secret is denied', async () => {
    const { bridge, fastify } = app();
    bridge.register('s1', async () => 'allow');
    const ok = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook',
      headers: { [HOOK_SECRET_HEADER]: 's1' },
      payload: PAYLOAD,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ decision: 'allow' });
    const unknown = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook',
      headers: { [HOOK_SECRET_HEADER]: 'nope' },
      payload: PAYLOAD,
    });
    expect(unknown.json().decision).toBe('deny');
    const none = await fastify.inject({ method: 'POST', url: '/api/agy-hook', payload: PAYLOAD });
    expect(none.json().decision).toBe('deny');
  });

  it('refuses a request relayed by a proxy or from another machine', async () => {
    const { bridge, fastify } = app();
    bridge.register('s1', async () => 'allow');
    const proxied = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook',
      headers: { [HOOK_SECRET_HEADER]: 's1', 'x-forwarded-for': '100.64.0.2' },
      payload: PAYLOAD,
    });
    expect(proxied.statusCode).toBe(403);
    const remote = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook',
      remoteAddress: '192.168.1.20',
      headers: { [HOOK_SECRET_HEADER]: 's1' },
      payload: PAYLOAD,
    });
    expect(remote.statusCode).toBe(403);
  });

  it("serves the session's tools to the tool server", async () => {
    const { bridge, fastify } = app();
    const calls: unknown[] = [];
    bridge.register('s1', async () => 'allow', {
      list: () => [{ name: 'request_publish', description: 'd', inputSchema: { type: 'object' } }],
      call: async (name, args) => {
        calls.push([name, args]);
        return mcpText('{"ok":true}');
      },
    });
    const listed = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook/tools',
      headers: { [HOOK_SECRET_HEADER]: 's1' },
      payload: {},
    });
    expect(listed.json().tools.map((t: { name: string }) => t.name)).toEqual(['request_publish']);
    const called = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook/call',
      headers: { [HOOK_SECRET_HEADER]: 's1' },
      payload: { name: 'request_publish', arguments: { text: 'hello' } },
    });
    expect(called.json()).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
      isError: false,
    });
    expect(calls).toEqual([['request_publish', { text: 'hello' }]]);
    const stranger = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook/tools',
      headers: { [HOOK_SECRET_HEADER]: 'nope' },
      payload: {},
    });
    expect(stranger.json()).toEqual({ tools: [] });
    const strangerCall = await fastify.inject({
      method: 'POST',
      url: '/api/agy-hook/call',
      headers: { [HOOK_SECRET_HEADER]: 'nope' },
      payload: { name: 'request_publish', arguments: {} },
    });
    expect(strangerCall.json().isError).toBe(true);
  });
});
