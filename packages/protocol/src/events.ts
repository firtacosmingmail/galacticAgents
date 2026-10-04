import { z } from 'zod';
import { Id, Timestamp } from './primitives.js';
import {
  AgentRole,
  AgentRuntime,
  PermissionAction,
  QuestionKind,
  RequestOrigin,
  WorkState,
} from './enums.js';
import {
  Actor,
  Agent,
  Body,
  Cost,
  Host,
  PermissionPolicy,
  Progress,
  Project,
  PromotionOutcome,
  Proposal,
  ProposalParking,
  ProposedBody,
  Question,
  QuestionContext,
  Task,
  ToolCall,
  TrustLevel,
} from './domain.js';

// ---------------------------------------------------------------------------
// agent.* — emitted by adapters, normalised (TECHNOLOGY §3.4)
// ---------------------------------------------------------------------------

const agentBase = { agentId: Id };

/**
 * The agent row exists (TECHNOLOGY §6.2: every mutation is fully described by its events, so a
 * replaying client can build the same `agents` table as a snapshotting one). Emitted by the
 * command that creates the row, before `agent.spawned`.
 */
export const AgentCreated = z.object({ type: z.literal('agent.created'), agent: Agent });

/**
 * The agent row's placement changed (P2-01): a new supervisor (an orphaned Steward re-parented),
 * a new body (a promoted task's satellite flies), a task or project handed over. Emitted by the
 * domain command, never by an adapter.
 */
export const AgentUpdated = z.object({
  type: z.literal('agent.updated'),
  agentId: Id,
  changes: Agent.pick({ supervisorId: true, bodyId: true, taskId: true, projectId: true })
    .partial()
    .refine((c) => Object.keys(c).length > 0, { message: 'an update changes something' }),
});

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
  /**
   * A reopened brain's first prompt folded the log up to this seq (P2-16): once that session's
   * first turn ends (`agent.idle`), a later requeue cuts here.
   */
  foldedUpTo: z.number().int().nonnegative().optional(),
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

/**
 * The agent is blocked on a question. A permission question carries the tool call and the
 * policy action it maps to, so the policy engine (P1-10) can decide without asking the LLM.
 */
export const AgentNeedsInput = z.object({
  type: z.literal('agent.needs_input'),
  ...agentBase,
  questionId: Id,
  kind: QuestionKind,
  question: QuestionContext,
});

export const AgentProgress = z.object({
  type: z.literal('agent.progress'),
  ...agentBase,
  summary: z.string(),
  progress: Progress.optional(),
});

/** A turn ended and the agent waits for its next message. Runtimes that meter per turn report the running cost here. */
export const AgentIdle = z.object({
  type: z.literal('agent.idle'),
  ...agentBase,
  cost: Cost.optional(),
});
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

/**
 * The server lost the session without the agent ending (a graceful shutdown, a crash of the
 * server itself found at the next start). Emitted by the runtime, never by an adapter; the
 * resume path (SPEC decision 8) respawns the agent from its `sessionRef` where the runtime can.
 */
export const AgentInterrupted = z.object({
  type: z.literal('agent.interrupted'),
  ...agentBase,
  reason: z.string(),
  /** Ids of `message.sent` messages still queued at the interruption (known on a clean shutdown). */
  pending: z.array(Id).optional(),
});

/**
 * Startup recovery left this agent interrupted (P25-01; SPEC §4.5, decision 46): it was not
 * resumed (one Harmonizer at a time), its resume failed, or a resumed session was lost before its
 * first turn and no fresh session could replace it. The work waits for the user's "Resume
 * session"; this is what the "work interrupted by a restart" notification keys on — never on
 * `agent.interrupted` itself, which every graceful shutdown and session reset logs too. Logged at
 * most once per interruption (until the agent is spawned again). Emitted by the runtime only.
 */
export const RecoveryNeedsAttention = z.object({
  type: z.literal('recovery.needs_attention'),
  agentId: Id,
  reason: z.string(),
});

/**
 * The server stopped processes attributed to a Steward (P4-14; SPEC decision 53): leftovers its
 * supervisor (a Waykeeper, or the Harmonizer for an asteroid task) or the user stopped, or the
 * server's safety-net sweep when the Steward ended (`sweep: 'agent_ended'`) or its task closed
 * (`sweep: 'task_closed'`). `commands` are the processes' command lines, clipped and redacted, in
 * the order of `pids`; `forced` the pids that needed SIGKILL after SIGTERM. Logged only when
 * something was stopped. Emitted by the server, never by an adapter.
 */
export const AgentProcessesStopped = z.object({
  type: z.literal('agent.processes_stopped'),
  agentId: Id,
  pids: z.array(z.number().int().positive()).min(1),
  commands: z.array(z.string()),
  forced: z.array(z.number().int().positive()).optional(),
  by: Actor,
  sweep: z.enum(['agent_ended', 'task_closed']).optional(),
});

