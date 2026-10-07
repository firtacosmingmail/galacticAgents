import { z } from 'zod';

/** The sizes work comes in, and the bodies that host it (SPEC §3.1). */
export const WorkBodyKind = z.enum(['planet', 'moon', 'asteroid']);
export type WorkBodyKind = z.infer<typeof WorkBodyKind>;

/**
 * Every celestial body of the catalogue (P2-02): the bodies that host work, and the Sun, which is
 * reserved like Earth and Earth's Moon and never hosts anything (SPEC §3.1).
 */
export const BodyKind = z.enum(['star', ...WorkBodyKind.options]);
export type BodyKind = z.infer<typeof BodyKind>;

/** What a body hosts: a project (planet/moon) or a standalone task (asteroid). */
export const HostKind = z.enum(['project', 'task']);
export type HostKind = z.infer<typeof HostKind>;

/** The three agent roles (SPEC §2). */
export const AgentRole = z.enum(['harmonizer', 'waykeeper', 'steward']);
export type AgentRole = z.infer<typeof AgentRole>;

/** Runtimes behind the AgentAdapter interface (TECHNOLOGY §3). Only claude-sdk and fake exist in v1. */
export const AgentRuntime = z.enum(['claude-sdk', 'fake', 'acp', 'pty']);
export type AgentRuntime = z.infer<typeof AgentRuntime>;

/** Agent process states (TECHNOLOGY §4). */
export const AgentState = z.enum([
  'starting',
  'working',
  'waiting_for_input',
  'idle',
  'stalled',
  'paused',
  'interrupted',
  'finished',
  'failed',
  'stopped',
]);
export type AgentState = z.infer<typeof AgentState>;

/**
 * The terminal agent states: an agent in one of these is no longer running (an `interrupted` one
 * can be recovered from its session ref, which starts it again). Shared by the server's status
 * store (ended records are sinks and subject to retention) and the console (ended agents take no
 * controls).
 */
export const ENDED_STATES: ReadonlySet<AgentState> = new Set<AgentState>([
  'finished',
  'failed',
  'stopped',
  'interrupted',
]);

/** Task and project states (SPEC §4.4), derived from agents and open questions. */
export const WorkState = z.enum([
  'proposed',
  'approved',
  'in_progress',
  'blocked_on_user',
  'awaiting_closure',
  'completed',
  'archived',
  'failed',
  'paused',
  'moved',
  'interrupted',
]);
export type WorkState = z.infer<typeof WorkState>;

/** Question kinds (SPEC §2.6, decision 7 and 12). */
export const QuestionKind = z.enum(['clarification', 'permission']);
export type QuestionKind = z.infer<typeof QuestionKind>;

export const QuestionStatus = z.enum(['open', 'answered', 'cancelled']);
export type QuestionStatus = z.infer<typeof QuestionStatus>;

/** Proposal states (SPEC §3.3, decision 16). */
export const ProposalState = z.enum(['pending', 'approved', 'edited', 'rejected', 'parked']);
export type ProposalState = z.infer<typeof ProposalState>;

export const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** Who holds (must answer) a question, who answered it, who triggered a control action. */
export const ActorType = z.enum(['agent', 'user', 'system']);
export type ActorType = z.infer<typeof ActorType>;

/** Action categories of the per-project permission policy (SPEC §3.6). */
export const PermissionAction = z.enum([
  'read_workspace',
  'edit_workspace',
  'run_workspace',
  'destructive',
  'outside_workspace',
  'network',
  'push',
]);
export type PermissionAction = z.infer<typeof PermissionAction>;

export const PermissionDecision = z.enum(['allow', 'ask', 'deny']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

/**
 * Where a request came from (P2-21; TECHNOLOGY §8): `local` only for one `isRemoteRequest` let
 * through as this machine. A policy write whose origin is not `local` (remote or unknown) is
 * floored at the global default unless the server sets `autoApproveRemote`.
 */
export const RequestOrigin = z.enum(['local', 'remote']);
export type RequestOrigin = z.infer<typeof RequestOrigin>;

/**
 * Why a domain command was refused (P2-01). The REST and WS surfaces map these to their own
 * error shapes; brain tools hand the message back to the LLM as a tool error.
 */
export const DomainErrorCode = z.enum([
  /** No such project, task, body, agent, proposal or question. */
  'not_found',
  /** The entity's state does not allow it (SPEC §4.4 transitions, a decided proposal). */
  'invalid_transition',
  /** Something else holds it: a taken body, a reserved body, a planet with an active sub-project. */
  'conflict',
  /** The answer was given against an older version; the reply says who answered first. */
  'stale',
  /** The input is malformed or contradicts itself. */
  'invalid',
  /**
   * Refused to a remote client (P9-01; decisions 51, 131): a user's write that works only from the
   * Mac unless `autoApproveRemote`. REST answers 403 `remote_control`, like the routes' own check.
   */
  'remote_control',
]);
export type DomainErrorCode = z.infer<typeof DomainErrorCode>;
