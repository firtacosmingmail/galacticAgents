import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import {
  AgentRuntime as AgentRuntimeName,
  AnswerBody,
  DismissBody,
  ControlBody,
  PERMISSION_POLICY_PRESETS,
  ProposalDecisionBody,
  SendBody,
  SpawnBody,
  StopProcessesBody,
  TerminalInputBody,
  type Actor,
  type AgentCommandsResponse,
  type AnswerResponse,
  type DismissResponse,
  type ChatMessage,
  type ControlAction,
  type ControlResponse,
  type DecideResponse,
  type MessagesResponse,
  type ProposalDecision,
  type RestartHarmonizerResponse,
  type RuntimesInfo,
  type SendResponse,
  type SpawnResponse,
  type StewardProcessesResponse,
  type StopProcessesResponse,
} from '@galactic/protocol';
import type { ServerConfig } from '../config/config.js';
import type { AgentRuntime } from '../runtime/agent-runtime.js';
import type { Commands } from '../domain/commands.js';
import { DomainError } from '../domain/errors.js';
import type { EventLog } from '../domain/event-log.js';
import { redactSecrets } from '../runtime/redact.js';
import type { StewardProcessControl } from '../runtime/steward-processes.js';
import { policyForWrite } from '../domain/permissions.js';
import { bearerGuard, originOf } from './security.js';
import { sendStorageRefusal } from './storage-refusal.js';

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
  /** A Steward's processes (P4-14): enables `GET /api/agents/:id/processes` and its stop. */
  processes?: StewardProcessControl;
  /** The Harmonizer's restart (P5-06): enables `POST /api/harmonizer/restart`. */
  restartHarmonizer?: () => Promise<RestartHarmonizerResponse>;
}