/** Everything an adapter (or the runtime, for `agent.spawned`) may emit about a running agent. */
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
  AgentInterrupted,
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

// ---------------------------------------------------------------------------
// message.* — what the user, a supervisor or the system sends to an agent (P1-22)
// ---------------------------------------------------------------------------

/**
 * A message queued for an agent by the runtime's inbox: the user's chat line to a brain, a
 * supervisor's instruction to a Steward, a system notice. Logged so a restart can re-deliver
 * what was still queued (P1-14) and so a brain's mailbox (Phase 2) is fed from the log like
 * everything else. Delivery is not a separate event: the next `agent.*` events of the agent
 * are its trace.
 */
export const MessageSent = z.object({
  type: z.literal('message.sent'),
  messageId: Id,
  agentId: Id,
  sender: Actor,
  text: z.string(),
  /** Asked to cancel the current turn and go first. */
  interrupt: z.boolean(),
  /**
   * Where a user's message came from (P2-21): what a brain passes to the policy-writing commands
   * it calls for this message. Absent for agents' and system messages, and unknown counts as
   * remote.
   */
  origin: RequestOrigin.optional(),
  /**
   * A brain's turn prompt (P25-03): the runner's digest of what happened since its last turn,
   * sent by the system. Logged like any message, but not a line of the conversation (decision
   * 54): the panel's chat and `GET /api/agents/:id/conversation` leave it out.
   */
  turn: z.literal(true).optional(),
});

/**
 * The adapter accepted a queued message (P1-33): the agent has it in its session. What a restart
 * redelivers is exactly the `message.sent` messages without a `message.delivered`.
 */
export const MessageDelivered = z.object({
  type: z.literal('message.delivered'),
  messageId: Id,
  agentId: Id,
});

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
  /**
   * Every agent that held the question, past and present, oldest first (P2-03): their mailboxes
   * learn it was answered and stop waiting. Absent when no agent ever held it.
   */
  holders: z.array(Id).optional(),
});
/**
 * The question can no longer be answered (P1-34): its agent ended or was interrupted, or an
 * interrupt withdrew it (the agent went idle without an answer). A resumed agent re-asks under a
 * new id.
 */
export const QuestionCancelled = z.object({
  type: z.literal('question.cancelled'),
  questionId: Id,
  agentId: Id,
  reason: z.string(),
  version: z.number().int().nonnegative(),
  /** Every agent that held the question, past and present (as on `question.answered`). */
  holders: z.array(Id).optional(),
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
// permission.* (SPEC §3.6, decision 7; P2-04)
// ---------------------------------------------------------------------------

/**
 * The project's policy table decided a tool call without the user (P2-04): `allow` answered a
 * permission request at once, `deny` refused it (or the gate refused the call before any request
 * existed). `questionId` is the adapter's request the decision answered; absent when the gate
 * refused the call outright. No question row is ever opened for it. `decidedBy` is always the
 * system: an LLM never decides a permission.
 */
export const PermissionDecided = z.object({
  type: z.literal('permission.decided'),
  agentId: Id,
  questionId: Id.optional(),
  toolCall: ToolCall,
  decision: z.enum(['allow', 'deny']),
  /** The category that produced the decision, when one was recognised. */
  action: PermissionAction.optional(),
  /** Why, for a denial (the policy line, a check failure). */
  reason: z.string().optional(),
  decidedBy: Actor,
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
  changes: Proposal.pick({ kind: true, proposedBody: true, workspace: true })
    .extend({
      /** The user's consent to `git init` an existing non-git workspace (decision 27): `meta.initGit`. */
      initGit: z.boolean().optional(),
      /** The trust level the user chose for the project (decision 49): `meta.trust`. */
      trust: TrustLevel.optional(),
    })
    .partial(),
});
export const ProposalRejected = z.object({
  type: z.literal('proposal.rejected'),
  proposalId: Id,
  reason: z.string().optional(),
});
/**
 * Parked (decision 16). A card the server parked for lack of room also carries what the card
 * shows (`ProposalParking`: the body kind it waits for, the occupied bodies, the offers); the
 * parking is kept in `meta.parked` until the next decision.
 */
export const ProposalParked = z.object({
  type: z.literal('proposal.parked'),
  proposalId: Id,
  reason: z.string(),
  waitingFor: ProposalParking.shape.waitingFor,
  occupied: ProposalParking.shape.occupied,
  offers: ProposalParking.shape.offers,
});
/**
 * A card parked for lack of room is pending again (P2-09): a body of its kind freed. It now
 * proposes `proposedBody` (the catalogue's choice) and loses `meta.parked`; the user decides it.
 */
export const ProposalUnparked = z.object({
  type: z.literal('proposal.unparked'),
  proposalId: Id,
  proposedBody: ProposedBody,
  reason: z.string(),
});

/**
 * An approved promotion card was carried out by the server (P2-12; SPEC §3.4): the work moved,
 * its Waykeeper runs, its Stewards were handed over — or, with `ok: false`, why not. The card
 * keeps the outcome as `meta.carriedOut`; the brain that owns the card is woken to report it.
 */
export const PromotionCarriedOut = z.object({
  type: z.literal('promotion.carried_out'),
  proposalId: Id,
  outcome: PromotionOutcome,
});

// ---------------------------------------------------------------------------
// body.* (SPEC §3.4, decision 9)
// ---------------------------------------------------------------------------

/** A body that did not exist in the catalogue before: a procedural asteroid, a task's body. */
export const BodyCreated = z.object({ type: z.literal('body.created'), body: Body });
export const BodyAssigned = z.object({ type: z.literal('body.assigned'), bodyId: Id, host: Host });
/**
 * Work moved from one body to another (SPEC §3.4; its satellite flies). `toBodyId` hosts `host`
 * from now on — unless `intoProjectId` is set: a standalone task joined that project and lives on
 * its body, whose host does not change (decision 9). Either way the old body loses its host and
 * shows the "moved to …" marker (`Body.movedTo`, stamped with the event's `at`) until it is freed.
 */
export const BodyMoved = z.object({
  type: z.literal('body.moved'),
  host: Host,
  fromBodyId: Id,
  toBodyId: Id,
  intoProjectId: Id.optional(),
});
/** The body is free again: no host, no "moved to …" marker. */
export const BodyFreed = z.object({ type: z.literal('body.freed'), bodyId: Id });

// ---------------------------------------------------------------------------
// project.* and task.*
// ---------------------------------------------------------------------------

export const ProjectCreated = z.object({ type: z.literal('project.created'), project: Project });
/**
 * What `project.updated` / `task.updated` may change (P2-20; TECHNOLOGY §6.2). A key that is
 * absent (or `undefined`) is unchanged; an explicit `null` clears an optional field — detaching a
 * sub-project (`parentProjectId`), dropping the policy, forgetting a merged task's worktree. Only
 * the fields listed here are clearable; the server's commands and the web reducer fold the same
 * changes with `applyChanges`, so replaying the log rebuilds the server's rows.
 */
export const ProjectChanges = Project.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  state: true,
})
  .extend({
    repoPath: z.string().nullable(),
    parentProjectId: Id.nullable(),
    permissionPolicy: PermissionPolicy.nullable(),
  })
  .partial();
