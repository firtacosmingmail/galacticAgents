import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ExportQuery,
  type BackupNowResponse,
  type BackupsResponse,
  type MapExport,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { BackupService } from '../db/backup.js';
import { exportMap } from '../db/map-export.js';
import type { EventLog } from '../domain/event-log.js';
import { bearerGuard, originOf } from './security.js';

/**
 * Backups and the map export (P8-03; docs/BACKUP_RESTORE.md), bearer-guarded in their own scope:
 *
 * - `GET /api/backups` — the backup files, newest first, the rotation and the last attempt;
 * - `POST /api/backups` — "Back up now": takes a backup and answers its outcome (`ok`, `skipped`
 *   when the disk lacks room, `failed`); a request while one runs shares it;
 * - `GET /api/export?transcripts=1` — the map export as a download (`MapExport`), transcripts only
 *   when asked.
 *
 * All three belong to the Mac (SPEC decision 90, like the settings of decision 51): a remote client
 * is refused with 403 `remote_control` unless `autoApproveRemote`. The import is not offered here:
 * it replaces the database under the server, so it runs from the command line with the server
 * stopped (`galactic import`).
 */

export interface BackupRoutesOptions {
  log: EventLog;
  backups?: BackupService;
}

export function registerBackupRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: BackupRoutesOptions,
): void {
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));
    const refuseRemote = (req: FastifyRequest, reply: FastifyReply): boolean => {
      if (config.autoApproveRemote || originOf(req) === 'local') return false;
      void reply.code(403).send({
        error: 'remote_control',
        message: "Backups and exports work only from this machine's own browser.",
      });
      return true;
    };

    const { backups } = opts;
    if (backups) {
      app.get('/api/backups', async (req, reply) => {
        if (refuseRemote(req, reply)) return reply;
        return backups.response() satisfies BackupsResponse;
      });
      app.post('/api/backups', async (req, reply) => {
        if (refuseRemote(req, reply)) return reply;
        return (await backups.backupNow('manual')) satisfies BackupNowResponse;
      });
    }

    app.get('/api/export', async (req, reply) => {
      if (refuseRemote(req, reply)) return reply;
      const q = ExportQuery.safeParse(req.query ?? {});
      if (!q.success) {
        return reply.code(400).send({ error: 'invalid_query', issues: q.error.issues });
      }
      const exported: MapExport = exportMap(opts.log.db, { transcripts: q.data.transcripts });
      const day = exported.exportedAt.slice(0, 10);
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="galactic-map-${day}.json"`)
        .header('cache-control', 'no-store')
        .send(JSON.stringify(exported));
    });
  });
}
