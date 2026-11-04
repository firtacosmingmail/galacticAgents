import type { FastifyInstance } from 'fastify';
import { JobRunsQuery, type JobRunsResponse } from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { EventLog } from '../domain/event-log.js';
import { jobRuns } from '../domain/job-runs.js';
import { bearerGuard } from './security.js';

/**
 * Jobs' REST routes (P10-07; SPEC decision 144), bearer-guarded in their own scope:
 *
 * - `GET /api/jobs/:id/runs?limit=` — the job's runs, newest first (`limit` 1–200, default 20),
 *   for the Jobs tab's run history. Run rows are REST-only: they never travel on the stream.
 *
 * Read only, so a remote client may read them too. Errors: 400 `invalid_query`, 404 `not_found`.
 */

export interface JobRoutesOptions {
  log: EventLog;
}

export function registerJobRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: JobRoutesOptions,
): void {
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));

    app.get('/api/jobs/:id/runs', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!opts.log.tables.jobs.get(id)) {
        return reply.code(404).send({ error: 'not_found', message: `no job ${id}` });
      }
      const q = JobRunsQuery.safeParse(req.query ?? {});
      if (!q.success) {
        return reply.code(400).send({ error: 'invalid_query', issues: q.error.issues });
      }
      return { runs: jobRuns(opts.log, id, q.data.limit) } satisfies JobRunsResponse;
    });
  });
}
