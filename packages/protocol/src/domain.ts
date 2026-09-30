import { z } from 'zod';
import { Id, Meta, Timestamp } from './primitives.js';
import {
  ActorType,
  AgentRole,
  AgentRuntime,
  AgentState,
  BodyKind,
  HostKind,
  PermissionAction,
  PermissionDecision,
  ProposalState,
  QuestionKind,
  QuestionStatus,
  TaskPriority,
  WorkState,
} from './enums.js';

/** A reference to whatever a body hosts. */
export const Host = z.object({ kind: HostKind, id: Id });
export type Host = z.infer<typeof Host>;

/** An agent, the user, or the system itself. `id` is absent for user and system. */
export const Actor = z.object({ type: ActorType, id: Id.optional() });
export type Actor = z.infer<typeof Actor>;

/** Hard caps enforced by the process supervisor (SPEC decision 18, TECHNOLOGY §5.4). */
export const AgentCaps = z.object({
  maxWallClockMs: z.number().int().positive(),
  maxToolCalls: z.number().int().positive(),
});
export type AgentCaps = z.infer<typeof AgentCaps>;

export const Body = z.object({
  id: Id,
  kind: BodyKind,
  /** Moons point at their planet. Planets and asteroids have no parent. */
  parentId: Id.optional(),
  name: z.string().min(1),
  host: Host.optional(),
  meta: Meta.optional(),
});
export type Body = z.infer<typeof Body>;

export const Project = z.object({
  id: Id,
  name: z.string().min(1),
  /** Directory where the project's work happens (SPEC §3.5). */
  workspace: z.string().min(1),
  repoPath: z.string().optional(),
  /** Set for sub-projects living on a moon of the parent's planet (decision 10). */
  parentProjectId: Id.optional(),
  bodyId: Id,
  state: WorkState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Project = z.infer<typeof Project>;

export const Task = z.object({
  id: Id,
  /** Absent for standalone (asteroid) tasks. */
  projectId: Id.optional(),
  bodyId: Id,
  description: z.string().min(1),
  priority: TaskPriority,
  worktreePath: z.string().optional(),
  branch: z.string().optional(),
  blockedBy: z.array(Id),
  state: WorkState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Task = z.infer<typeof Task>;

export const Agent = z.object({
  id: Id,
  role: AgentRole,
  runtime: AgentRuntime,
  /** Runtime-specific session handle used to resume after a restart; absent until the adapter reports it. */
  sessionRef: z.string().optional(),
  /** Absent only for the Harmonizer. */
  supervisorId: Id.optional(),
  bodyId: Id,
  /** The task a Steward works on. */
  taskId: Id.optional(),
  /** The project a Waykeeper runs. */
  projectId: Id.optional(),
  caps: AgentCaps,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Agent = z.infer<typeof Agent>;

/** The body the Harmonizer proposes for a work request (SPEC §3.3). */
export const ProposedBody = z.object({
  kind: BodyKind,
  /** Planet for a proposed moon. */
  parentId: Id.optional(),
  /** An existing free body, when the Harmonizer picked one. */
  bodyId: Id.optional(),
  name: z.string().min(1),
});
export type ProposedBody = z.infer<typeof ProposedBody>;

export const Proposal = z.object({
  id: Id,
  requestText: z.string().min(1),
  /** The proposed size. */
  kind: BodyKind,
  proposedBody: ProposedBody,
  workspace: z.string().min(1),
  rationale: z.string(),
  state: ProposalState,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Proposal = z.infer<typeof Proposal>;

/** What a question is about: the text the agent asked plus optional choices or the tool call awaiting permission. */
export const QuestionContext = z.object({
  text: z.string().min(1),
  options: z.array(z.string()).optional(),
  toolCall: z.object({ toolName: z.string(), input: z.unknown().optional() }).optional(),
  permissionAction: PermissionAction.optional(),
});
export type QuestionContext = z.infer<typeof QuestionContext>;

export const Question = z.object({
  id: Id,
  kind: QuestionKind,
  originAgentId: Id,
  /** Who must answer now. Routing follows Agent.supervisorId; permission questions always hold `user`. */
  holder: Actor,
  status: QuestionStatus,
  context: QuestionContext,
  answeredBy: Actor.optional(),
  answer: z.string().optional(),
  /** Bumped on every holder change or answer; offline answers carry it so a stale answer can be refused. */
  version: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  meta: Meta.optional(),
});
export type Question = z.infer<typeof Question>;

export const Cost = z.object({
  usd: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type Cost = z.infer<typeof Cost>;

export const Progress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  items: z.array(z.object({ label: z.string(), done: z.boolean() })).optional(),
});
export type Progress = z.infer<typeof Progress>;

const CapUsage = z.object({ used: z.number().nonnegative(), limit: z.number().positive() });

/** Per-agent status record: a projection of the event log, never the source of truth (TECHNOLOGY §4). */
export const StatusRecord = z.object({
  agentId: Id,
  state: AgentState,
  currentActivity: z.string().optional(),
  lastEventAt: Timestamp,
  pendingQuestionId: Id.optional(),
  progress: Progress.optional(),
  costSoFar: Cost.optional(),
  caps: z.object({ wallClockMs: CapUsage, toolCalls: CapUsage }),
});
export type StatusRecord = z.infer<typeof StatusRecord>;

/** Per-project permission policy (SPEC §3.6, decision 7). Missing actions fall back to the default policy. */
export const PermissionPolicy = z.object({
  rules: z.partialRecord(PermissionAction, PermissionDecision),
});
export type PermissionPolicy = z.infer<typeof PermissionPolicy>;

export const DEFAULT_PERMISSION_POLICY: PermissionPolicy = {
  rules: {
    read_workspace: 'allow',
    edit_workspace: 'allow',
    run_workspace: 'allow',
    destructive: 'ask',
    outside_workspace: 'ask',
    network: 'ask',
    push: 'ask',
  },
};

/** One batch-written piece of an agent's transcript (TECHNOLOGY §6.2), redacted before it is stored. */
export const TranscriptChunk = z.object({
  agentId: Id,
  /** Per-agent, strictly increasing; the transcript stream is resumed from it. */
  seq: z.number().int().positive(),
  at: Timestamp,
  kind: z.enum(['text', 'tool', 'thinking']),
  text: z.string(),
});
export type TranscriptChunk = z.infer<typeof TranscriptChunk>;
