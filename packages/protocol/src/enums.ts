import { z } from 'zod';

/** Celestial bodies that host work (SPEC §3.1). */
export const BodyKind = z.enum(['planet', 'moon', 'asteroid']);
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

export const QuestionStatus = z.enum(['open', 'answered']);
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
