import Fastify, { type FastifyInstance } from 'fastify';
import { PROTOCOL_VERSION, type HealthResponse } from '@galactic/protocol';
import type { ServerConfig } from './config/config.js';
import { isAllowedHost, isAllowedOrigin, isLoopback } from './http/security.js';
import { WsGateway, type SessionHandler } from './ws/gateway.js';
import { createSessionHandler } from './ws/session.js';
import { registerDevRoutes } from './http/dev-routes.js';
import type { EventLog } from './domain/event-log.js';
import { SERVER_VERSION } from './version.js';

export interface AppOptions {
  config: ServerConfig;
  /** Explicit session handler; defaults to the resumable stream over `log`. */
  onSession?: SessionHandler;
  /** The event log; enables the stream handler, `/health.seq` and the `/dev/*` routes. */
  log?: EventLog;
  logger?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  gateway: WsGateway;
  /** Binds `config.host:config.port` (port 0 picks a free one) and returns the bound port. */
  listen(): Promise<number>;
  close(): Promise<void>;
}

export function buildApp(opts: AppOptions): App {
  const { config } = opts;
  const fastify = Fastify({ logger: opts.logger ?? false });

  // DNS-rebinding guard on every HTTP request (TECHNOLOGY §8).
  fastify.addHook('onRequest', async (req, reply) => {
    if (!isAllowedHost(req.headers.host, config.allowedHosts)) {
      return reply.code(403).send({ error: 'forbidden_host' });
    }
  });

  fastify.get('/health', async (req): Promise<HealthResponse> => {
    const body: HealthResponse = {
      ok: true,
      name: 'galactic-agents',
      version: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      seq: opts.log?.currentSeq() ?? 0,
    };
    // The token is handed only to same-machine callers from an allowed (or no) Origin, so the
    // local web page can pick it up without pasting; remote clients (Phase 7) paste or scan it.
    if (
      isLoopback(req.socket.remoteAddress) &&
      isAllowedOrigin(req.headers.origin, config.allowedHosts)
    ) {
      body.token = config.token;
    }
    return body;
  });

  const logSink = {
    info: (m: string) => fastify.log.info(m),
    warn: (m: string) => fastify.log.warn(m),
  };
  if (opts.log) registerDevRoutes(fastify, config, opts.log);

  const onSession =
    opts.onSession ??
    (opts.log
      ? createSessionHandler(opts.log, { log: logSink })
      : () => {
          throw new Error('buildApp needs either onSession or log');
        });

  const gateway = new WsGateway({ config, onSession, log: logSink });

  return {
    fastify,
    gateway,
    async listen() {
      await fastify.ready();
      fastify.server.on('upgrade', gateway.handleUpgrade);
      await fastify.listen({ host: config.host, port: config.port });
      const address = fastify.server.address();
      return typeof address === 'object' && address ? address.port : config.port;
    },
    async close() {
      await gateway.close();
      await fastify.close();
    },
  };
}
