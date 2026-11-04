import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HOOK_SECRET_HEADER, type HookBridge } from '../adapters/agy/hook-bridge.js';
import { isLoopback, isRemoteRequest } from './security.js';

/**
 * The Antigravity hook bridge's routes (P11-05; TECHNOLOGY §3.7), loopback only and keyed by a
 * session's secret (`x-galactic-hook`), never by the bearer token: they are called by the hook
 * and the tool server agy starts for a Mission Control Steward, which hold only that secret.
 *
 * - `POST /api/agy-hook` — agy's PreToolUse payload → `{decision: 'allow'|'deny', reason?}`. A
 *   long poll: it answers when the session decides (the user may take hours; the hook's own
 *   timeout is the limit). An unknown secret is `deny`.
 * - `POST /api/agy-hook/tools` — the session's MCP tool list `{tools}` (none for an unknown one).
 * - `POST /api/agy-hook/call` — `{name, arguments}` → an MCP `tools/call` result; long poll too.
 *
 * Anything not from this machine — or relayed by a proxy on it — is refused with 403, which the
 * hook reads as `deny`. Bodies may be large (a `write_file`'s content): up to 32 MiB.
 */

export interface AgyHookRoutesOptions {
  bridge: HookBridge;
}

const BODY_LIMIT = 32 * 1024 * 1024;

const secretOf = (req: FastifyRequest): string => {
  const v = req.headers[HOOK_SECRET_HEADER];
  return typeof v === 'string' ? v : '';
};

export function registerAgyHookRoutes(parent: FastifyInstance, opts: AgyHookRoutesOptions): void {
  void parent.register(async (app) => {
    app.addHook('onRequest', async (req, reply) => {
      if (!isLoopback(req.socket.remoteAddress) || isRemoteRequest(req)) {
        return reply
          .code(403)
          .send({ decision: 'deny', reason: 'the hook bridge answers this machine only' });
      }
    });

    app.post('/api/agy-hook', { bodyLimit: BODY_LIMIT }, async (req) =>
      opts.bridge.handle(secretOf(req), req.body),
    );

    app.post('/api/agy-hook/tools', async (req) => ({ tools: opts.bridge.tools(secretOf(req)) }));

    app.post('/api/agy-hook/call', { bodyLimit: BODY_LIMIT }, async (req) => {
      const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
      return opts.bridge.callTool(secretOf(req), body.name, body.arguments);
    });
  });
}
