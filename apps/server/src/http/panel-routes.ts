import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import {
  AgentRuntime as RuntimeName,
  ConversationQuery,
  HistoryQuestionsQuery,
  HistoryWorkQuery,
  NotificationsQuery,
  SettingsPatch,
  TranscriptQuery,
  type ConversationResponse,
  type HistoryQuestionsResponse,
  type HistoryWorkResponse,
  type NotificationsResponse,
  type PreflightResponse,
  type RuntimePreflight,
  type SettingsResponse,
  type TranscriptResponse,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import { SettingsError, writableFor, type SettingsService } from '../config/settings.js';
import type { EventLog } from '../domain/event-log.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { History } from '../runtime/history.js';
import { HistoryView } from '../runtime/history-view.js';
import { notificationFeed } from '../runtime/notifications.js';
import { redactSecrets } from '../runtime/redact.js';
import type { TranscriptPipeline } from '../runtime/transcripts.js';
import { bearerGuard, originOf } from './security.js';

/**
 * The side panel's endpoints (P25-01; `docs/tasks/notes/P25-01-endpoints.md`), bearer-guarded in
 * their own encapsulated scope like the other `/api` routes:
 *
 * - `GET /api/agents/:id/conversation` — the chat history with an agent (messages to it and its
 *   replies), paged by an opaque cursor;
 * - `GET /api/agents/:id/transcript` — its transcript chunks, paged by `seq`;
 * - `GET /api/settings`, `PATCH /api/settings` — the settings page (SPEC §4.6);
 * - `GET /api/preflight` — every registered runtime's check;
 * - `GET /api/notifications` — the SPEC §4.5 feed;
 * - `GET /api/history/work`, `GET /api/history/questions` — the history view (P25-10): finished
 *   and archived work, past questions, searched and paged back by an opaque cursor.
 *
 * Errors: 400 `invalid_query` / `invalid_body` (zod issues) or `invalid` (a value the settings
 * refuse, with a message), 403 `remote_settings` (a remote client may change only the quality
 * tier and tighten the default policy, decision 51), 404 `not_found`, 409 `env_override`.
 */

export interface PanelRoutesOptions {
  log: EventLog;
  runtime?: AgentRuntime;
  transcripts?: TranscriptPipeline;
  settings?: SettingsService;
  /** How long a preflight result is reused (default 30 s); `?refresh=1` runs it again. */
  preflightTtlMs?: number;
  /**
   * The youngest result `?refresh=1` may replace (default 5 s): a refresh within that time gets
   * the cached result, so a client cannot keep the server spawning `claude`.
   */
  preflightMinRefreshMs?: number;
}

export function registerPanelRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: PanelRoutesOptions,
): void {
  void parent.register(async (app) => {
    const { log } = opts;
    const history = new History(log.db);
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
    const knownAgent = (id: string) => log.tables.agents.get(id) !== undefined;

    app.get('/api/agents/:id/conversation', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const q = parse(ConversationQuery, req.query, reply, 'invalid_query');
      if (!q) return;
      if (!knownAgent(id)) return reply.code(404).send({ error: 'not_found' });
      try {
        return history.conversation(id, q) satisfies ConversationResponse;
      } catch (error) {
        if (error instanceof RangeError) {
          return reply.code(400).send({ error: 'invalid_query', message: error.message });
        }
        throw error;
      }
    });

    app.get('/api/agents/:id/transcript', async (req, reply) => {
      const id = (req.params as { id: string }).id;
      const q = parse(TranscriptQuery, req.query, reply, 'invalid_query');
      if (!q) return;
      if (!knownAgent(id)) return reply.code(404).send({ error: 'not_found' });
      return history.transcript(id, q) satisfies TranscriptResponse;
    });

    // The history view (P25-10): finished and archived work, past questions.
    const past = new HistoryView(log.db, log.tables);
    const page = <T>(read: () => T, reply: FastifyReply): T | undefined => {
      try {
        return read();
      } catch (error) {
        if (error instanceof RangeError) {
          void reply.code(400).send({ error: 'invalid_query', message: error.message });
          return undefined;
        }
        throw error;
      }
    };
    app.get('/api/history/work', async (req, reply) => {
      const q = parse(HistoryWorkQuery, req.query, reply, 'invalid_query');
      if (!q) return;
      return page(() => past.work(q) satisfies HistoryWorkResponse, reply);
    });
    app.get('/api/history/questions', async (req, reply) => {
      const q = parse(HistoryQuestionsQuery, req.query, reply, 'invalid_query');
      if (!q) return;
      return page(() => past.questions(q) satisfies HistoryQuestionsResponse, reply);
    });

    app.get('/api/notifications', async (req, reply) => {
      const q = parse(NotificationsQuery, req.query, reply, 'invalid_query');
      if (!q) return;
      return notificationFeed(log, q) satisfies NotificationsResponse;
    });

    const { settings } = opts;
    if (settings) {
      // `writable` tells the client what it may change, decided as the patch decides it.
      const writeOf = (req: Parameters<typeof originOf>[0]) => ({
        origin: originOf(req),
        autoApproveRemote: config.autoApproveRemote,
      });
      app.get('/api/settings', async (req): Promise<SettingsResponse> =>
        settings.response({ writable: writableFor(writeOf(req)) }),
      );
      app.patch('/api/settings', async (req, reply) => {
        const patch = parse(SettingsPatch, req.body, reply, 'invalid_body');
        if (!patch) return;
        try {
          const write = writeOf(req);
          return {
            ...settings.update(patch, write),
            writable: writableFor(write),
          } satisfies SettingsResponse;
        } catch (error) {
          if (error instanceof SettingsError) {
            return reply
              .code(
                error.code === 'env_override' ? 409 : error.code === 'remote_settings' ? 403 : 400,
              )
              .send({ error: error.code, message: error.message });
          }
          req.log.error(error);
          return reply.code(500).send({ error: 'internal' });
        }
      });
    }

    const { runtime } = opts;
    if (runtime) {
      const ttl = opts.preflightTtlMs ?? 30_000;
      const minRefresh = opts.preflightMinRefreshMs ?? 5_000;
      let cached: { at: number; value: PreflightResponse } | undefined;
      let running: Promise<PreflightResponse> | undefined;
      const check = async (): Promise<PreflightResponse> => {
        const runtimes: RuntimePreflight[] = [];
        for (const name of RuntimeName.options) {
          const adapter = runtime.adapter(name);
          if (!adapter) continue;
          if (!adapter.preflight) {
            runtimes.push({ runtime: name, ok: true, installed: true, problems: [] });
            continue;
          }
          try {
            runtimes.push(await adapter.preflight());
          } catch (error) {
            runtimes.push({
              runtime: name,
              ok: false,
              installed: false,
              problems: [
                {
                  code: 'check_failed',
                  severity: 'error',
                  message: redactSecrets(`the ${name} check failed: ${(error as Error).message}`),
                },
              ],
            });
          }
        }
        return {
          ok: runtimes.every((r) => r.ok),
          runtimes,
          checkedAt: new Date().toISOString(),
        };
      };
      app.get('/api/preflight', async (req): Promise<PreflightResponse> => {
        const refresh = (req.query as { refresh?: string }).refresh;
        const age = cached ? Date.now() - cached.at : Infinity;
        const fresh = (refresh === '1' || refresh === 'true') && age >= minRefresh;
        if (!fresh && age < ttl) return cached!.value;
        // Concurrent callers share one run (it spawns `claude` twice).
        running ??= check().finally(() => {
          running = undefined;
        });
        const value = await running;
        cached = { at: Date.now(), value };
        return value;
      });
    }
  });
}
