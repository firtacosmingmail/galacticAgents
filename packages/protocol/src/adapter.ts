import type { AgentCaps, PermissionPolicy } from './domain.js';
import type { AgentRole, AgentRuntime } from './enums.js';
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

export interface SpawnOptions {
  /** The server-assigned agent id; every event the adapter emits carries it. */
  agentId: Id;
  role: AgentRole;
  /** Working directory: the Steward's git worktree, or the project workspace for brains. */
  cwd: string;
  /** The project workspace root the permission policy measures "inside" against; defaults to `cwd`. */
  workspace?: string;
  prompt: string;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  permissionPolicy: PermissionPolicy;
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
  /** Deliver now, interrupting the current turn, instead of when the agent is next idle. */
  interrupt?: boolean;
}

export interface StopOptions {
  /** How long to wait for the current turn to end after `interrupt` before terminating. */
  graceMs?: number;
}

/**
 * The runtime-agnostic adapter (TECHNOLOGY §3). One adapter per runtime; a session is owned by
 * exactly one adapter. Brains and Stewards go through the same interface.
 */
export interface AgentAdapter {
  readonly runtime: AgentRuntime;
  spawn(opts: SpawnOptions): Promise<SpawnHandle>;
  /** Enqueued; delivered when the agent is idle unless `interrupt` is set. */
  send(sessionId: string, message: string, opts?: SendOptions): Promise<void>;
  /** Answers a pending `agent.needs_input` (clarification or permission). */
  answer(questionId: Id, answer: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** Graceful: interrupt, wait for the turn to end, then terminate. */
  stop(sessionId: string, opts?: StopOptions): Promise<void>;
  /** Re-attaches to a saved session after a restart. Absent for runtimes that cannot (PTY). */
  resumeSession?(sessionRef: string, opts: SpawnOptions): Promise<SpawnHandle>;
  /** The normalised event stream for every session of this adapter. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Stops every session and releases resources. */
  dispose(): Promise<void>;
}