export type ProjectChanges = z.infer<typeof ProjectChanges>;

export const TaskChanges = Task.omit({ id: true, createdAt: true, updatedAt: true, state: true })
  .extend({ worktreePath: z.string().nullable(), branch: z.string().nullable() })
  .partial();
export type TaskChanges = z.infer<typeof TaskChanges>;

/** The fields an explicit `null` clears, per row kind (everything else must not be `null`). */
export const CLEARABLE_PROJECT_FIELDS = [
  'repoPath',
  'parentProjectId',
  'permissionPolicy',
] as const;
export const CLEARABLE_TASK_FIELDS = ['worktreePath', 'branch'] as const;

/**
 * Folds `changes` into `current` (P2-20): `undefined` leaves a field unchanged, `null` removes it,
 * anything else replaces it. Pure; the one patch rule the server and the client share.
 */
export function applyChanges<T extends object>(
  current: T,
  changes: { readonly [key: string]: unknown },
): T {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as T;
}

export const ProjectUpdated = z.object({
  type: z.literal('project.updated'),
  projectId: Id,
  changes: ProjectChanges,
});
export const ProjectStateChanged = z.object({
  type: z.literal('project.state_changed'),
  projectId: Id,
  from: WorkState,
  to: WorkState /** Who asked for it; absent for a derived change (P2-15). */,
  by: Actor.optional(),
});

export const TaskCreated = z.object({ type: z.literal('task.created'), task: Task });
export const TaskUpdated = z.object({
  type: z.literal('task.updated'),
  taskId: Id,
  changes: TaskChanges,
});
export const TaskStateChanged = z.object({
  type: z.literal('task.state_changed'),
  taskId: Id,
  from: WorkState,
  to: WorkState /** Who asked for it; absent for a derived change (P2-15). */,
  by: Actor.optional(),
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
  AgentCreated,
  AgentUpdated,
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
  AgentInterrupted,
  RecoveryNeedsAttention,
  AgentProcessesStopped,
  MessageSent,
  MessageDelivered,
  QuestionOpened,
  QuestionEscalated,
  QuestionAnswered,
  QuestionReassigned,
  QuestionCancelled,
  PermissionDecided,
  ProposalCreated,
  ProposalApproved,
  ProposalEdited,
  ProposalRejected,
  ProposalParked,
  ProposalUnparked,
  PromotionCarriedOut,
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
