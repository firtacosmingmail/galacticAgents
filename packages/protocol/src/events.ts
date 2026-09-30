import { z } from 'zod';
import { Id, Timestamp } from './primitives.js';
import { AgentRole, AgentRuntime, QuestionKind, WorkState } from './enums.js';
import { Actor, Body, Cost, Host, Progress, Project, Proposal, Question, Task } from './domain.js';

// ---------------------------------------------------------------------------
// agent.* — emitted by adapters, normalised (TECHNOLOGY §3.4)
// ---------------------------------------------------------------------------

const agentBase = { agentId: Id };

export const AgentSpawned = z.object({
  type: z.literal('agent.spawned'),
  ...agentBase,
  role: AgentRole,
  runtime: AgentRuntime,
  sessionRef: z.string().optional(),
  bodyId: Id,
  supervisorId: Id.optional(),
  taskId: Id.optional(),
  projectId: Id.optional(),
});

/** Transcript traffic. Routed to `transcript_chunks`, never persisted in `events` (TECHNOLOGY §6.2). */
export const AgentOutput = z.object({
  type: z.literal('agent.output'),
  ...agentBase,
  kind: z.enum(['text', 'tool', 'thinking']),
  text: z.string(),
});

export const AgentToolCall = z.object({
  type: z.literal('agent.tool_call'),
  ...agentBase,
  toolName: z.string(),
  toolUseId: z.string().optional(),
  input: z.unknown().optional(),
});

export const AgentNeedsInput = z.object({
  type: z.literal('agent.needs_input'),
  ...agentBase,
  questionId: Id,
  question: z.object({
    kind: QuestionKind,
    text: z.string(),
    options: z.array(z.string()).optional(),
  }),
});

export const AgentProgress = z.object({
  type: z.literal('agent.progress'),
  ...agentBase,
  summary: z.string(),
  progress: Progress.optional(),
});

export const AgentIdle = z.object({ type: z.literal('agent.idle'), ...agentBase });
export const AgentStalled = z.object({
  type: z.literal('agent.stalled'),
  ...agentBase,
  silentForMs: z.number().int().nonnegative(),
});
export const AgentPaused = z.object({ type: z.literal('agent.paused'), ...agentBase, by: Actor });
export const AgentResumed = z.object({ type: z.literal('agent.resumed'), ...agentBase, by: Actor });

export const AgentFinished = z.object({
  type: z.literal('agent.finished'),
  ...agentBase,
  result: z.string().optional(),
  cost: Cost.optional(),
});

export const AgentFailed = z.object({
  type: z.literal('agent.failed'),
  ...agentBase,
  error: z.string(),
  reason: z.enum(['cap', 'crash', 'runtime', 'unknown']),
  cost: Cost.optional(),
});

export const AgentStopped = z.object({ type: z.literal('agent.stopped'), ...agentBase, by: Actor });

