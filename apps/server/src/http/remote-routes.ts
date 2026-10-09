import type { FastifyInstance } from 'fastify';
import type { RemoteActionResponse, RemoteStatus } from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { RemoteService } from '../remote/service.js';
import { bearerGuard, requireLocal } from './security.js';

/**
 * Phone access (P9-16; SPEC decision 137; `docs/REMOTE_ACCESS.md`), bearer-guarded in its own
 * scope:
 *
 * - `GET /api/remote/status` — Tailscale, `remoteHost`, Serve, whether the phone can reach us and
 *   the remote sockets connected; read-only, every client (the phone shows it too); cached 5 s;
 * - `POST /api/remote/start` / `POST /api/remote/stop` — the Mac only, **even with
 *   `autoApproveRemote`** (`requireLocal({always: true})`): they change the Mac's Tailscale
 *   configuration. A refusal is 409 `remote_refused` with the reason and the status.
 */
export function registerRemoteRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  remote: Pick<RemoteService, 'status' | 'start' | 'stop'>,
): void {
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));
    app.get('/api/remote/status', async () => (await remote.status()) satisfies RemoteStatus);
    for (const action of ['start', 'stop'] as const) {
      app.post(`/api/remote/${action}`, async (req, reply) => {
        const refusal = requireLocal(req, {
          always: true,
          what: action === 'start' ? 'Turning on phone access' : 'Turning off phone access',
        });
        if (refusal) return reply.code(403).send(refusal);
        const { httpStatus, ...body } = await remote[action]();
        return reply.code(httpStatus).send(body satisfies RemoteActionResponse);
      });
    }
  });
}
