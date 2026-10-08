import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  RunOutputQuery,
  RunPreviewBody,
  StartRunBody,
  type Actor,
  type DeliverableRun,
  type RunOutputResponse,
  type RunPreviewResponse,
  type RunsResponse,
  type StartRunResponse,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import { RunError, type RunService } from '../deliverables/runs.js';
import type { RunOutput } from '../deliverables/run-output.js';
import type { EventLog } from '../domain/event-log.js';
import { redactSecrets } from '../runtime/redact.js';
import type { PeerCheck } from './peer-guard.js';
import { bearerGuard, requireLocal } from './security.js';
import { sendStorageRefusal } from './storage-refusal.js';

/**
 * Managed runs' REST routes (P9-08; TECHNOLOGY §9.8, §9.9; SPEC decisions 129–131).
 *
 * | Route | Remote client |
 * |---|---|
 * | `GET /api/deliverables/:id/run-preview` — what the Run dialog shows | yes (read only) |
 * | `POST /api/deliverables/:id/run-preview {line?}` — the same for the line edited in the dialog | yes (read only) |
 * | `GET /api/deliverables/:id/runs` — the command's runs, newest first | yes |
 * | `GET /api/runs/:id/output?after=&limit=` — a run's output, paged by `seq` | yes |
 * | `POST /api/runs/:id/stop` — the user's Stop (the panel confirms first) | yes (decision 131) |
 * | `POST /api/deliverables/:id/runs {version, line?, confirmation}` — Run, after the confirmation | never (403 `remote_control`) |
 * | `POST /api/runs/:id/restart {version, line?, confirmation}` — Stop, then Run with the confirmation | never (403 `remote_control`) |
 *
 * Starting and restarting run a program on the Mac: never from a remote client, `autoApproveRemote`
 * or not (decision 131). The permission table does not apply — the user's confirmation is the gate
 * (decision 129) — so nothing here asks the policy. `confirmation` is the preview's token for
 * exactly the line started (the stored one, or `line`): a start of any other line is 400
 * `unconfirmed` (wave-3 review S3). Errors: 400 `invalid_body` / `invalid_query` / `invalid` /
 * `unconfirmed`; 403 `remote_control`; 404 `not_found`; 409 `stale` (with the current row, so the
 * dialog shows the new command), `running`, `run_cap`, `after_merge`, `folder`; 500 `start_failed`;
 * 507 / 503 when the launch intent or `run.started` cannot be written (decision 107).
 *
 * **The agent speed bump** (P9-12 review S3, `peer-guard.ts`): with `peer`, a start, a restart and
 * the preview of an edited line from a process on this machine that is an agent's or a run's (its
 * environment, or an ancestor's, carries the marker; or it runs below Mission Control) is 403
 * `agent_peer`. The bearer token remains the only boundary: whoever holds it can run any command
 * (TECHNOLOGY §9.9, docs/REMOTE_ACCESS.md §4).
 */

const USER: Actor = { type: 'user' };

export interface RunRoutesOptions {
  log: EventLog;
  runs: RunService;
  output: RunOutput;
  /** The agent speed bump (S3): who is on the other end of a start's connection. */
  peer?: PeerCheck;
}

export function registerRunRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: RunRoutesOptions,
): void {
  const { runs, output } = opts;

  const refuse = (req: FastifyRequest, reply: FastifyReply, error: unknown) => {
    if (sendStorageRefusal(reply, error)) return reply;
    if (error instanceof RunError) {
      return reply.code(error.status).send({
        error: error.code,
        message: redactSecrets(error.message),
        ...(error.deliverable ? { deliverable: error.deliverable } : {}),
      });
    }
    req.log.error(error);
    return reply.code(500).send({ error: 'internal' });
  };

  /** Starting a run is the Mac's alone (decision 131): 403 to a remote client, always. */
  const onTheMac = (req: FastifyRequest, reply: FastifyReply, what: string): boolean => {
    const refused = requireLocal(req, { always: true, what });
    if (!refused) return true;
    void reply.code(403).send(refused);
    return false;
  };

  /** Refuses a request from an agent's or a run's process (the speed bump, S3). */
  const notFromAnAgent = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (!opts.peer) return true;
    let verdict;
    try {
      verdict = await opts.peer(req);
    } catch (error) {
      req.log.warn({ err: error }, 'runs: the peer could not be identified; allowed');
      return true;
    }
    if (verdict.unknown)
      req.log.warn(`runs: the peer could not be identified (${verdict.unknown}); allowed`);
    if (!verdict.refused) return true;
    void reply.code(403).send({ error: 'agent_peer', message: verdict.refused });
    return false;
  };

  const withLiveState = (run: DeliverableRun): DeliverableRun => {
    if (run.state === 'ended') return run;
    const live = runs.liveRun(run.deliverableId);
    return live?.runId === run.id ? { ...run, state: live.state } : run;
  };

  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));
    const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
    const tables = () => opts.log.tables;

    app.get('/api/deliverables/:id/run-preview', async (req, reply) => {
      try {
        return runs.preview(idOf(req)) satisfies RunPreviewResponse;
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    // The preview of the line the user edited (its warnings, its confirmation). Reads only.
    app.post('/api/deliverables/:id/run-preview', async (req, reply) => {
      const body = RunPreviewBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }
      if (body.data.line !== undefined && !(await notFromAnAgent(req, reply))) return reply;
      try {
        return runs.preview(idOf(req), body.data.line) satisfies RunPreviewResponse;
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.get('/api/deliverables/:id/runs', async (req, reply) => {
      const row = tables().deliverables.get(idOf(req));
      if (!row) return reply.code(404).send({ error: 'not_found', message: 'no such deliverable' });
      return {
        runs: tables().runs.of(row.id, 50).map(withLiveState),
      } satisfies RunsResponse;
    });

    app.get('/api/runs/:id/output', async (req, reply) => {
      const runId = idOf(req);
      if (!tables().runs.get(runId)) {
        return reply.code(404).send({ error: 'not_found', message: `no run ${runId}` });
      }
      const q = RunOutputQuery.safeParse(req.query ?? {});
      if (!q.success)
        return reply.code(400).send({ error: 'invalid_query', issues: q.error.issues });
      return output.page(runId, q.data.after ?? 0, q.data.limit) satisfies RunOutputResponse;
    });

    app.post('/api/deliverables/:id/runs', async (req, reply) => {
      if (!onTheMac(req, reply, 'Running a command')) return reply;
      if (!(await notFromAnAgent(req, reply))) return reply;
      const body = StartRunBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }
      try {
        const run = await runs.start(idOf(req), body.data, USER);
        return reply.code(201).send({ run } satisfies StartRunResponse);
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    // The phone may stop a run, never start one (decision 131).
    app.post('/api/runs/:id/stop', async (req, reply) => {
      try {
        return { run: await runs.stop(idOf(req), USER) } satisfies StartRunResponse;
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.post('/api/runs/:id/restart', async (req, reply) => {
      if (!onTheMac(req, reply, 'Restarting a command')) return reply;
      if (!(await notFromAnAgent(req, reply))) return reply;
      const body = StartRunBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
      }
      try {
        // Every start check (version, confirmation, folder, cap without this run) comes before
        // anything is stopped: a restart that could not start again stops nothing.
        const run = await runs.restart(idOf(req), body.data, USER);
        return reply.code(201).send({ run } satisfies StartRunResponse);
      } catch (error) {
        return refuse(req, reply, error);
      }
    });
  });
}
