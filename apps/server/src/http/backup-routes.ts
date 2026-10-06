import BetterSqlite3 from 'better-sqlite3';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ExportQuery,
  type BackupNowResponse,
  type BackupsResponse,
  type MapExport,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { BackupService } from '../db/backup.js';
import { exportMap, exportMapText, ExportError } from '../db/map-export.js';
import type { EventLog } from '../domain/event-log.js';
import { bearerGuard, originOf } from './security.js';

/**
 * Backups and the map export (P8-03; docs/BACKUP_RESTORE.md), bearer-guarded in their own scope:
 *
 * - `GET /api/backups` — the backup files, newest first, the rotation and the last attempt;
 * - `POST /api/backups` — "Back up now": takes a backup and answers its outcome (`ok`, `skipped`
 *   when the disk lacks room, `failed`); a request while one runs shares it;
 * - `GET /api/export?transcripts=1` — the map export as a download (`MapExport`), transcripts only
 *   when asked. Streamed (`exportMapText` over a read-only connection of its own): the log is read
 *   and written a page at a time, yielding to the event loop, so a large export neither blocks the
 *   server nor is held in memory whole.
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
      const day = new Date().toISOString().slice(0, 10);
      const headers = (r: FastifyReply) =>
        r
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="galactic-map-${day}.json"`)
          .header('cache-control', 'no-store');
      const db = opts.log.db;
      if (db.memory) {
        // An in-memory database (tests) has no file a second connection could read.
        const exported: MapExport = exportMap(db, { transcripts: q.data.transcripts });
        return headers(reply).send(JSON.stringify(exported));
      }
      const reader = new BetterSqlite3(db.name, { readonly: true, fileMustExist: true });
      const pieces = exportMapText(reader, { transcripts: q.data.transcripts });
      let first: IteratorResult<string>;
      try {
        first = await pieces.next(); // the schema check: refused before any byte is sent
      } catch (error) {
        reader.close();
        if (error instanceof ExportError) {
          return reply.code(409).send({ error: 'export_refused', message: error.message });
        }
        throw error;
      }
      async function* all(): AsyncGenerator<string> {
        try {
          if (!first.done) yield first.value;
          yield* pieces;
        } finally {
          reader.close();
        }
      }
      const stream = Readable.from(all());
      // A client that goes away mid-download: the generator's `finally` closes the connection.
      stream.once('close', () => void pieces.return(undefined).catch(() => {}));
      return headers(reply).send(stream);
    });
  });
}
