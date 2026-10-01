import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentCaps,
  AgentRole,
  AgentRuntime as RuntimeName,
  PERMISSION_POLICY_PRESETS,
  type Actor,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { EventLog } from '../domain/event-log.js';
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
}

const USER: Actor = { type: 'user' };

const SpawnBody = z.object({
  role: AgentRole.default('steward'),
  runtime: RuntimeName,
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  workspace: z.string().min(1).optional(),
  policy: z.enum(['default', 'trusting', 'cautious']).default('default'),
  caps: AgentCaps.partial().optional(),
  bare: z.boolean().optional(),
});

const SendBody = z.object({ text: z.string().min(1), interrupt: z.boolean().optional() });
const AnswerBody = z.object({ answer: z.string().min(1) });

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
        return reply.code(409).send({ error: 'rejected', message: (error as Error).message });
      }
    };

    /** What the spawn form can offer. */
    app.get('/api/runtimes', async () => ({
      runtimes: (['fake', 'claude-sdk'] as const)
        .filter((name) => runtime.adapter(name) !== undefined)
        .map((name) => ({
          name,
          resumable: runtime.adapter(name)?.resumeSession !== undefined,
          ...(name === 'fake' && opts.scenarios ? { scenarios: opts.scenarios() } : {}),
        })),
      policies: Object.keys(PERMISSION_POLICY_PRESETS),
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
      if (!result.ok) return reply.code(409).send({ error: 'refused', message: result.reason });
      return reply.code(201).send({ agentId: result.agent.id });
    });

    app.post('/api/agents/:id/send', async (req, reply) => {
      const body = parse(SendBody, req.body, reply);
      if (!body) return;
      return attempt(reply, async () => {
        const message = runtime.send(agentId(req), body.text, {
          sender: USER,
          ...(body.interrupt ? { interrupt: true } : {}),
        });
        return { messageId: message.id };
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

    /** Reopens an interrupted agent from its session ref (the manual half of P1-14). */
    app.post('/api/agents/:id/recover', async (req, reply) => {
      const agent = log.tables.agents.get(agentId(req));
      if (!agent) return reply.code(404).send({ error: 'not_found' });
      const meta = (agent.meta ?? {}) as { cwd?: string; prompt?: string; workspace?: string };
      if (!meta.cwd) {
        return reply
          .code(409)
          .send({ error: 'rejected', message: 'agent has no saved working directory' });
      }
      const result = await runtime.resume(agent, {
        cwd: meta.cwd,
        prompt: meta.prompt ?? '',
        ...(meta.workspace ? { workspace: meta.workspace } : {}),
      });
      if (!result.ok) return reply.code(409).send({ error: 'refused', message: result.reason });
      return { ok: true };
    });

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
