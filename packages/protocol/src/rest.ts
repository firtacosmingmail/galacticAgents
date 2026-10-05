import { z } from 'zod';
import { AgentRole, AgentRuntime, TaskPriority, WorkBodyKind } from './enums.js';
import type { ControlAction as ControlActionType } from './commands.js';
import {
  Actor,
  AgentCaps,
  ProposedBody,
  PERMISSION_POLICY_PRESETS,
  PermissionPolicy,
  type PermissionPolicyPreset,
  TrustLevel,
} from './domain.js';
import { ControlTarget } from './events.js';
import { Timestamp } from './primitives.js';

// ---------------------------------------------------------------------------
// The small REST control surface (TECHNOLOGY §2.2; the ops console of P1-11). Results arrive on
// the WebSocket stream; these bodies only carry the request and its acknowledgement.
// ---------------------------------------------------------------------------

/** The names of the permission policy presets, derived from the presets themselves. */
export const PermissionPolicyPresetName = z.enum(
  Object.keys(PERMISSION_POLICY_PRESETS) as [PermissionPolicyPreset, ...PermissionPolicyPreset[]],
);

/** `POST /api/agents`. */
export const SpawnBody = z.object({
  role: AgentRole.default('steward'),
  runtime: AgentRuntime,
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  workspace: z.string().min(1).optional(),
  policy: PermissionPolicyPresetName.default('default'),
  caps: AgentCaps.partial().optional(),
  bare: z.boolean().optional(),
});
/** What a client sends (defaults not applied yet). */
export type SpawnBody = z.input<typeof SpawnBody>;

export const SpawnResponse = z.object({ agentId: z.string().min(1) });
export type SpawnResponse = z.infer<typeof SpawnResponse>;

/**
 * `POST /api/harmonizer/restart` (P5-06; SPEC decision 82): the running Harmonizer is stopped and
 * a fresh one started on the same runtime. `agentId` is the new one; `replaced` the stopped one.
 */
export const RestartHarmonizerResponse = z.object({
  agentId: z.string().min(1),
  replaced: z.string().min(1).optional(),
});
export type RestartHarmonizerResponse = z.infer<typeof RestartHarmonizerResponse>;

/** `POST /api/agents/:id/send`. */
export const SendBody = z.object({ text: z.string().min(1), interrupt: z.boolean().optional() });
export type SendBody = z.infer<typeof SendBody>;

export const SendResponse = z.object({ messageId: z.string().min(1) });
export type SendResponse = z.infer<typeof SendResponse>;

/**
 * `POST /api/questions/:id/answer`. `version` is the question's version the answerer saw (P2-18):
 * when it changed meanwhile — someone answered first, it was escalated — the answer is refused
 * with 409 `stale` and the message says who has it ("already answered by …", SPEC §2.6).
 */
export const AnswerBody = z.object({
  answer: z.string().min(1),
  version: z.number().int().nonnegative().optional(),
  /**
   * The client's idempotency key for this answer (P7-05): the same key on a retry (an answer
   * queued offline, an acknowledgement lost on a dropped connection) is answered `ok` with
   * `duplicate: true` once the first copy was recorded, instead of 409 `stale`.
   */
  answerId: z.string().min(1).max(100).optional(),
});
export type AnswerBody = z.infer<typeof AnswerBody>;

/** `POST /api/questions/:id/answer`'s reply; `duplicate` when `answerId` was already recorded. */
export const AnswerResponse = z.object({ ok: z.literal(true), duplicate: z.boolean().optional() });
export type AnswerResponse = z.infer<typeof AnswerResponse>;

/** A refused answer: `stale` when the question was answered or moved since `version`. */
export const AnswerRefusal = z.object({
  error: z.enum(['stale', 'rejected', 'not_found', 'invalid']),
  message: z.string().optional(),
});
export type AnswerRefusal = z.infer<typeof AnswerRefusal>;

/**
 * `POST /api/proposals/:id/decide` (P2-18): the user's decision on a work card or a plan card, as
 * `DomainCommands.decideProposal` takes it (SPEC §3.3, decisions 3, 16, 27, 35, 38). An edit
 * changes the size, the body and the workspace of a work card, or gives the `initGit` consent; a
 * plan card is approved or rejected only (its tasks are edited through `POST /api/control`).
 */
export const ProposalDecisionBody = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }),
  z.object({
    decision: z.literal('edit'),
    changes: z
      .object({
        kind: WorkBodyKind.optional(),
        proposedBody: ProposedBody.optional(),
        workspace: z.string().min(1).optional(),
        initGit: z.boolean().optional(),
        trust: TrustLevel.optional(),
      })
      .strict(),
  }),
  z.object({ decision: z.literal('reject'), reason: z.string().min(1).optional() }),
  z.object({ decision: z.literal('park'), reason: z.string().min(1) }),
]);
export type ProposalDecisionBody = z.infer<typeof ProposalDecisionBody>;

/** The acknowledgement of a decision: the card's state after it (it may have been parked). */
export const DecideResponse = z.object({
  ok: z.literal(true),
  state: z.string(),
  seq: z.number().int().nonnegative(),
});
export type DecideResponse = z.infer<typeof DecideResponse>;

/**
 * One chat line to an agent (P2-18): a `message.sent` event as the chat boxes show it — the
 * user's messages, a subordinate's reports, the system's notices. `at` is the event's time.
 */
