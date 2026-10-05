import type { ServerConfig } from '../config/config.js';
import type { Database } from '../db/database.js';
import { PushService, type PushLog, type PushTransport } from './service.js';
import { PushStore } from './store.js';
import { vapidSubject } from './vapid.js';

export { PushService, PushSendError, pushPayloadFor, webPushTransport } from './service.js';
export { PushStore } from './store.js';
export { registerPushRoutes } from './routes.js';
export { isPushServiceEndpoint, pushDeviceId } from './endpoint.js';
export { loadOrCreateVapidKeys, vapidSubject, VAPID_FILE } from './vapid.js';

export interface Push {
  service: PushService;
  store: PushStore;
}

/** Web Push (P7-04) over the server's database and data directory; keys are made on first need. */
export function createPush(
  db: Database,
  config: Pick<ServerConfig, 'dataDir' | 'remoteHost'>,
  opts: { log?: PushLog; transport?: PushTransport; env?: NodeJS.ProcessEnv } = {},
): Push {
  const store = new PushStore(db);
  const service = new PushService({
    store,
    dataDir: config.dataDir,
    subject: vapidSubject(opts.env ?? process.env, config.remoteHost),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.transport ? { transport: opts.transport } : {}),
  });
  return { service, store };
}
