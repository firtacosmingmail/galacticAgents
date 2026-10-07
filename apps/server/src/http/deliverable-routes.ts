import { closeSync } from 'node:fs';
import { basename } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  AddDeliverableBody,
  DeliverablesQuery,
  EditDeliverableBody,
  OpenDeliverableBody,
  PATH_KINDS,
  RemoveDeliverableBody,
  type Actor,
  type AddDeliverableInput,
  type Deliverable,
  type DeliverableEdit,
  type DeliverableListItem,
  type DeliverablesResponse,
  type DownloadTicketResponse,
  type Id,
  type OpenConfirmation,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import { isAppName, fileFacts, TEXT_CONTENT_TYPE } from '../deliverables/facts.js';
import { confirmationCovers, OpenerError, type Opener } from '../deliverables/opener.js';
import {
  checkPath,
  identityOf,
  openChecked,
  type DeliverableRoots,
} from '../deliverables/paths.js';
import {
  DownloadTickets,
  FILE_HEADERS,
  TICKET_PATTERN,
  checkOptionsOf,
  contentPlan,
  factsView,
  fileHeaders,
  openForServing,
  refusalStatus,
  rootsOf,
  streamFile,
  ticketMatches,
  type OpenedFile,
} from '../deliverables/serve.js';
import type { Commands } from '../domain/commands.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { redactSecrets } from '../runtime/redact.js';
import { bearerGuard, originOf, requireLocal } from './security.js';
import { sendStorageRefusal } from './storage-refusal.js';

/**
 * The deliverables' REST routes (P9-07; TECHNOLOGY §9.3 "By hand", §9.6, §9.7, §9.9; SPEC
 * decisions 125–128, 131). Every route takes a deliverable id, never a path to read: a stored
 * path is re-checked against its roots on every read (`deliverables/serve.ts`).
 *
 * | Route | Remote client |
 * |---|---|
 * | `GET /api/deliverables?projectId=&taskId=&removed=` — rows plus live file facts | yes |
 * | `GET /api/deliverables/:id/content` — the viewer's bytes (preview limits, `X-Truncated`) | yes |
 * | `POST /api/deliverables/:id/download` → `{url: '/files/<ticket>'}` | yes |
 * | `GET /files/:ticket` — outside the bearer scope; single use, 60 s, bound to the file | yes |
 * | `POST /api/deliverables`, `PATCH /api/deliverables/:id`, `POST …/:id/remove`, `…/restore`, `POST /api/projects/:id/deliverables/rescan` | only with `autoApproveRemote` (403 `remote_control`) |
 * | `POST /api/deliverables/:id/open {action, fingerprint?}` | never (403 `remote_control`) |
 *
 * Errors: 400 `invalid_query` / `invalid_body` / `invalid`; 403 `remote_control`; 404
 * `not_found` (unknown or removed id); 409 `changed` (the file was swapped since the check),
 * `outside` / `refused_area` / `secret` / `hard_link` (it no longer passes the path rules),
 * `folder` (folders are never served), `stale` (with the current row), `confirm` (an application's
 * open, with its fingerprint), `use_app` / `not_app` / `not_folder` / `no_ide` /
 * `ide_not_installed`; 410 `missing` (nothing there), `expired` / `changed` for a ticket; 413
 * `too_large` past the preview limits; 501 `not_mac`; 502 `open_failed`; 507 / 503 storage.
 */

const USER: Actor = { type: 'user' };

export interface DeliverableRoutesOptions {
  log: EventLog;
  commands: Commands;
  /** Opening on the Mac (P9-03); without it every open is 501 `not_mac`. */
  opener?: Opener;
  /** One-time download tickets; one per app by default. */
  tickets?: DownloadTickets;
  /** The home folder refused as a root (default `os.homedir()`). */
  home?: string;
  /**
   * Detection's rescan of a project's run scripts (P9-05's scan service): enables
   * `POST /api/projects/:id/deliverables/rescan`.
   */
  rescan?: (projectId: Id) => Promise<unknown>;
}

function send(reply: FastifyReply, status: number, error: string, message?: string) {
  return reply
    .code(status)
    .send({ error, ...(message !== undefined ? { message: redactSecrets(message) } : {}) });
}

