import type { FastifyInstance } from 'fastify';
import { Event } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import type { ServerConfig } from '../config/config.js';
import { tokenMatches } from './security.js';

/**
 * Bearer-token guarded routes used by the web page, `galactic` scripts and tests to poke the
 * event log before any agent exists (Phase 0 exit criterion: "a fake event emitted on the
 * server appears in the browser").
 */
export function registerDevRoutes(app: FastifyInstance, config: ServerConfig, log: EventLog): void {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/dev/')) return;
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!tokenMatches(presented, config.token)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  /** Appends one event (validated against the protocol) under the one write rule. */
  app.post('/dev/events', async (req, reply) => {
    const parsed = Event.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_event', issues: parsed.error.issues });
    }
    try {
      const out = log.runCommand(({ emit }) => emit(parsed.data));
      return { seq: out.events[0]!.seq };
    } catch (error) {
      return reply.code(400).send({ error: 'rejected', message: (error as Error).message });
    }
  });

  app.get('/dev/events', async (req) => {
    const since = Number((req.query as { since?: string }).since ?? 0);
    return { seq: log.currentSeq(), events: log.eventsSince(Number.isFinite(since) ? since : 0) };
  });
}
