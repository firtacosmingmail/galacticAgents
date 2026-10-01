import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  AnswerBody,
  ControlBody,
  PERMISSION_POLICY_PRESETS,
  SendBody,
  SpawnBody,
  type Actor,
  type ControlAction,
  type ControlResponse,
  type RuntimesInfo,
  type SendResponse,
  type SpawnResponse,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { Commands } from '../domain/commands.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { redactSecrets } from '../runtime/redact.js';
import { bearerGuard } from './security.js';

/**
 * The agent control surface the ops console uses (P1-11; TECHNOLOGY §2.2 "a small REST
 * surface"). Bearer-token guarded like everything else. Every call goes through the runtime, so
 * the log, the status store and the inbox see exactly what a brain tool would make them see;
 * the results arrive on the WebSocket stream, these routes only acknowledge.
 */

export interface AgentRoutesOptions {
  runtime: AgentRuntime;
  log: EventLog;
  /** Fake-adapter scenario names, for the spawn form in dev mode. */
  scenarios?: () => string[];
  /** The command surface (P2-01): enables `POST /api/control` (P2-14). */
  commands?: Commands;
}

const USER: Actor = { type: 'user' };

/**
 * A refusal's message comes from the runtime or the adapter and may carry CLI stderr: redact it
 * like any other text that leaves the server (TECHNOLOGY §8, P1-38).
 */
const refusal = (error: 'rejected' | 'refused', message: string) => ({
  error,
  message: redactSecrets(message),
});

export function registerAgentRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: AgentRoutesOptions,
): void {
  // An encapsulated scope: the guard runs for every route registered in it (P1-28).
  void parent.register(async (app) => {
    const { runtime, log } = opts;

    app.addHook('onRequest', bearerGuard(config));

    const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | undefined => {
      const parsed = schema.safeParse(body ?? {});
      if (parsed.success) return parsed.data;
      void reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      return undefined;
    };
    const agentId = (req: FastifyRequest) => (req.params as { id: string }).id;
    const attempt = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
      try {
        return (await fn()) ?? { ok: true };
      } catch (error) {
        return reply.code(409).send(refusal('rejected', (error as Error).message));
      }
    };

    /** What the spawn form can offer. */
    app.get('/api/runtimes', async (): Promise<RuntimesInfo> => ({
      runtimes: (['fake', 'claude-sdk'] as const)
        .filter((name) => runtime.adapter(name) !== undefined)
        .map((name) => ({
          name,
          resumable: runtime.adapter(name)?.resumeSession !== undefined,
          ...(name === 'fake' && opts.scenarios ? { scenarios: opts.scenarios() } : {}),
        })),
      policies: Object.keys(PERMISSION_POLICY_PRESETS) as RuntimesInfo['policies'],
      caps: runtime.caps.defaults,
      maxConcurrentAgents: runtime.caps.maxConcurrent,
    }));

    app.post('/api/agents', async (req, reply) => {
      const body = parse(SpawnBody, req.body, reply);
      if (!body) return;
      const result = await runtime.spawn({
        role: body.role,
        runtime: body.runtime,
        prompt: body.prompt,
        cwd: body.cwd,
        ...(body.workspace ? { workspace: body.workspace } : {}),
        permissionPolicy: PERMISSION_POLICY_PRESETS[body.policy],
        ...(body.caps ? { caps: compact(body.caps) } : {}),
        ...(body.bare ? { bare: true } : {}),
      });
      if (!result.ok) return reply.code(409).send(refusal('refused', result.reason));
      return reply.code(201).send({ agentId: result.agent.id } satisfies SpawnResponse);
    });

    app.post('/api/agents/:id/send', async (req, reply) => {
      const body = parse(SendBody, req.body, reply);
      if (!body) return;
      return attempt(reply, async () => {
        const message = runtime.send(agentId(req), body.text, {
          sender: USER,
          ...(body.interrupt ? { interrupt: true } : {}),
        });
        return { messageId: message.id } satisfies SendResponse;
      });
    });

    app.post('/api/agents/:id/pause', (req, reply) =>
      attempt(reply, () => runtime.pause(agentId(req), USER)),
    );
    app.post('/api/agents/:id/resume', (req, reply) =>
      attempt(reply, () => runtime.resumeAgent(agentId(req), USER)),
    );
    app.post('/api/agents/:id/interrupt', (req, reply) =>
      attempt(reply, () => runtime.interrupt(agentId(req))),
    );
    app.post('/api/agents/:id/stop', (req, reply) =>
      attempt(reply, () => runtime.stop(agentId(req), USER)),
    );

    /**
     * Reopens an interrupted agent from its session ref (the manual half of P1-14): the same
     * path as startup recovery (P1-29) — 409 unless the agent is interrupted and not running.
     */
    app.post('/api/agents/:id/recover', async (req, reply) => {
      const id = agentId(req);
      if (!log.tables.agents.get(id)) return reply.code(404).send({ error: 'not_found' });
      const result = await runtime.recoverAgent(id);
      if (!result.ok) return reply.code(409).send(refusal('refused', result.reason));
      return { ok: true };
    });

    /**
     * A panel action on a task, project or agent (decision 11b, P2-14): the same
     * `DomainCommands.control` a Harmonizer tool calls. 404 for an unknown target, 409 when the
     * state refuses it; the events arrive on the stream.
     */
    const { commands } = opts;
    if (commands) {
      app.post('/api/control', async (req, reply) => {
        const body = parse(ControlBody, req.body, reply);
        if (!body) return;
        try {
          await commands.control(body.target, body.action as ControlAction, USER);
          return { ok: true, seq: log.currentSeq() } satisfies ControlResponse;
        } catch (error) {
          if (error instanceof DomainError && error.code === 'not_found') {
            return reply.code(404).send({ error: 'not_found', message: error.message });
          }
          return reply.code(409).send(refusal('rejected', (error as Error).message));
        }
      });
    }

    app.post('/api/questions/:id/answer', async (req, reply) => {
      const body = parse(AnswerBody, req.body, reply);
      if (!body) return;
      return attempt(reply, () =>
        runtime.answer((req.params as { id: string }).id, body.answer, USER),
      );
    });
  });
}

/** Drops `undefined` values so partial caps satisfy `exactOptionalPropertyTypes`. */
function compact<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
