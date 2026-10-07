import type { FastifyInstance } from 'fastify';
import type { DeliverablesUsageResponse } from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { DeliverableCopies } from '../deliverables/copies.js';
import { bearerGuard } from './security.js';

/**
 * `GET /api/deliverables/usage` (P9-06; TECHNOLOGY §9.4): each project's (and scratch task's)
 * `deliverables/` folder and its size, for the settings page. A read, so remote clients may ask
 * too (TECHNOLOGY §9.9: lists are open to the phone). Bearer-guarded in its own scope.
 */
export function registerDeliverablesUsageRoute(
  parent: FastifyInstance,
  config: ServerConfig,
  copies: Pick<DeliverableCopies, 'usage'>,
): void {
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));
    app.get('/api/deliverables/usage', async () => {
      return (await copies.usage()) satisfies DeliverablesUsageResponse;
    });
  });
}
