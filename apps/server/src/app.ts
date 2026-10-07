import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { PROTOCOL_VERSION, type HealthResponse } from '@galactic/protocol';
import type { ServerConfig } from './config/config.js';
import {
  isAllowedHost,
  isRemoteRequest,
  isSameOriginFetch,
  tailscaleIdentityOf,
} from './http/security.js';
import { WsGateway, type SessionHandler } from './ws/gateway.js';
import { createSessionHandler } from './ws/session.js';
import { registerDevRoutes } from './http/dev-routes.js';
import { registerAgentRoutes, type AgentRoutesOptions } from './http/agent-routes.js';
import { registerPanelRoutes } from './http/panel-routes.js';
import { registerBackupRoutes } from './http/backup-routes.js';
import { registerDeliverableRoutes } from './http/deliverable-routes.js';
import type { BackupService } from './db/backup.js';
import type { DeliverableCopies } from './deliverables/copies.js';
import { registerDeliverablesUsageRoute } from './http/deliverables-usage-route.js';
import { isWebFile, webCacheControl } from './http/web-cache.js';
import { registerPushRoutes, type Push } from './push/index.js';
import type { SettingsService } from './config/settings.js';
import type { Opener } from './deliverables/opener.js';
import type { EventLog } from './domain/event-log.js';
import type { StatusStore } from './runtime/status-store.js';
import type { TranscriptPipeline } from './runtime/transcripts.js';
import { SERVER_VERSION } from './version.js';
import { sendStorageRefusal } from './http/storage-refusal.js';
import type { StorageMonitor } from './runtime/storage-health.js';

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
  /** A Steward's processes (P4-14): enables `GET`/`POST /api/agents/:id/processes…`. */
  processes?: AgentRoutesOptions['processes'];
  /** The Harmonizer's restart (P5-06): enables `POST /api/harmonizer/restart`. */
  restartHarmonizer?: AgentRoutesOptions['restartHarmonizer'];
  /** The settings service (P25-01): enables `GET`/`PATCH /api/settings`. */
  settings?: SettingsService;
  /** The opener on the Mac (P9-03): enables `GET /api/ide` and the deliverables' opens (P9-07). */
  opener?: Opener;
  /** Detection's rescan of a project (P9-05): enables `POST /api/projects/:id/deliverables/rescan`. */
  rescanDeliverables?: (projectId: string) => Promise<unknown>;
  /** Web Push (P7-04): enables `/api/push*`. */
  push?: Push;
  /** The database's write health (P8-09): sent to every socket for the panel's banner. */
  storage?: StorageMonitor;
  /** Backups (P8-03): enables `GET`/`POST /api/backups` (the export needs only `log`). */
  backups?: BackupService;
  /**
   * The deliverables folders (P9-06): enables `GET /api/deliverables/usage`, and the copy of a
   * user's file from outside the project added by hand (decision 122).
   */
  deliverableCopies?: Pick<DeliverableCopies, 'usage' | 'copyIn'>;
  /** Fastify's logger: on/off, or options (tests pass a `stream` to read what is logged). */
  logger?: boolean | { level?: string; stream?: { write(line: string): void } };
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

  // A route that lets a storage failure escape (P8-09): 507 `storage_full` / 503, never a bare 500.
  fastify.setErrorHandler((error, req, reply) => {
    if (sendStorageRefusal(reply, error)) {
      req.log.warn(`refused by the storage: ${error instanceof Error ? error.message : error}`);
      return reply;
    }
    return reply.send(error);
  });

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
    // The token is handed only to same-machine callers, so the local web page can pick it up
    // without pasting. A remote client reaching us through a proxy on this machine (Tailscale
    // Serve, `vite preview --host`) also arrives from loopback, maybe with no Origin at all (a
    // plain GET, curl): its Host or forwarding headers give it away (`isRemoteRequest`), and it
    // pastes the token (P3-08 review: the Origin check alone handed it to any LAN client).
    // Never to a remote client, not even one Tailscale identity authenticated (P7-02): the
    // identity is its credential, the long-lived token stays on this machine.
    // And only to a browser's own page (`Sec-Fetch-Site: same-origin`, or `none` for a typed
    // navigation): a speed bump for scripts and agents on this machine, not a boundary — any
    // local process can send that header too (docs/REMOTE_ACCESS.md §4).
    const remote = isRemoteRequest(req);
    body.origin = remote ? 'remote' : 'local';
    if (!remote && isSameOriginFetch(req)) {
      body.token = config.token;
    }
    const identity = tailscaleIdentityOf(req, config);
    if (identity) body.identity = identity;
    return body;
  });

  if (opts.webDir) {
    const webDir = opts.webDir;
    void fastify.register(fastifyStatic, {
      root: webDir,
      // One wildcard route that looks a file up per request (P7-01 review): `wildcard: false`
      // lists the files at startup, so a rebuild without a restart 404'd its new assets — a blank
      // page and a service worker that failed to install. Dotfiles stay unserved.
      wildcard: true,
      dotfiles: 'ignore',
      setHeaders: (reply, path) =>
        void reply.header('cache-control', webCacheControl(webDir, path)),
    });
    fastify.setNotFoundHandler((req, reply) => {
      // Single-page app: unknown GET paths load the page; API-shaped paths stay 404, and so do
      // missing build files (P7-01: the service worker must never keep the page as a script).
      if (
        req.method === 'GET' &&
        !req.url.startsWith('/dev/') &&
        !req.url.startsWith('/api/') &&
        !req.url.startsWith('/health') &&
        !req.url.startsWith('/files/') &&
        !isWebFile(req.url)
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
  if (opts.log && config.dev) {
    registerDevRoutes(fastify, config, {
      log: opts.log,
      ...(opts.commands ? { commands: opts.commands } : {}),
      ...(opts.statuses ? { statuses: opts.statuses } : {}),
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
    });
  }
  if (opts.log && opts.runtime) {
    registerAgentRoutes(fastify, config, {
      runtime: opts.runtime,
      log: opts.log,
      ...(opts.scenarios ? { scenarios: opts.scenarios } : {}),
      ...(opts.commands ? { commands: opts.commands } : {}),
      ...(opts.processes ? { processes: opts.processes } : {}),
      ...(opts.restartHarmonizer ? { restartHarmonizer: opts.restartHarmonizer } : {}),
    });
  }
  // The side panel's history, settings, preflight and notifications (P25-01).
  if (opts.log) {
    registerPanelRoutes(fastify, config, {
      log: opts.log,
      ...(opts.runtime ? { runtime: opts.runtime } : {}),
      ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
      ...(opts.settings ? { settings: opts.settings } : {}),
      ...(opts.opener ? { opener: opts.opener } : {}),
    });
  }

  // Backups and the map export (P8-03).
  if (opts.log && opts.commands) {
    registerDeliverableRoutes(fastify, config, {
      log: opts.log,
      commands: opts.commands,
      ...(opts.opener ? { opener: opts.opener } : {}),
      ...(opts.rescanDeliverables ? { rescan: opts.rescanDeliverables } : {}),
      ...(opts.deliverableCopies ? { copies: opts.deliverableCopies } : {}),
    });
  }

  if (opts.log) {
    registerBackupRoutes(fastify, config, {
      log: opts.log,
      ...(opts.backups ? { backups: opts.backups } : {}),
    });
  }

  // The deliverables folders' sizes for the settings page (P9-06).
  if (opts.deliverableCopies) {
    registerDeliverablesUsageRoute(fastify, config, opts.deliverableCopies);
  }

  if (opts.push) {
    registerPushRoutes(fastify, config, { push: opts.push.service, store: opts.push.store });
  }

  const onSession =
    opts.onSession ??
    (opts.log
      ? createSessionHandler(opts.log, {
          log: logSink,
          ...(opts.transcripts ? { transcripts: opts.transcripts } : {}),
          ...(opts.statuses ? { statuses: opts.statuses } : {}),
          ...(opts.storage ? { storage: opts.storage } : {}),
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
