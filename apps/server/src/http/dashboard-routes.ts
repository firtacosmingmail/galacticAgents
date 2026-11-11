import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ArrangePanelsRequest,
  LONG_TERM_LIMITS,
  isLongTerm,
  type Actor,
  type ClearJobValuesResponse,
  type DashboardResponse,
  type RefreshJobResponse,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { Commands } from '../domain/commands.js';
import { evaluateDashboard } from '../domain/dashboard.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { jobRuns } from '../domain/job-runs.js';
import { panelsOf } from '../domain/panels.js';
import type { JobScheduler } from '../runtime/job-scheduler.js';
import { bearerGuard } from './security.js';

/**
 * The project dashboard's REST routes (P15-04; SPEC decision 156), bearer-guarded in their own
 * scope:
 *
 * - `GET /api/projects/:id/dashboard` — every panel's data now (`evaluatePanel`), in dashboard
 *   order (`DashboardResponse`). 400 `invalid` for a project that is not long-term.
 * - `POST /api/jobs/:id/refresh` — runs the job now (`JobScheduler.runNow`): `{runId, started}`.
 * - `POST /api/panels/:id/clear-history` — the panel ignores the runs before now. 204.
 * - `POST /api/jobs/:id/clear-values` — deletes the job's stored values: `{panels}` it touched.
 * - `PUT /api/projects/:id/dashboard/layout` — `{layouts}`, every panel once. 204.
 *
 * The four writes are the user's own dashboard actions (never an agent's), so a remote client —
 * the phone — may make them too (decision 90 style: they grant nothing). Refusals: 404
 * `not_found`, 400 `invalid` / `invalid_body`, 409 for the rest (`limit`: no slot for a refresh).
 */

export interface DashboardRoutesOptions {
  log: EventLog;
  commands: Pick<Commands, 'clearPanelHistory' | 'clearJobValues' | 'arrangePanels'>;
  /** The job scheduler; absent: refresh answers 503 `unavailable`. */
  jobs?: Pick<JobScheduler, 'runNow'>;
}

const USER: Actor = { type: 'user' };

export function registerDashboardRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: DashboardRoutesOptions,
): void {
  const { log, commands, jobs } = opts;

  const refuse = (req: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (!(error instanceof DomainError)) {
      req.log.error(error);
      return reply.code(500).send({ error: 'internal' });
    }
    const status = error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 409;
    return reply.code(status).send({ error: error.code, message: error.message });
  };

  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));

    app.get('/api/projects/:id/dashboard', async (req, reply) => {
      const { id } = req.params as { id: string };
      const project = log.tables.projects.get(id);
      if (!project)
        return reply.code(404).send({ error: 'not_found', message: `no project ${id}` });
      if (!isLongTerm(project)) {
        return reply
          .code(400)
          .send({ error: 'invalid', message: 'a dashboard belongs to a long-term project' });
      }
      const now = log.clock();
      const tasks = log.tables.tasks.all().filter((t) => t.projectId === id);
      const panels = evaluateDashboard(
        panelsOf(log, id),
        {
          job: (jobId) => log.tables.jobs.get(jobId),
          runs: (jobId) => jobRuns(log, jobId, LONG_TERM_LIMITS.runsKept),
          tasks,
        },
        now,
      );
      return { panels } satisfies DashboardResponse;
    });

    app.post('/api/jobs/:id/refresh', async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!jobs) {
        return reply.code(503).send({ error: 'unavailable', message: 'no job scheduler' });
      }
      try {
        return (await jobs.runNow(id, USER)) satisfies RefreshJobResponse;
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.post('/api/panels/:id/clear-history', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await commands.clearPanelHistory(id, USER);
        return reply.code(204).send();
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.post('/api/jobs/:id/clear-values', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const { panels } = (await commands.clearJobValues(id, USER)).value;
        return { panels } satisfies ClearJobValuesResponse;
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.put('/api/projects/:id/dashboard/layout', async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = ArrangePanelsRequest.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }
      try {
        await commands.arrangePanels(id, body.data.layouts, USER);
        return reply.code(204).send();
      } catch (error) {
        return refuse(req, reply, error);
      }
    });
  });
}
