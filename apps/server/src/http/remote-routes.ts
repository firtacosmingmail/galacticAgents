import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  RemoteStartBody,
  RemoteStopBody,
  type RemoteActionResponse,
  type RemoteStatus,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { RemoteService } from '../remote/service.js';
import type { PeerCheck } from './peer-guard.js';
import { bearerGuard, requireLocal } from './security.js';

/**
 * Phone access (P9-16; SPEC decision 137; `docs/REMOTE_ACCESS.md`), bearer-guarded in its own
 * scope:
 *
 * - `GET /api/remote/status` — Tailscale, `remoteHost`, Serve, whether the phone can reach us and
 *   the remote sockets connected; read-only, every client (the phone shows it too); cached 5 s;
 * - `POST /api/remote/start` / `POST /api/remote/stop` — the Mac only, **even with
 *   `autoApproveRemote`** (`requireLocal({always: true})`): they change the Mac's Tailscale
 *   configuration. And not from an agent's or a run's process (`peer`, the P9-12 speed bump, as on
 *   the runs routes): an agent holding the token must not publish the Mac to the tailnet. A
 *   refusal is 409 `remote_refused` with the reason and the status.
 */
export interface RemoteRoutesOptions {
  service: Pick<RemoteService, 'status' | 'start' | 'stop'>;
  /** The agent speed bump (P9-12 review S3); `index.ts` passes the OS one. */
  peer?: PeerCheck;
}

export function registerRemoteRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: RemoteRoutesOptions,
): void {
  const remote = opts.service;

  /** Refuses a request from an agent's or a run's process; an unknown peer is allowed, logged. */
  const notFromAnAgent = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!opts.peer) return true;
    let verdict;
    try {
      verdict = await opts.peer(req);
    } catch (error) {
      req.log.warn({ err: error }, 'phone access: the peer could not be identified; allowed');
      return true;
    }
    if (verdict.unknown)
      req.log.warn(`phone access: the peer could not be identified (${verdict.unknown}); allowed`);
    if (!verdict.refused) return true;
    void reply.code(403).send({ error: 'agent_peer', message: verdict.refused });
    return false;
  };

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
        if (!(await notFromAnAgent(req, reply))) return reply;
        const parsed = (action === 'start' ? RemoteStartBody : RemoteStopBody).safeParse(
          req.body ?? {},
        );
        if (!parsed.success) {
          return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
        }
        const { httpStatus, ...body } =
          action === 'start'
            ? await remote.start(parsed.data as RemoteStartBody)
            : await remote.stop(parsed.data as RemoteStopBody);
        return reply.code(httpStatus).send(body satisfies RemoteActionResponse);
      });
    }
  });
}
