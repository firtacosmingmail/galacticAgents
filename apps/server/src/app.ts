import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { PROTOCOL_VERSION, type HealthResponse } from '@galactic/protocol';
import type { ServerConfig } from './config/config.js';
import { isAllowedHost, isLoopback, isLoopbackOrigin } from './http/security.js';
import { WsGateway, type SessionHandler } from './ws/gateway.js';
import { createSessionHandler } from './ws/session.js';
import { registerDevRoutes } from './http/dev-routes.js';
import { registerAgentRoutes, type AgentRoutesOptions } from './http/agent-routes.js';
import { registerPanelRoutes } from './http/panel-routes.js';
import type { SettingsService } from './config/settings.js';
import type { EventLog } from './domain/event-log.js';
import type { StatusStore } from './runtime/status-store.js';
import type { TranscriptPipeline } from './runtime/transcripts.js';
import { SERVER_VERSION } from './version.js';

export interface AppOptions {
  config: ServerConfig;
  /** Explicit session handler; defaults to the resumable stream over `log`. */
  onSession?: SessionHandler;
  /** The event log; enables the stream handler, `/health.seq` and (with `config.dev`) `/dev/*`. */
  log?: EventLog;
  /** A built web app (apps/web/dist) to serve at `/`; `galactic start` sets it. */
  webDir?: string;
  /** The transcript stream (P1-06): enables `transcript.subscribe` on the socket. */
  transcripts?: TranscriptPipeline;
  /** The status store (P1-05): its diffs are pushed to every socket. */
  statuses?: StatusStore;
  /** The agent runtime (P1-11): enables the `/api/*` control routes. */
  runtime?: AgentRoutesOptions['runtime'];
  /** Fake-adapter scenario names for the spawn form. */
  scenarios?: () => string[];
  /** The command surface (P2-01): enables `POST /api/control` (P2-14). */
  commands?: AgentRoutesOptions['commands'];
  /** The settings service (P25-01): enables `GET`/`PATCH /api/settings`. */
  settings?: SettingsService;
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
      ...(opts.log ? { logId: opts.log.logId } : {}),
    };
    // The token is handed only to same-machine callers whose Origin (if any) is this machine, so
    // the local web page can pick it up without pasting. A remote page reaching us through a
    // reverse proxy (Phase 7) also arrives from loopback but with its own Origin: it pastes.
    if (isLoopback(req.socket.remoteAddress) && isLoopbackOrigin(req.headers.origin)) {
      body.token = config.token;
    }
    return body;
  });

  if (opts.webDir) {
    void fastify.register(fastifyStatic, { root: opts.webDir, wildcard: false });
    fastify.setNotFoundHandler((req, reply) => {
      // Single-page app: unknown GET paths load the page; API-shaped paths stay 404.
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/dev/') &&
        !req.url.startsWith('/api/') &&
        !req.url.startsWith('/health')
      ) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  const logSink = {
    info: (m: string) => fastify.log.info(m),
    warn: (m: string) => fastify.log.warn(m),
  };
  if (opts.log && config.dev) registerDevRoutes(fastify, config, opts.log);
  if (opts.log && opts.runtime) {
    registerAgentRoutes(fastify, config, {
      runtime: opts.runtime,
      log: opts.log,
      ...(opts.scenarios ? { scenarios: opts.scenarios } : {}),
      ...(opts.commands ? { commands: opts.commands } : {}),
    });
  }
  // The side panel's history, settings, preflight and notifications (P25-01).
  if (opts.log) {
    registerPanelRoutes(fastify, config, {
      log: opts.log,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
      ...(opts.settings ? { settings: opts.settings } : {}),
    });
  }

  const onSession =
    opts.onSession ??
    (opts.log
      ? createSessionHandler(opts.log, {
          log: logSink,
          ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
          ...(opts.statuses ? { statuses: opts.statuses } : {}),
        })
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
