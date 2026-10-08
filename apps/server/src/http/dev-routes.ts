import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  Event,
  HarnessActivityBody,
  HarnessAgentBody,
  HarnessAnswerBody,
  HarnessDeclareBody,
  HarnessMoveBody,
  HarnessQuestionBody,
  HarnessScenarioBody,
  HarnessStateBody,
} from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import type { Commands } from '../domain/commands.js';
import { seedDemoProject } from '../domain/demo.js';
import { DomainError } from '../domain/errors.js';
import type { ServerConfig } from '../config/config.js';
import type { StatusStore } from '../runtime/status-store.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import { clearDemoProjects } from '../runtime/demo-clear.js';
import {
  NotHarnessError,
  SceneHarness,
  type SceneHarnessOptions,
} from '../runtime/scene-harness.js';
import { bearerGuard, isRemoteRequest } from './security.js';

export interface DevRoutesOptions {
  log: EventLog;
  /** With `commands` and `statuses`: the scene harness (`/dev/harness/*`, P4-06). */
  commands?: Commands;
  statuses?: StatusStore;
  /** The runtime: the harness never fakes an ending for an agent with a live session. */
  runtime?: Pick<AgentRuntime, 'liveAgents'>;
  /** P9-12: prepared harness folders and agents' declarations (`SceneHarnessOptions`). */
  harness?: Pick<SceneHarnessOptions, 'workspaces' | 'deliverables'>;
}

/**
 * Bearer-token guarded routes used by the web page, `galactic` scripts and tests to poke the
 * event log before any agent exists (Phase 0 exit criterion: "a fake event emitted on the
 * server appears in the browser"). Registered only with `GALACTIC_DEV=1` (P0-16), and refused to
 * remote clients (P4-06: like a settings write, a development tool is this machine's only).
 *
 * Only `agent.*` events may be appended directly: they touch no domain table, so a client that
 * replays them and one that takes a snapshot agree. Domain state is seeded through a proper
 * command (`/dev/seed`) that writes the rows and the events together; `/dev/demo/clear` (P7-07)
 * archives every seeded demo project and retires its planet.
 *
 * The scene harness (P4-06, `runtime/scene-harness.ts`) drives the scene through the same
 * commands the runtime and the panel use: fake agents without a process, their states and
 * activities as the runtime's events, moves, closes, questions and answers through `Commands`.
 * It only ever acts on what it made: anything else is 409 `not_harness`.
 */
export function registerDevRoutes(
  parent: FastifyInstance,
  config: ServerConfig,
  opts: DevRoutesOptions,
): void {
  const { log } = opts;
  void parent.register(async (app) => {
    app.addHook('onRequest', bearerGuard(config));
    app.addHook('onRequest', async (req, reply) => {
      if (isRemoteRequest(req)) {
        return reply.code(403).send({
          error: 'remote_dev',
          message: 'development routes answer only on this machine',
        });
      }
    });

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

    /**
     * Creates a demo planet with a project on it — rows and events in one command. Both carry
     * `meta.demo` (P7-07): the planet is never reused for real work and retires with its project.
     */
    app.post('/dev/seed', async () => {
      const out = log.runCommand((ctx) => seedDemoProject(ctx));
      return { seq: out.events.at(-1)!.seq, projectId: out.value.id, name: out.value.name };
    });

    app.get('/dev/events', async (req) => {
      const since = Number((req.query as { since?: string }).since ?? 0);
      return { seq: log.currentSeq(), events: log.eventsSince(Number.isFinite(since) ? since : 0) };
    });

    if (opts.commands) {
      const commands = opts.commands;
      /** "Clear demo projects" (P7-07): archives every seeded demo project, retires its planet. */
      app.post('/dev/demo/clear', async (req, reply) => {
        try {
          return await clearDemoProjects(log, commands);
        } catch (error) {
          req.log.error(error);
          return reply.code(500).send({ error: 'internal' });
        }
      });
    }

    if (opts.commands && opts.statuses) {
      registerHarness(
        app,
        new SceneHarness({
          log,
          commands: opts.commands,
          statuses: opts.statuses,
          ...(opts.runtime ? { liveSessions: () => opts.runtime!.liveAgents() } : {}),
          ...(opts.harness?.workspaces ? { workspaces: opts.harness.workspaces } : {}),
          ...(opts.harness?.deliverables ? { deliverables: opts.harness.deliverables } : {}),
        }),
      );
    }
  });
}

