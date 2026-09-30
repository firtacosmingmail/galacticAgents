import type { AgentCaps, ToolCall } from './domain.js';
import type { AgentRole, AgentRuntime, PermissionAction } from './enums.js';
import type { AgentEvent } from './events.js';
import type { Id } from './primitives.js';

/**
 * A tool the server hands to a brain (Harmonizer, Waykeeper). The adapter registers it with the
 * runtime; the handler runs in the server against `DomainCommands`, never inside the runtime.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => Promise<unknown>;
}

/**
 * What the permission gate says about one tool call (SPEC §3.6, decision 7; TECHNOLOGY §3.1).
 * `allow` runs it; `deny` refuses it with a reason the agent can read (a hard cap, a denied
 * category); `ask` blocks it behind `agent.needs_input(kind: permission)` until the user answers.
 */
export type GateVerdict =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | {
      decision: 'ask';
      /** The policy category that asks; goes into `QuestionContext.permissionAction`. */
      action?: PermissionAction;
      /** One human-readable line per finding, for the permission card. */
      reasons: string[];
    };

/**
 * The runtime's decision function for tool calls, built per spawn from the project's policy
 * table and the agent's hard caps. Adapters call it from their permission hook and never see the
 * policy itself, so every runtime — SDK, ACP, PTY — gets the same decisions from one
 * implementation. Synchronous: the hook sits on the agent's hot path and never waits on I/O.
 */
export interface PermissionGate {
  check(call: ToolCall): GateVerdict;
}

export interface SpawnOptions {
  /** The server-assigned agent id; every event the adapter emits carries it. */
  agentId: Id;
  role: AgentRole;
  /** Working directory: the Steward's git worktree, or the project workspace for brains. */
  cwd: string;
  prompt: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  /** Decides every tool call (policy table + caps); `ask` becomes a permission question. */
  gate: PermissionGate;
  caps: AgentCaps;
  /** Opt-in per spawn only (SPEC decision 17): skips repository context and subscription login. */
  bare?: boolean;
}

export interface SpawnHandle {
  /** Adapter-local handle used for every later call. */
  sessionId: string;
  /** Runtime-specific reference persisted on `Agent.sessionRef` for `resumeSession`. */
  sessionRef?: string;
}

export interface SendOptions {
  /** The runtime already cancelled the current turn (or is about to): start the new one at once. */
  interrupt?: boolean;
}

export interface StopOptions {
  /** How long to wait for the current turn to end after `interrupt` before terminating. */
  graceMs?: number;
}

/**
 * The runtime-agnostic adapter (TECHNOLOGY §3). One adapter per runtime; a session is owned by
 * exactly one adapter. Brains and Stewards go through the same interface.
 *
 * An adapter is a translator, not a scheduler: the server's runtime owns the per-agent inbox,
 * the caps, the permission policy and the event log. The adapter turns runtime-specific traffic
 * into the normalised `agent.*` events and the calls below into runtime-specific actions.
 */
export interface AgentAdapter {
  readonly runtime: AgentRuntime;
  spawn(opts: SpawnOptions): Promise<SpawnHandle>;
  /**
   * Starts a new turn with `message` now. The runtime's inbox guarantees the session is idle
   * (or that it just called `interrupt`, when `interrupt` is set); an adapter keeps no queue of
   * its own and may reject a message that arrives mid-turn.
   */
  send(sessionId: string, message: string, opts?: SendOptions): Promise<void>;
  /** Answers a pending `agent.needs_input` (clarification or permission). */
  answer(questionId: Id, answer: string): Promise<void>;
  /** Cancels the current turn; the session reports `agent.idle` when it has. */
  interrupt(sessionId: string): Promise<void>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** Graceful: interrupt, wait for the turn to end, then terminate; ends with `agent.stopped`. */
  stop(sessionId: string, opts?: StopOptions): Promise<void>;
  /** Re-attaches to a saved session after a restart. Absent for runtimes that cannot (PTY). */
  resumeSession?(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle>;
  /**
   * The normalised event stream for every session of this adapter — the only source of
   * `agent.*` events for its sessions (the runtime adds `agent.spawned`).
   */
  readonly events: AsyncIterable<AgentEvent>;
  /** Stops every session and releases resources. */
  dispose(): Promise<void>;
}
