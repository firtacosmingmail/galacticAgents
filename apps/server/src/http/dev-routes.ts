import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Event, type Body, type Project } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import type { ServerConfig } from '../config/config.js';
import { bearerGuard } from './security.js';

/**
 * Bearer-token guarded routes used by the web page, `galactic` scripts and tests to poke the
 * event log before any agent exists (Phase 0 exit criterion: "a fake event emitted on the
 * server appears in the browser"). Registered only with `GALACTIC_DEV=1` (P0-16).
 *
 * Only `agent.*` events may be appended directly: they touch no domain table, so a client that
 * replays them and one that takes a snapshot agree. Domain state is seeded through a proper
 * command (`/dev/seed`) that writes the rows and the events together.
 */
export function registerDevRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  log: EventLog,
): void {
  // An encapsulated scope: the guard runs for every route registered in it (P1-28).
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));

    /** Appends one `agent.*` event (validated against the protocol) under the one write rule. */
    app.post('/dev/events', async (req, reply) => {
      const parsed = Event.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_event', issues: parsed.error.issues });
      }
      if (!parsed.data.type.startsWith('agent.')) {
        return reply.code(400).send({
          error: 'not_a_demo_event',
          message: 'only agent.* events may be appended directly; domain state comes from commands',
        });
      }
      try {
        const out = log.runCommand(({ emit }) => emit(parsed.data));
        return { seq: out.events[0]!.seq };
      } catch (error) {
        return reply.code(400).send({ error: 'rejected', message: (error as Error).message });
      }
    });

    /** Creates a demo planet with a project on it — rows and events in one command. */
    app.post('/dev/seed', async () => {
      const out = log.runCommand(({ tables, emit }) => {
        const n = tables.projects.all().length + 1;
        const now = new Date().toISOString();
        const body: Body = { id: `b-${randomUUID()}`, kind: 'planet', name: `Demo planet ${n}` };
        const project: Project = {
          id: `p-${randomUUID()}`,
          name: `Demo project ${n}`,
          workspace: `/tmp/galactic-demo-${n}`,
          bodyId: body.id,
          state: 'in_progress',
          createdAt: now,
          updatedAt: now,
        };
        const host = { kind: 'project', id: project.id } as const;
        tables.bodies.insert({ ...body, host });
        tables.projects.insert(project);
        emit({ type: 'body.created', body });
        emit({ type: 'project.created', project });
        emit({ type: 'body.assigned', bodyId: body.id, host });
        return project;
      });
      return { seq: out.events.at(-1)!.seq, projectId: out.value.id, name: out.value.name };
    });

    app.get('/dev/events', async (req) => {
      const since = Number((req.query as { since?: string }).since ?? 0);
      return { seq: log.currentSeq(), events: log.eventsSince(Number.isFinite(since) ? since : 0) };
    });
  });
}