const USER: Actor = { type: 'user' };
/** How many messages `GET /api/agents/:id/messages` returns (the newest). */
const CHAT_HISTORY = 200;

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
      void reply.code(400).send({
        error: 'invalid_body',
        message: parsed.error.issues[0]?.message ?? 'invalid body',
        issues: parsed.error.issues,
      });
      return undefined;
    };
    const agentId = (req: FastifyRequest) => (req.params as { id: string }).id;
    /**
     * Controls a remote client may not use unless the server trusts remote clients
     * (`autoApproveRemote`; SPEC decision 90): a free-form spawn (the ops console's development
     * tool, decision 24), stopping a Steward's leftover processes and restarting the Harmonizer.
     * 403 `remote_control`, with nothing done; stopping, pausing, resuming or recovering an agent,
     * answers and the work controls stay open to the phone. Work-driven spawns (a Waykeeper's
     * Stewards, the Harmonizer's) never come through here.
     */
    const refuseRemoteControl = (req: FastifyRequest, reply: FastifyReply, what: string) => {
      if (config.autoApproveRemote || originOf(req) === 'local') return false;
      void reply.code(403).send({
        error: 'remote_control',
        message: `${what} only from this machine's own browser (not from a remote client).`,
      });
      return true;
    };
    const attempt = async (reply: FastifyReply, fn: () => Promise<unknown>) => {
      try {
        return (await fn()) ?? { ok: true };
      } catch (error) {
        // A full disk is not a conflict: 507 `storage_full` (P8-09), nothing done.
        if (sendStorageRefusal(reply, error)) return reply;
        return reply.code(409).send(refusal('rejected', (error as Error).message));
      }
    };

    /** What the spawn form can offer. */
    app.get('/api/runtimes', async (): Promise<RuntimesInfo> => ({
      // Every runtime with an adapter registered here (ACP only when `acp` is configured).
      runtimes: AgentRuntimeName.options
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
      if (refuseRemoteControl(req, reply, 'Free-form agents can be spawned')) return reply;
      const body = parse(SpawnBody, req.body, reply);
      if (!body) return;
      const result = await runtime.spawn({
        role: body.role,
        runtime: body.runtime,
        prompt: body.prompt,
        cwd: body.cwd,
        ...(body.workspace ? { workspace: body.workspace } : {}),
        // A remote client never sets up auto-approvals unless the server allows it (P2-04).
        // A remote client's preset is floored at the global default (P2-04, P2-21) — kept as a
        // second line behind the refusal above, which only `autoApproveRemote` lifts.
        permissionPolicy: policyForWrite(PERMISSION_POLICY_PRESETS[body.policy], {
          origin: originOf(req),
          autoApproveRemote: config.autoApproveRemote,
        }),
        ...(body.caps ? { caps: compact(body.caps) } : {}),
        ...(body.bare ? { bare: true } : {}),
        // Whatever its role, a free-form agent keeps the wall-clock cap (SPEC decision 103).
        freeForm: true,
      });
      if (!result.ok) return reply.code(409).send(refusal('refused', result.reason));
      return reply.code(201).send({ agentId: result.agent.id } satisfies SpawnResponse);
    });

    app.post('/api/agents/:id/send', async (req, reply) => {
      const body = parse(SendBody, req.body, reply);
      if (!body) return;
      return attempt(reply, async () => {
        // The origin rides on `message.sent`: a brain acting on it writes policies as this
        // request would (P2-21).
        const message = runtime.send(agentId(req), body.text, {
          sender: USER,
          origin: originOf(req),
          ...(body.interrupt ? { interrupt: true } : {}),
        });
        // The user wrote to the agent directly: its open clarifications are superseded (P9-14,
        // SPEC decision 135) — not by a slash command, which is no reply. Never fails the send.
        if (commands && !body.text.trimStart().startsWith('/')) {
          await commands
            .supersedeQuestions(agentId(req), (questionId, error) => {
              req.log.error({ err: error, questionId }, 'superseding a question failed');
            })
            .catch((error: unknown) => {
              req.log.error({ err: error }, 'superseding questions after a message failed');
            });
        }
        return { messageId: message.id } satisfies SendResponse;
      });
    });

    /**
     * Types a line into a terminal agent's terminal (P8-08; decision 113): only from
     * this machine's own browser — never from a remote client, `autoApproveRemote` or not: a
     * keyboard on an agent no table can judge is the Mac's alone. 409 when the agent has no
     * terminal or is not running; logged as the user's message.
     */
    app.post('/api/agents/:id/terminal', async (req, reply) => {
      if (originOf(req) !== 'local') {
        return reply.code(403).send({
          error: 'remote_control',
          message: "Typing into an agent's terminal works only from this machine's own browser.",
        });
      }
      const body = parse(TerminalInputBody, req.body, reply);
      if (!body) return;
      return attempt(reply, async () =>
        runtime.typeInto(agentId(req), body.text, { by: USER, origin: 'local' }),
      );
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
     * The panel's "Restart Harmonizer" (P5-06; SPEC decision 82): stops the running Harmonizer as
     * the user's stop and starts a fresh one on the same runtime; the reply names the new one.
     * A local client may ask; a remote one only when the server trusts remote clients
     * (`autoApproveRemote`; 403 `remote_control` otherwise, P7-02). 409 when it refuses (a
     * restart or a resume of the Harmonizer under way, no runtime configured, the start refused),
     * 429 with `Retry-After` past the restart window (3 in 10 min), 500 for anything unexpected.
     */
    const { restartHarmonizer } = opts;
    if (restartHarmonizer) {
      app.post('/api/harmonizer/restart', async (req, reply) => {
        if (refuseRemoteControl(req, reply, 'The Harmonizer can be restarted')) return reply;
        try {
          return (await restartHarmonizer()) satisfies RestartHarmonizerResponse;
        } catch (error) {
          if (sendStorageRefusal(reply, error)) return reply;
          if (!(error instanceof DomainError)) {
            req.log.error(error);
            return reply.code(500).send({
              error: 'internal',
              message: redactSecrets(String((error as Error).message ?? error)),
            });
          }
          req.log.warn(error);
          const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
          if (typeof retryAfterMs === 'number') {
            void reply.header('retry-after', String(Math.max(Math.ceil(retryAfterMs / 1000), 1)));
            return reply.code(429).send(refusal('refused', error.message));
          }
          return reply.code(409).send(refusal('refused', error.message));
        }
      });
    }

    /**
     * Reopens an interrupted agent from its session ref (the manual half of P1-14): the same
     * path as startup recovery (P1-29) — 409 unless the agent is interrupted and not running.
     * An agent whose runtime cannot resume (PTY, P8-08) is restarted from its first prompt.
     * Open to remote clients like resume (decision 90): it continues work already started.
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
     * state refuses it; the events arrive on the stream. A project edit may set or clear its
     * permission policy: a remote client's is floored at the global default (P2-21).
     */
    const { commands } = opts;
    /**
     * A refused domain command as the console reads it (P2-14, P2-18): 404 unknown, 400 invalid,
     * 403 `remote_control` (a write the Mac alone may make, P9-01), 409 for a state that refuses it (`stale` keeps its code: "already answered by …"), 507 / 503
     * when the storage refused it (P8-09), 500 for anything that is not a refusal (a bug or a
     * runtime failure, never reported as a conflict).
     */
    const refuse = (req: FastifyRequest, reply: FastifyReply, error: unknown) => {
      // The storage refused it (P8-09): 507 `storage_full` / 503, nothing done.
      if (sendStorageRefusal(reply, error)) return reply;
      if (!(error instanceof DomainError)) {
        req.log.error(error);
        return reply.code(500).send({ error: 'internal' });
      }
      if (error.code === 'not_found') {
        return reply.code(404).send({ error: 'not_found', message: redactSecrets(error.message) });
      }
      if (error.code === 'invalid') {
        return reply.code(400).send({ error: 'invalid', message: redactSecrets(error.message) });
      }
      if (error.code === 'stale') {
        return reply.code(409).send({ error: 'stale', message: redactSecrets(error.message) });
      }
      if (error.code === 'remote_control') {
        return reply
          .code(403)
          .send({ error: 'remote_control', message: redactSecrets(error.message) });
      }
      return reply.code(409).send(refusal('rejected', error.message));
    };
    if (commands) {
      app.post('/api/control', async (req, reply) => {
        const body = parse(ControlBody, req.body, reply);
        if (!body) return;
        try {
          await commands.control(body.target, body.action as ControlAction, USER, {
            origin: originOf(req),
          });
          return { ok: true, seq: log.currentSeq() } satisfies ControlResponse;
        } catch (error) {
          return refuse(req, reply, error);
        }
      });

      /**
       * The user's decision on a proposal card (P2-18; SPEC §3.3): approve, edit (size, body,
       * workspace, the `initGit` consent of decision 27), reject with a reason, or park. The same
       * `DomainCommands.decideProposal` the brains' flows use, as the user: approval creates what
       * the card asks for (decision 38) and wakes the card's owner. The trust level the user
       * chose on the card (decision 49) becomes the approved project's policy, floored for a
       * remote request like every policy write (P2-21); later the table is edited through
       * `/api/control`, floored there too.
       */
      app.post('/api/proposals/:id/decide', async (req, reply) => {
        const body = parse(ProposalDecisionBody, req.body, reply);
        if (!body) return;
        const decision: ProposalDecision =
          body.decision === 'edit'
            ? { decision: 'edit', changes: compact(body.changes) }
            : body.decision === 'reject'
              ? { decision: 'reject', ...(body.reason ? { reason: body.reason } : {}) }
              : body;
        try {
          const { value } = await commands.decideProposal(
            (req.params as { id: string }).id,
            decision,
            USER,
            { origin: originOf(req) },
          );
          return { ok: true, state: value.state, seq: log.currentSeq() } satisfies DecideResponse;
        } catch (error) {
          return refuse(req, reply, error);
        }
      });
    }

    /**
     * The messages sent to an agent (P2-18): the chat boxes' history after a reload or a snapshot,
     * read from the log's `message.sent` events — the same events the page folds live from the
     * stream, so the text is what the stream carries (user-written text is not redacted,
     * TECHNOLOGY §8; a Steward's report was redacted when it was made). The last 200, through the
     * `(type, agentId)` index.
     */
    app.get('/api/agents/:id/messages', async (req, reply) => {
      const id = agentId(req);
      if (!log.tables.agents.get(id)) return reply.code(404).send({ error: 'not_found' });
      const messages: ChatMessage[] = [];
      for (const { seq, at, event } of log.latestOf('message.sent', id, CHAT_HISTORY)) {
        if (event.type !== 'message.sent') continue;
        messages.push({
          messageId: event.messageId,
          agentId: id,
          seq,
          at,
          sender: event.sender,
          text: event.text,
        });
      }
      return { messages } satisfies MessagesResponse;
    });

    /**
     * The slash commands the agent's live session offers (P8-13; `P8-13-14-composer.md`): what its
     * runtime reported, read from the adapter (runtime state, never logged). `[]` for an agent
     * without a live session or whose runtime has none; 404 for an unknown agent. Read-only, so
     * open to remote clients too. The text is the runtime's (skill and plugin authors'): the page
     * shows it as plain text.
     */
    app.get('/api/agents/:id/commands', async (req, reply) => {
      const id = agentId(req);
      if (!log.tables.agents.get(id)) return reply.code(404).send({ error: 'not_found' });
      return { commands: await runtime.commands(id) } satisfies AgentCommandsResponse;
    });

    /**
     * A Steward's processes (P4-14; SPEC decision 76): what attribution gives it now (its own CLI
     * left out while it runs, what that CLI uses marked `held`), and the user's stop — of the
     * given pids, every one of which must be attributable (400 otherwise, nothing signalled), or
     * of all of them for a Steward that ended (400 while it runs: the panel sends the pids it
     * showed). 404 for an unknown agent, 400 for an agent that is not a Steward. The stop is local
     * only unless `autoApproveRemote` (403 `remote_control`, P7-02); the list is open to all.
     */
    const { processes } = opts;
    if (processes) {
      app.get('/api/agents/:id/processes', async (req, reply) => {
        try {
          return (await processes.list(agentId(req))) satisfies StewardProcessesResponse;
        } catch (error) {
          return refuse(req, reply, error);
        }
      });
      app.post('/api/agents/:id/processes/stop', async (req, reply) => {
        if (refuseRemoteControl(req, reply, "A Steward's processes can be stopped")) return reply;
        const body = parse(StopProcessesBody, req.body, reply);
        if (!body) return;
        try {
          return (await processes.stop(agentId(req), {
            by: USER,
            ...(body.pids ? { pids: body.pids } : {}),
          })) satisfies StopProcessesResponse;
        } catch (error) {
          return refuse(req, reply, error);
        }
      });
    }

    /**
     * Answers a question as the user (SPEC §2.6). With the command surface it is
     * `DomainCommands.answerQuestion`: first answer wins, `version` refuses a stale answer with
     * 409 `stale` ("already answered by …"), and a question no live session waits on (a brain's
     * `ask_user`, a closure question) is answered too (P2-18). Without it, the Phase 1 path.
     * `answerId` (P7-05) makes a retry idempotent: once recorded under it, the same answer is `ok`
     * with `duplicate: true` (an answer queued offline whose acknowledgement was lost).
     */
    app.post('/api/questions/:id/answer', async (req, reply) => {
      const body = parse(AnswerBody, req.body, reply);
      if (!body) return;
      const questionId = (req.params as { id: string }).id;
      if (!commands) {
        return attempt(reply, () => runtime.answer(questionId, body.answer, USER));
      }
      try {
        const { events } = await commands.answerQuestion({
          questionId,
          answer: body.answer,
          by: USER,
          ...(body.version !== undefined ? { version: body.version } : {}),
          ...(body.answerId !== undefined ? { answerId: body.answerId } : {}),
        });
        // A retry of an answer already recorded under its `answerId` changes nothing (P7-05).
        const duplicate = body.answerId !== undefined && events.length === 0;
        return { ok: true, ...(duplicate ? { duplicate } : {}) } satisfies AnswerResponse;
      } catch (error) {
        // Anything that is not a domain refusal (an adapter that failed to take the answer) is a
        // 500, logged here and never echoed to the client.
        return refuse(req, reply, error);
      }
    });

    /**
     * Dismisses a question as the user (P9-14, SPEC decision 135): a clarification is withdrawn
     * and its agent told "the user dismissed this question"; a permission request is denied,
     * never allowed. `version` refuses a stale dismissal with 409 `stale` like an answer (one
     * answered or withdrawn meanwhile included). Open to remote clients — it is an answer
     * (decision 90) — and logged with the request's origin. Needs the command surface.
     */
    if (commands) {
      app.post('/api/questions/:id/dismiss', async (req, reply) => {
        const body = parse(DismissBody, req.body ?? {}, reply);
        if (!body) return;
        const questionId = (req.params as { id: string }).id;
        try {
          await commands.dismissQuestion({
            questionId,
            by: USER,
            origin: originOf(req),
            ...(body.version !== undefined ? { version: body.version } : {}),
          });
          return { ok: true } satisfies DismissResponse;
        } catch (error) {
          return refuse(req, reply, error);
        }
      });
    }
  });
}

/** Drops `undefined` values so partial caps satisfy `exactOptionalPropertyTypes`. */
function compact<T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