export function registerDeliverableRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: DeliverableRoutesOptions,
): void {
  const { log, commands, opener } = opts;
  const tables = log.tables;
  const tickets = opts.tickets ?? new DownloadTickets();
  const places = { dataDir: config.dataDir, ...(opts.home ? { home: opts.home } : {}) };

  const rootsFor = (target: {
    projectId?: Id | undefined;
    taskId?: Id | undefined;
  }): DeliverableRoots | undefined => rootsOf(tables, target, places);

  /** A listed row (not removed), or the 404 already sent. */
  const activeRow = (id: string, reply: FastifyReply): Deliverable | undefined => {
    const row = tables.deliverables.get(id);
    if (!row || row.removedAt !== undefined) {
      void send(reply, 404, 'not_found', `no deliverable ${id}`);
      return undefined;
    }
    return row;
  };

  /** A path deliverable's file, re-checked and opened for serving, or the refusal already sent. */
  const openRow = (row: Deliverable, reply: FastifyReply): OpenedFile | undefined => {
    if (!row.location) {
      void send(reply, 400, 'invalid', `a ${row.kind} deliverable has no file`);
      return undefined;
    }
    if (row.location.missing) {
      void send(reply, 410, 'missing', row.location.missing.reason);
      return undefined;
    }
    const roots = rootsFor(row);
    if (!roots) {
      void send(reply, 410, 'missing', `the folder of deliverable ${row.id} is not known`);
      return undefined;
    }
    const file = openForServing(row.location.path, roots, checkOptionsOf(row));
    if ('opened' in file) return file;
    if (file.code === 'folder') void send(reply, 409, 'folder', file.reason);
    else void send(reply, refusalStatus(file.code), file.code, file.reason);
    return undefined;
  };

  /** A refused command as these routes answer it (TECHNOLOGY §9.9; P2-14's mapping). */
  const refuse = (
    req: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    current?: Deliverable,
  ) => {
    if (sendStorageRefusal(reply, error)) return reply;
    if (error instanceof OpenerError) return send(reply, error.status, error.code, error.message);
    if (!(error instanceof DomainError)) {
      req.log.error(error);
      return reply.code(500).send({ error: 'internal' });
    }
    const status =
      error.code === 'not_found'
        ? 404
        : error.code === 'invalid'
          ? 400
          : error.code === 'remote_control'
            ? 403
            : 409;
    if (error.code === 'stale' && current) {
      const now = tables.deliverables.get(current.id) ?? current;
      return reply
        .code(409)
        .send({ error: 'stale', message: redactSecrets(error.message), deliverable: now });
    }
    return send(reply, status, error.code, error.message);
  };

  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));

    const parse = <T>(
      schema: z.ZodType<T>,
      input: unknown,
      reply: FastifyReply,
      error: 'invalid_query' | 'invalid_body',
    ): T | undefined => {
      const parsed = schema.safeParse(input ?? {});
      if (parsed.success) return parsed.data;
      void reply.code(400).send({ error, issues: parsed.error.issues });
      return undefined;
    };
    const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
    /** The decision-51 rule for edits by hand (lifted by `autoApproveRemote`). */
    const localWrite = (req: FastifyRequest, reply: FastifyReply, what: string): boolean => {
      const refused = requireLocal(req, { autoApproveRemote: config.autoApproveRemote, what });
      if (!refused) return true;
      void reply.code(403).send(refused);
      return false;
    };

    // -- reading: open to remote clients (decision 131) -----------------------------------------

    app.get('/api/deliverables', async (req, reply) => {
      const q = parse(DeliverablesQuery, req.query, reply, 'invalid_query');
      if (!q) return;
      if (q.projectId && !tables.projects.get(q.projectId)) {
        return send(reply, 404, 'not_found', `no project ${q.projectId}`);
      }
      if (q.taskId && !tables.tasks.get(q.taskId)) {
        return send(reply, 404, 'not_found', `no task ${q.taskId}`);
      }
      const rows =
        q.taskId !== undefined
          ? tables.deliverables.of({ taskId: q.taskId })
          : q.projectId !== undefined
            ? tables.deliverables.of({ projectId: q.projectId })
            : tables.deliverables.all();
      const roots = new Map<string, DeliverableRoots | undefined>();
      const items: DeliverableListItem[] = [];
      for (const row of rows) {
        if (q.projectId && q.taskId && row.projectId !== q.projectId) continue;
        if (!q.removed && row.removedAt !== undefined) continue;
        if (!row.location || !PATH_KINDS.has(row.kind)) {
          items.push(row);
          continue;
        }
        const key = `${row.projectId ?? ''}|${row.taskId ?? ''}`;
        if (!roots.has(key)) roots.set(key, rootsFor(row));
        const r = roots.get(key);
        const facts = row.location.missing
          ? { exists: false, problem: 'missing' }
          : r
            ? factsView(fileFacts(row.location.path, r, checkOptionsOf(row)))
            : { exists: false, problem: 'missing' };
        items.push({ ...row, facts });
      }
      const owner = q.taskId ? tables.tasks.get(q.taskId) : undefined;
      const project = q.projectId
        ? tables.projects.get(q.projectId)
        : owner?.projectId
          ? tables.projects.get(owner.projectId)
          : undefined;
      const folder = (project ?? owner)?.meta?.['deliverablesFolder'];
      return {
        deliverables: items,
        ...(typeof folder === 'string' && folder ? { folder } : {}),
      } satisfies DeliverablesResponse;
    });

    app.get('/api/deliverables/:id/content', { exposeHeadRoute: false }, async (req, reply) => {
      const row = activeRow(idOf(req), reply);
      if (!row) return reply;
      const file = openRow(row, reply);
      if (!file) return reply;
      let plan;
      try {
        plan = contentPlan(file);
      } catch (error) {
        closeQuietly(file.opened.fd);
        req.log.warn(error);
        return send(reply, 410, 'missing', `${file.name} cannot be read`);
      }
      if (plan.kind !== 'stream' || plan.size === 0) closeQuietly(file.opened.fd);
      if (plan.kind === 'too_large') {
        return send(
          reply,
          413,
          'too_large',
          `${file.name} is larger than the preview limit (${plan.limit} bytes): download it`,
        );
      }
      if (plan.kind === 'text') {
        void reply.headers(
          fileHeaders({
            contentType: TEXT_CONTENT_TYPE,
            how: 'inline',
            name: file.name,
            length: plan.bytes.length,
          }),
        );
        if (plan.truncated) void reply.header('x-truncated', '1');
        return reply.send(Buffer.from(plan.bytes));
      }
      void reply.headers(
        fileHeaders({
          contentType: plan.contentType,
          how: plan.how,
          name: file.name,
          length: plan.size,
        }),
      );
      return reply.send(plan.size === 0 ? Buffer.alloc(0) : streamFile(file.opened.fd, plan.size));
    });

    app.post('/api/deliverables/:id/download', async (req, reply) => {
      const row = activeRow(idOf(req), reply);
      if (!row) return reply;
      const file = openRow(row, reply);
      if (!file) return reply;
      closeQuietly(file.opened.fd);
      const ticket = tickets.mint(row.id, identityOf(file.opened.stat));
      return { url: `/files/${ticket}` } satisfies DownloadTicketResponse;
    });

    // -- by hand: local unless autoApproveRemote (decision 131) ---------------------------------

    app.post('/api/deliverables', async (req, reply) => {
      if (!localWrite(req, reply, 'Adding a deliverable')) return reply;
      const body = parse(AddDeliverableBody, req.body, reply, 'invalid_body');
      if (!body) return;
      const task = body.taskId ? tables.tasks.get(body.taskId) : undefined;
      if (body.taskId && !task) return send(reply, 404, 'not_found', `no task ${body.taskId}`);
      const projectId = task ? task.projectId : body.projectId;
      if (projectId && !tables.projects.get(projectId)) {
        return send(reply, 404, 'not_found', `no project ${projectId}`);
      }
      const input = handInput(body, rootsFor({ projectId, taskId: body.taskId }));
      if ('error' in input) return send(reply, input.status, input.error, input.message);
      try {
        const { value } = await commands.addDeliverable(input, USER, { origin: originOf(req) });
        return { deliverable: value };
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.patch('/api/deliverables/:id', async (req, reply) => {
      if (!localWrite(req, reply, 'Editing a deliverable')) return reply;
      const body = parse(EditDeliverableBody, req.body, reply, 'invalid_body');
      if (!body) return;
      const current = tables.deliverables.get(idOf(req));
      if (!current) return send(reply, 404, 'not_found', `no deliverable ${idOf(req)}`);
      const edit: DeliverableEdit = {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
      };
      if (body.command) {
        if (!current.command) {
          return send(reply, 400, 'invalid', `a ${current.kind} deliverable has no command line`);
        }
        edit.command = { ...current.command, line: body.command.line };
      }
      try {
        const { value } = await commands.updateDeliverable(current.id, edit, USER, {
          origin: originOf(req),
          expectedVersion: body.version,
        });
        return { deliverable: value };
      } catch (error) {
        return refuse(req, reply, error, current);
      }
    });

    app.post('/api/deliverables/:id/remove', async (req, reply) => {
      if (!localWrite(req, reply, 'Removing a deliverable')) return reply;
      const body = parse(RemoveDeliverableBody, req.body, reply, 'invalid_body');
      if (!body) return;
      try {
        const { value } = await commands.removeDeliverable(idOf(req), USER, body.reason, {
          origin: originOf(req),
        });
        return { deliverable: value };
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    app.post('/api/deliverables/:id/restore', async (req, reply) => {
      if (!localWrite(req, reply, 'Restoring a deliverable')) return reply;
      try {
        const { value } = await commands.restoreDeliverable(idOf(req), USER, {
          origin: originOf(req),
        });
        return { deliverable: value };
      } catch (error) {
        return refuse(req, reply, error);
      }
    });

    const { rescan } = opts;
    if (rescan) {
      app.post('/api/projects/:id/deliverables/rescan', async (req, reply) => {
        if (!localWrite(req, reply, 'Rescanning a project')) return reply;
        const id = idOf(req);
        if (!tables.projects.get(id)) return send(reply, 404, 'not_found', `no project ${id}`);
        try {
          await rescan(id);
          return { ok: true };
        } catch (error) {
          return refuse(req, reply, error);
        }
      });
    }

    // -- opening on the Mac: never from a remote client (decision 131) --------------------------

    app.post('/api/deliverables/:id/open', async (req, reply) => {
      const refused = requireLocal(req, { always: true, what: 'Opening a deliverable' });
      if (refused) return reply.code(403).send(refused);
      const body = parse(OpenDeliverableBody, req.body, reply, 'invalid_body');
      if (!body) return;
      const row = activeRow(idOf(req), reply);
      if (!row) return reply;
      if (!opener || !opener.supported) {
        return send(
          reply,
          501,
          'not_mac',
          'Opening works only when Mission Control runs on a Mac.',
        );
      }
      if (!row.location || !PATH_KINDS.has(row.kind)) {
        return send(reply, 400, 'invalid', `a ${row.kind} deliverable has nothing to open`);
      }
      if (row.location.missing) return send(reply, 410, 'missing', row.location.missing.reason);
      const roots = rootsFor(row);
      if (!roots) {
        return send(reply, 410, 'missing', `the folder of deliverable ${row.id} is not known`);
      }
      // The same re-check as a read: the real path, through a checked descriptor.
      const opened = openChecked(row.location.path, roots, checkOptionsOf(row));
      if (!opened.ok) return send(reply, refusalStatus(opened.code), opened.code, opened.reason);
      closeQuietly(opened.fd);
      const path = opened.path;
      const facts = fileFacts(path, roots, checkOptionsOf(row));
      try {
        switch (body.action) {
          case 'open':
            if (facts.runsCode) {
              return send(
                reply,
                409,
                facts.runsAs === 'command' ? 'use_command' : 'use_app',
                facts.runsAs === 'command'
                  ? `${basename(path)} is a program: add it as a command to run it`
                  : `${basename(path)} would run code when opened: open it as an application`,
              );
            }
            await opener.open(path);
            break;
          case 'reveal':
            await opener.reveal(path);
            break;
          case 'ide':
            if (opened.type !== 'folder' || isAppName(path)) {
              return send(reply, 409, 'not_folder', `${basename(path)} is not a folder`);
            }
            await opener.openInIde(path);
            break;
          case 'app': {
            if (facts.runsAs !== 'app') {
              return send(
                reply,
                409,
                'not_app',
                facts.runsAs === 'command'
                  ? `${basename(path)} is a program, not an application: add it as a command`
                  : `${basename(path)} is not an application: use Open`,
              );
            }
            const fingerprint = await opener.fingerprint(path);
            const stored = (row.meta?.['confirmedOpen'] as { fingerprint?: string } | undefined)
              ?.fingerprint;
            if (body.fingerprint !== fingerprint && !confirmationCovers(stored, fingerprint)) {
              return reply.code(409).send({
                error: 'confirm',
                code: 'confirm',
                fingerprint,
                addedBy: row.addedBy,
                name: basename(path),
              } satisfies OpenConfirmation & { error: string });
            }
            if (body.fingerprint === fingerprint && stored !== fingerprint) {
              await commands.updateDeliverable(
                row.id,
                {
                  meta: {
                    confirmedOpen: { fingerprint, at: new Date().toISOString(), by: USER },
                  },
                },
                USER,
                { origin: originOf(req) },
              );
            }
            await opener.openApp(path);
            break;
          }
        }
      } catch (error) {
        return refuse(req, reply, error);
      }
      try {
        await commands.recordDeliverableOpened(row.id, body.action, USER);
      } catch (error) {
        // Opened already: the audit's failure is logged, not reported as a failed open.
        req.log.warn(error);
      }
      return { ok: true };
    });
  });

  // -- the download itself: the ticket is the credential (TECHNOLOGY §9.6) ----------------------

  void parent.register(async (app) => {
    app.get('/files/:ticket', { exposeHeadRoute: false }, async (req, reply) => {
      void reply.headers(FILE_HEADERS);
      const ticket = (req.params as { ticket: string }).ticket;
      if (!TICKET_PATTERN.test(ticket)) return send(reply, 404, 'not_found');
      const binding = tickets.take(ticket);
      if (!binding) {
        return send(reply, 410, 'expired', 'This download link was used or has expired.');
      }
      const row = tables.deliverables.get(binding.deliverableId);
      if (!row || row.removedAt !== undefined) {
        return send(reply, 410, 'expired', 'This deliverable was removed.');
      }
      const file = openRow(row, reply);
      if (!file) return reply;
      if (!ticketMatches(binding, file.opened)) {
        closeQuietly(file.opened.fd);
        return send(reply, 410, 'changed', `${file.name} changed since the link was made.`);
      }
      const size = file.opened.stat.size;
      void reply.headers(
        fileHeaders({
          contentType: file.facts.contentType ?? 'application/octet-stream',
          how: 'attachment',
          name: file.name,
          length: size,
        }),
      );
      if (size === 0) {
        closeQuietly(file.opened.fd);
        return reply.send(Buffer.alloc(0));
      }
      return reply.send(streamFile(file.opened.fd, size));
    });
  });
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // already closed
  }
}

/**
 * What a user's addition by hand becomes (TECHNOLOGY §9.3 "By hand"): a path checked against the
 * target's roots without the agents' rules (the panel warns about secret names), a command's
 * folder checked the same way (the project's folder by default), an address as given (the
 * command checks it). A path outside the roots is refused (`outside`) — copying it into the
 * project's `deliverables/` folder is P9-06's.
 */
function handInput(
  body: AddDeliverableBody,
  roots: DeliverableRoots | undefined,
): AddDeliverableInput | { error: string; status: number; message: string } {
  const base = {
    ...(body.projectId ? { projectId: body.projectId } : {}),
    ...(body.taskId ? { taskId: body.taskId } : {}),
    kind: body.kind,
    title: body.title,
    ...(body.description ? { description: body.description } : {}),
    source: 'user' as const,
  };
  if (PATH_KINDS.has(body.kind)) {
    if (!body.path || body.command || body.url) {
      return { error: 'invalid', status: 400, message: `a ${body.kind} deliverable is a path` };
    }
    if (!roots) {
      return { error: 'invalid', status: 400, message: 'this work has no folder to point into' };
    }
    const check = checkPath(body.path, roots);
    if (!check.ok) {
      return {
        error: check.code,
        status: check.code === 'invalid' ? 400 : 409,
        message: check.reason,
      };
    }
    const fits =
      body.kind === 'app'
        ? isAppName(check.path)
        : body.kind === 'folder'
          ? check.type === 'folder'
          : check.type === 'file';
    if (!fits) {
      return {
        error: 'invalid',
        status: 400,
        message:
          body.kind === 'app'
            ? `${body.path} is not an application`
            : `${body.path} is ${check.type === 'folder' ? 'a folder' : 'a file'}, not a ${body.kind}`,
      };
    }
    return {
      ...base,
      location: { storage: check.where === 'worktree' ? 'worktree' : 'in_place', path: check.path },
      ...(check.type === 'file'
        ? {
            meta: { size: check.stat.size, mtime: new Date(check.stat.mtimeMs).toISOString() },
          }
        : {}),
    };
  }
  if (body.kind === 'command') {
    if (!body.command || body.path || body.url) {
      return { error: 'invalid', status: 400, message: 'a command deliverable is a command line' };
    }
    if (!roots) {
      return { error: 'invalid', status: 400, message: 'this work has no folder to run in' };
    }
    const check = checkPath(body.command.cwd ?? roots.workspace, roots);
    if (!check.ok) {
      return {
        error: check.code,
        status: check.code === 'invalid' ? 400 : 409,
        message: check.reason,
      };
    }
    if (check.type !== 'folder') {
      return { error: 'invalid', status: 400, message: 'a command runs in a folder' };
    }
    return { ...base, command: { line: body.command.line, cwd: check.path } };
  }
  if (!body.url || body.path || body.command) {
    return { error: 'invalid', status: 400, message: 'a url deliverable is an address' };
  }
  return { ...base, url: body.url };
}
