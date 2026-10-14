import { z } from 'zod';
import { AgentRole, AgentRuntime, TaskPriority, WorkBodyKind } from './enums.js';
import type { ControlAction as ControlActionType } from './commands.js';
import { ReplyQuote, ReplyRef } from './reply.js';
import {
  Actor,
  AgentCaps,
  BudgetUsd,
  ProposedBody,
  PERMISSION_POLICY_PRESETS,
  PermissionPolicy,
  type PermissionPolicyPreset,
  PermissionRule,
  PermissionRuleScope,
  TrustLevel,
} from './domain.js';
import { ControlTarget } from './events.js';
import { Id, Timestamp } from './primitives.js';

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
export const SendBody = z.object({
  text: z.string().min(1),
  interrupt: z.boolean().optional(),
  /**
   * The line this message replies to (P8-17, SPEC decision 139): resolved by the server, which
   * refuses an unknown target or one that is not in this agent's chat (400 `reply_target`) and a
   * reply chunk retention removed (409 `reply_target_gone`). A reply to an open clarification
   * answers it first (409 `stale` when it was answered meanwhile, and nothing is sent).
   */
  replyTo: ReplyRef.optional(),
});
export type SendBody = z.infer<typeof SendBody>;

export const SendResponse = z.object({ messageId: z.string().min(1) });
export type SendResponse = z.infer<typeof SendResponse>;

/**
 * Control characters a line typed into a terminal agent may not carry (P8-08 review): C0 except
 * TAB (Ctrl-C, Ctrl-U, ESC, newlines…), DEL and C1 (CSI…). The adapter strips them from every
 * line it types; the terminal route refuses them (400) so the user sees what was not typed.
 */
// eslint-disable-next-line no-control-regex
export const TERMINAL_CONTROL_CHARS = /[\x00-\x08\x0A-\x1F\x7F-\x9F]/;

/**
 * `POST /api/agents/:id/terminal` (P8-08): one line the user types into a terminal agent's (PTY)
 * terminal — the text then Enter, at once, whatever the agent is doing. Only from this machine's
 * own browser, never from a remote client (not even with `autoApproveRemote`); logged as the
 * user's `message.sent` (and `message.delivered` once typed), secrets redacted. A line with
 * control characters is refused (400). 409 for an agent that has no
 * terminal or is not running.
 */
export const TerminalInputBody = z.object({
  text: z
    .string()
    .max(4_000)
    .refine((t) => !TERMINAL_CONTROL_CHARS.test(t), {
      message:
        'The line may not contain control characters (Ctrl keys, escape sequences, newlines): ' +
        'only printable text and tabs are typed into a terminal.',
    }),
});
export type TerminalInputBody = z.infer<typeof TerminalInputBody>;

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

/**
 * `POST /api/questions/:id/dismiss` (P9-14, SPEC decision 135): the user withdraws a question
 * without answering it. A clarification is withdrawn and its agent told "the user dismissed this
 * question"; a permission request is denied ("dismissed by the user"), never allowed. `version`
 * as for an answer: a question answered or moved since is refused with 409 `stale`. Never queued
 * offline; open to remote clients like an answer (decision 90).
 */
export const DismissBody = z.object({
  version: z.number().int().nonnegative().optional(),
});
export type DismissBody = z.infer<typeof DismissBody>;

/** `POST /api/questions/:id/dismiss`'s reply. */
export const DismissResponse = z.object({ ok: z.literal(true) });
export type DismissResponse = z.infer<typeof DismissResponse>;

/**
 * `POST /api/questions/:id/similar-preview` (P9-17, SPEC decision 138): what the card's "Allow
 * similar" chooser offers for an open permission request — one option per scope, each with a
 * label and a preview of exactly what the rule would match, or why it is not offered — computed
 * by the server from the request. `refused` says why no rule can be made at all (a push, a request
 * outside any project, a call the table no longer asks about). `allowed`: whether this client may
 * make one (the Mac, or any client with `autoApproveRemote`).
 */
export const SimilarOption = z.object({
  scope: PermissionRuleScope,
  available: z.boolean(),
  label: z.string().optional(),
  preview: z.string().optional(),
  /**
   * What binds this preview to the rule stored (P9-17 review S1): sent back with
   * `allow-similar`, which refuses (409 `stale`) when the rule it drafts again differs.
   */
  digest: z.string().optional(),
  reason: z.string().optional(),
});
export type SimilarOption = z.infer<typeof SimilarOption>;

export const SimilarPreviewResponse = z.object({
  questionId: Id,
  projectId: Id.optional(),
  projectName: z.string().optional(),
  refused: z.string().optional(),
  options: z.array(SimilarOption),
  allowed: z.boolean(),
});
export type SimilarPreviewResponse = z.infer<typeof SimilarPreviewResponse>;

/**
 * `POST /api/questions/:id/allow-similar` (P9-17): answers the request "allow" and stores the rule
 * of `scope` the preview showed — `digest` is the preview's for that scope, and a rule drafted
 * again that differs is refused (409 `stale`). `version` and `answerId` as for an answer.
 */
export const AllowSimilarBody = z.object({
  scope: PermissionRuleScope,
  digest: z.string().min(1).max(128),
  version: z.number().int().nonnegative().optional(),
  answerId: z.string().min(1).max(100).optional(),
});
export type AllowSimilarBody = z.infer<typeof AllowSimilarBody>;

/**
 * `rule`: the rule stored. `ruleNotStored`: the request was allowed once, but the rule could not
 * be stored after it (the project closed meanwhile, say) — said to the user (P9-17 review S6).
 */
export const AllowSimilarResponse = z.object({
  ok: z.literal(true),
  rule: PermissionRule.optional(),
  ruleNotStored: z.string().optional(),
});
export type AllowSimilarResponse = z.infer<typeof AllowSimilarResponse>;

/** `DELETE /api/projects/:id/permission-rules/:ruleId`'s reply (P9-17). */
export const RemovePermissionRuleResponse = z.object({ ok: z.literal(true) });
export type RemovePermissionRuleResponse = z.infer<typeof RemovePermissionRuleResponse>;

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
        /** The work's dollar budget (P8-01); `null` drops it from the card. */
        budgetUsd: BudgetUsd.nullable().optional(),
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
  /** What the message quotes (`message.sent.replyTo`, P8-17). */
  replyTo: ReplyQuote.optional(),
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
        /** The project's or task's dollar budget (P8-01); `null` removes it. */
        budgetUsd: BudgetUsd.nullable().optional(),
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