export const ChatMessage = z.object({
  messageId: z.string().min(1),
  agentId: z.string().min(1),
  seq: z.number().int().positive(),
  at: z.string(),
  sender: Actor,
  text: z.string(),
  /** A brain's turn prompt (`message.sent.turn`, P25-03): not a conversation line. */
  turn: z.literal(true).optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** `GET /api/agents/:id/messages`: the messages sent to an agent, oldest first (the last 200). */
export const MessagesResponse = z.object({ messages: z.array(ChatMessage) });
export type MessagesResponse = z.infer<typeof MessagesResponse>;

/** `GET /api/runtimes`: what the spawn form can offer. */
export const RuntimesInfo = z.object({
  runtimes: z.array(
    z.object({
      name: AgentRuntime,
      resumable: z.boolean(),
      /** Fake-adapter scenario names (dev mode). */
      scenarios: z.array(z.string()).optional(),
    }),
  ),
  policies: z.array(PermissionPolicyPresetName),
  caps: AgentCaps,
  maxConcurrentAgents: z.number().int().positive(),
});
export type RuntimesInfo = z.infer<typeof RuntimesInfo>;

/**
 * A panel action (decision 11b, P2-14), as `DomainCommands.control` takes it. Edit carries the
 * fields the panel may change: a task's description and priority, a project's name and its
 * permission policy (`null` returns it to the global default; a remote client's choice is floored
 * at the global default, P2-21).
 */
export const ControlActionBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('stop') }),
  z.object({ action: z.literal('cancel') }),
  z.object({ action: z.literal('pause') }),
  z.object({ action: z.literal('resume') }),
  z.object({
    action: z.literal('edit'),
    changes: z
      .object({
        description: z.string().min(1).optional(),
        priority: TaskPriority.optional(),
        name: z.string().min(1).optional(),
        permissionPolicy: PermissionPolicy.nullable().optional(),
      })
      .strict(),
  }),
  z.object({ action: z.literal('close') }),
  z.object({ action: z.literal('archive') }),
  z.object({ action: z.literal('pin'), pinned: z.boolean() }),
  z.object({ action: z.literal('reopen') }),
]);

/** `POST /api/control`: one control action on a task, project or agent. */
export const ControlBody = z.object({ target: ControlTarget, action: ControlActionBody });
export type ControlBody = z.infer<typeof ControlBody>;

/** The acknowledgement; the events themselves arrive on the stream. */
export const ControlResponse = z.object({
  ok: z.literal(true),
  seq: z.number().int().nonnegative(),
});
export type ControlResponse = z.infer<typeof ControlResponse>;

// A parsed body is a valid `ControlAction` (compile-time check). A parsed `ProposalDecisionBody`
// is a `ProposalDecision` once its `undefined` edit fields are dropped (the route does).
const _controlAction: (b: ControlBody['action']) => ControlActionType = (b) => b;
void _controlAction;

// ---------------------------------------------------------------------------
// A Steward's processes (P4-14; SPEC decision 76, TECHNOLOGY §2.2 "Process cleanup")
// ---------------------------------------------------------------------------

/**
 * Why a process counts as the Steward's: a member of its CLI's process group (`group`), a
 * descendant of one (`descendant`: escaped with `setsid`, still a child), an orphan the server saw
 * as the live Steward's descendant earlier in this run, by pid and start time (`remembered`: a
 * tool command's shell left behind when the CLI died), or an orphan started during the Steward's
 * session whose working directory is inside the task's worktree and that carries the Steward's
 * marker (`worktree`).
 */
export const ProcessAttribution = z.enum(['group', 'descendant', 'worktree', 'remembered']);
export type ProcessAttribution = z.infer<typeof ProcessAttribution>;

/** One process attributed to a Steward. `command` is clipped and redacted. */
export const StewardProcess = z.object({
  pid: z.number().int().positive(),
  ppid: z.number().int().nonnegative(),
  command: z.string(),
  /** The working directory, when the platform could tell. */
  cwd: z.string().optional(),
  /** TCP ports it listens on. */
  ports: z.array(z.number().int().positive()),
  startedAt: Timestamp,
  why: ProcessAttribution,
  /**
   * In use by the running Steward: a direct child of its CLI (an MCP server it launched, the
   * shell of a tool command) or a descendant of one. Never stopped by "stop all": only when named
   * one by one. Absent once the Steward ended.
   */
  held: z.literal(true).optional(),
});
export type StewardProcess = z.infer<typeof StewardProcess>;

/**
 * `GET /api/agents/:id/processes`: the Steward's processes still running (its own CLI excluded
 * while it runs). `supported: false` on a platform the server cannot inspect (no `ps`).
 */
export const StewardProcessesResponse = z.object({
  agentId: z.string().min(1),
  supported: z.boolean(),
  processes: z.array(StewardProcess),
});
export type StewardProcessesResponse = z.infer<typeof StewardProcessesResponse>;

/**
 * `POST /api/agents/:id/processes/stop`: these pids (all attributable; their attributed descendants
 * go too, except held ones not named), or — only for a Steward that ended — all of them.
 */
export const StopProcessesBody = z.object({
  pids: z.array(z.number().int().positive()).min(1).optional(),
});
export type StopProcessesBody = z.infer<typeof StopProcessesBody>;

/**
 * What a stop did: `stopped` ended (SIGTERM or SIGKILL), `forced` needed SIGKILL, `alive` survived;
 * `skipped` were left alone because they exited or changed (another start time or parent: the pid
 * now names another process) between the attribution and the signal, or started too recently to
 * be told apart from a recycled pid.
 */
export const StopProcessesResponse = z.object({
  agentId: z.string().min(1),
  stopped: z.array(z.number().int().positive()),
  forced: z.array(z.number().int().positive()),
  alive: z.array(z.number().int().positive()),
  skipped: z.array(z.number().int().positive()).optional(),
});
export type StopProcessesResponse = z.infer<typeof StopProcessesResponse>;