type Params = { id: string };

/** The scene harness's routes (P4-06); bodies are the protocol's (`packages/protocol/src/dev.ts`). */
function registerHarness(app: FastifyInstance, harness: SceneHarness): void {
  /** Runs a harness action; a refused command is 404 / 400 / 409 like the panel's routes. */
  const act = async <T>(reply: FastifyReply, req: FastifyRequest, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof DomainError)) {
        req.log.error(error);
        return reply.code(500).send({ error: 'internal' });
      }
      // Something the harness did not make (a real agent, task, project or question): refused.
      if (error instanceof NotHarnessError) {
        return reply.code(409).send({ error: 'not_harness', message: error.message });
      }
      const status =
        error.code === 'not_found'
          ? 404
          : error.code === 'invalid'
            ? 400
            : error.code === 'remote_control'
              ? 403
              : 409;
      return reply.code(status).send({ error: error.code, message: error.message });
    }
  };
  const parse = <S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply) => {
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success) {
      void reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      return undefined;
    }
    return parsed.data as z.infer<S>;
  };

  app.get('/dev/harness', async () => harness.list());

  app.post('/dev/harness/scenario', async (req, reply) => {
    const body = parse(HarnessScenarioBody, req.body, reply);
    if (body) return act(reply, req, () => harness.scenario(body));
  });

  app.post('/dev/harness/clear', async (req, reply) => act(reply, req, () => harness.clear()));

  app.post('/dev/harness/agents', async (req, reply) => {
    const body = parse(HarnessAgentBody, req.body, reply);
    if (body) return act(reply, req, () => harness.createAgent(body));
  });

  app.post<{ Params: Params }>('/dev/harness/agents/:id/state', async (req, reply) => {
    const body = parse(HarnessStateBody, req.body, reply);
    if (body) return act(reply, req, () => harness.setState(req.params.id, body));
  });

  app.post<{ Params: Params }>('/dev/harness/agents/:id/activity', async (req, reply) => {
    const body = parse(HarnessActivityBody, req.body, reply);
    if (body) return act(reply, req, () => harness.setActivity(req.params.id, body));
  });

  app.post<{ Params: Params }>('/dev/harness/agents/:id/question', async (req, reply) => {
    const body = parse(HarnessQuestionBody, req.body, reply);
    if (body) return act(reply, req, () => harness.ask(req.params.id, body));
  });

  app.post<{ Params: Params }>('/dev/harness/agents/:id/declare', async (req, reply) => {
    const body = parse(HarnessDeclareBody, req.body, reply);
    if (body) return act(reply, req, () => harness.declare(req.params.id, body));
  });

  app.post<{ Params: Params }>('/dev/harness/questions/:id/answer', async (req, reply) => {
    const body = parse(HarnessAnswerBody, req.body, reply);
    if (body) return act(reply, req, () => harness.answer(req.params.id, body.answer));
  });

  app.post<{ Params: Params }>('/dev/harness/tasks/:id/move', async (req, reply) => {
    const body = parse(HarnessMoveBody, req.body, reply);
    if (body) return act(reply, req, () => harness.move(req.params.id, body.projectId));
  });

  app.post<{ Params: Params }>('/dev/harness/tasks/:id/complete', async (req, reply) =>
    act(reply, req, () => harness.complete(req.params.id)),
  );

  app.post<{ Params: Params }>('/dev/harness/projects/:id/close', async (req, reply) =>
    act(reply, req, () => harness.closeProject(req.params.id)),
  );
}