/** Everything an adapter may emit. */
export const AgentEvent = z.discriminatedUnion('type', [
  AgentSpawned,
  AgentOutput,
  AgentToolCall,
  AgentNeedsInput,
  AgentProgress,
  AgentIdle,
  AgentStalled,
  AgentPaused,
  AgentResumed,
  AgentFinished,
  AgentFailed,
  AgentStopped,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

// ---------------------------------------------------------------------------
// question.* (SPEC §2.6, TECHNOLOGY §5.3)
// ---------------------------------------------------------------------------

export const QuestionOpened = z.object({ type: z.literal('question.opened'), question: Question });
export const QuestionEscalated = z.object({
  type: z.literal('question.escalated'),
  questionId: Id,
  from: Actor,
  to: Actor,
  version: z.number().int().nonnegative(),
});
export const QuestionAnswered = z.object({
  type: z.literal('question.answered'),
  questionId: Id,
  answer: z.string(),
  answeredBy: Actor,
  version: z.number().int().nonnegative(),
});
/** Holder changed without an escalation, e.g. the holder died (orphaned question). */
export const QuestionReassigned = z.object({
  type: z.literal('question.reassigned'),
  questionId: Id,
  from: Actor,
  to: Actor,
  reason: z.string(),
  version: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// proposal.* (SPEC §3.3, decision 16)
// ---------------------------------------------------------------------------

export const ProposalCreated = z.object({
  type: z.literal('proposal.created'),
  proposal: Proposal,
});
export const ProposalApproved = z.object({ type: z.literal('proposal.approved'), proposalId: Id });
export const ProposalEdited = z.object({
  type: z.literal('proposal.edited'),
  proposalId: Id,
  changes: Proposal.pick({ kind: true, proposedBody: true, workspace: true }).partial(),
});
export const ProposalRejected = z.object({
  type: z.literal('proposal.rejected'),
  proposalId: Id,
  reason: z.string().optional(),
});
export const ProposalParked = z.object({
  type: z.literal('proposal.parked'),
  proposalId: Id,
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// body.* (SPEC §3.4, decision 9)
// ---------------------------------------------------------------------------

/** A body that did not exist in the catalogue before: a procedural asteroid, a task's body. */
export const BodyCreated = z.object({ type: z.literal('body.created'), body: Body });
export const BodyAssigned = z.object({ type: z.literal('body.assigned'), bodyId: Id, host: Host });
export const BodyMoved = z.object({
  type: z.literal('body.moved'),
  host: Host,
  fromBodyId: Id,
  toBodyId: Id,
});
export const BodyFreed = z.object({ type: z.literal('body.freed'), bodyId: Id });

// ---------------------------------------------------------------------------
// project.* and task.*
// ---------------------------------------------------------------------------

export const ProjectCreated = z.object({ type: z.literal('project.created'), project: Project });
export const ProjectUpdated = z.object({
  type: z.literal('project.updated'),
  projectId: Id,
  changes: Project.omit({ id: true, createdAt: true, updatedAt: true, state: true }).partial(),
});
export const ProjectStateChanged = z.object({
  type: z.literal('project.state_changed'),
  projectId: Id,
  from: WorkState,
  to: WorkState,
});

export const TaskCreated = z.object({ type: z.literal('task.created'), task: Task });
export const TaskUpdated = z.object({
  type: z.literal('task.updated'),
  taskId: Id,
  changes: Task.omit({ id: true, createdAt: true, updatedAt: true, state: true }).partial(),
});
export const TaskStateChanged = z.object({
  type: z.literal('task.state_changed'),
  taskId: Id,
  from: WorkState,
  to: WorkState,
});

// ---------------------------------------------------------------------------
// control.* — panel actions recorded as events so supervisors adjust (decision 11b)
// ---------------------------------------------------------------------------

export const ControlTarget = z.object({ kind: z.enum(['agent', 'task', 'project']), id: Id });
export type ControlTarget = z.infer<typeof ControlTarget>;

const controlBase = { target: ControlTarget, by: Actor };

export const ControlStop = z.object({ type: z.literal('control.stop'), ...controlBase });
export const ControlCancel = z.object({ type: z.literal('control.cancel'), ...controlBase });
export const ControlPause = z.object({ type: z.literal('control.pause'), ...controlBase });
export const ControlResume = z.object({ type: z.literal('control.resume'), ...controlBase });
export const ControlEdit = z.object({
  type: z.literal('control.edit'),
  ...controlBase,
  changes: z.record(z.string(), z.unknown()),
});
export const ControlClose = z.object({ type: z.literal('control.close'), ...controlBase });
export const ControlArchive = z.object({ type: z.literal('control.archive'), ...controlBase });
export const ControlPin = z.object({
  type: z.literal('control.pin'),
  ...controlBase,
  pinned: z.boolean(),
});
export const ControlReopen = z.object({ type: z.literal('control.reopen'), ...controlBase });

// ---------------------------------------------------------------------------
// The union, the envelope
// ---------------------------------------------------------------------------

/** Every event that can appear in the `events` log and on the WebSocket stream. */
export const Event = z.discriminatedUnion('type', [
  AgentSpawned,
  AgentOutput,
  AgentToolCall,
  AgentNeedsInput,
  AgentProgress,
  AgentIdle,
  AgentStalled,
  AgentPaused,
  AgentResumed,
  AgentFinished,
  AgentFailed,
  AgentStopped,
  QuestionOpened,
  QuestionEscalated,
  QuestionAnswered,
  QuestionReassigned,
  ProposalCreated,
  ProposalApproved,
  ProposalEdited,
  ProposalRejected,
  ProposalParked,
  BodyCreated,
  BodyAssigned,
  BodyMoved,
  BodyFreed,
  ProjectCreated,
  ProjectUpdated,
  ProjectStateChanged,
  TaskCreated,
  TaskUpdated,
  TaskStateChanged,
  ControlStop,
  ControlCancel,
  ControlPause,
  ControlResume,
  ControlEdit,
  ControlClose,
  ControlArchive,
  ControlPin,
  ControlReopen,
]);
export type Event = z.infer<typeof Event>;
export type EventType = Event['type'];
export type EventOfType<T extends EventType> = Extract<Event, { type: T }>;

/** All event type names, in union order. Handy for exhaustiveness tests. */
export const EVENT_TYPES = Event.options.map((o) => o.shape.type.value) as readonly EventType[];

/** What the log stores and the stream carries: server-assigned `seq` (= events.rowid) and time. */
export const EventEnvelope = z.object({
  seq: z.number().int().positive(),
  at: Timestamp,
  event: Event,
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** `agent.output` never enters the `events` table; it goes to transcript_chunks. */
export const isTranscriptEvent = (e: Event): e is z.infer<typeof AgentOutput> =>
  e.type === 'agent.output';

/** A helper to type-check exhaustive switches. */
export function assertNever(x: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(x)}`);
}
