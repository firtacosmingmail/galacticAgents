import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import {
  PushEndpointRequest,
  PushSubscribeRequest,
  type PushDeviceResponse,
  type PushStatusResponse,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import { bearerGuard, originOf } from '../http/security.js';
import { isPushServiceEndpoint } from './endpoint.js';
import type { PushService } from './service.js';
import type { PushStore } from './store.js';

/** At most this many devices; a new one beyond is refused (409 `too_many_devices`). */
export const MAX_PUSH_DEVICES = 20;

export interface PushRoutesOptions {
  push: PushService;
  store: PushStore;
}

/**
 * The push endpoints (P7-04), bearer-guarded in their own scope like every `/api` route:
 *
 * - `GET /api/push` — the VAPID public key and the subscribed devices (ids and labels, never an
 *   endpoint or a key). Makes the key pair on first call.
 * - `PUT /api/push/subscription` — subscribe this device or change its toggles (upsert by
 *   endpoint). Whoever holds a subscription owns it, so the phone manages its own device like the
 *   Mac does (decision 90: push is per device, not a server-wide setting). The endpoint must be a
 *   browser push service (400 `invalid_endpoint`): the server POSTs to it.
 * - `POST /api/push/unsubscribe` — remove this device (by its endpoint).
 * - `POST /api/push/test` — a test push to this device; 404 when it is not subscribed, 429 within
 *   5 s of the last one.
 * - `DELETE /api/push/devices/:id` — remove any device: from the Mac only, unless
 *   `autoApproveRemote` (403 `remote_control`, decision 90), since it silences another device.
 */
export function registerPushRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: PushRoutesOptions,
): void {
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));
    const { push, store } = opts;

    const parse = <T>(schema: z.ZodType<T>, input: unknown, reply: FastifyReply) => {
      const parsed = schema.safeParse(input ?? {});
      if (parsed.success) return parsed.data;
      void reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      return undefined;
    };
    const mayRemoveOthers = (req: Parameters<typeof originOf>[0]) =>
      config.autoApproveRemote || originOf(req) === 'local';

    app.get('/api/push', async (req): Promise<PushStatusResponse> => ({
      publicKey: push.publicKey(),
      devices: store.list().map((s) => s.device),
      canRemoveOthers: mayRemoveOthers(req),
    }));

    app.put('/api/push/subscription', async (req, reply) => {
      const body = parse(PushSubscribeRequest, req.body, reply);
      if (!body) return;
      if (!isPushServiceEndpoint(body.subscription.endpoint)) {
        return reply.code(400).send({
          error: 'invalid_endpoint',
          message: 'The subscription does not point at a known browser push service.',
        });
      }
      if (
        !store.byEndpoint(body.subscription.endpoint) &&
        store.list().length >= MAX_PUSH_DEVICES
      ) {
        return reply.code(409).send({
          error: 'too_many_devices',
          message: `At most ${MAX_PUSH_DEVICES} devices can receive push notifications; remove one first.`,
        });
      }
      const stored = store.upsert({
        subscription: body.subscription,
        kinds: body.kinds,
        details: body.details,
        label: body.label,
        origin: originOf(req),
      });
      return { device: stored.device } satisfies PushDeviceResponse;
    });

    app.post('/api/push/unsubscribe', async (req, reply) => {
      const body = parse(PushEndpointRequest, req.body, reply);
      if (!body) return;
      const existing = store.byEndpoint(body.endpoint);
      return { ok: true, removed: existing ? store.remove(existing.device.id) : false };
    });

    app.post('/api/push/test', async (req, reply) => {
      const body = parse(PushEndpointRequest, req.body, reply);
      if (!body) return;
      const result = await push.test(body.endpoint);
      if (result === undefined) return reply.code(404).send({ error: 'not_found' });
      if (result === 'too_soon') return reply.code(429).send({ error: 'rate_limited' });
      return { ok: result === 'sent', result };
    });

    app.delete('/api/push/devices/:id', async (req, reply) => {
      if (!mayRemoveOthers(req)) {
        return reply.code(403).send({
          error: 'remote_control',
          message:
            "Removing another device's push notifications works only from this machine's own browser.",
        });
      }
      const id = (req.params as { id: string }).id;
      if (!store.remove(id)) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    });
  });
}
