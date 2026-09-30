import type {
  Actor,
  Agent,
  AgentCaps,
  Body,
  Host,
  PermissionPolicy,
  Project,
  ProposedBody,
  Proposal,
  Question,
  QuestionContext,
  Task,
} from './domain.js';
import type {
  AgentRole,
  AgentRuntime,
  BodyKind,
  QuestionKind,
  TaskPriority,
  WorkState,
} from './enums.js';
import type { AgentEvent, ControlTarget, Event } from './events.js';
import type { Id } from './primitives.js';

// ---------------------------------------------------------------------------
// Command inputs. Ids and timestamps are assigned by the server, never by the caller.
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  name: string;
  workspace: string;
  repoPath?: string;
  parentProjectId?: Id;
  /** The body to host it on; the server picks a free one of `kind` when absent. */
  bodyId?: Id;
  kind?: Exclude<BodyKind, 'asteroid'>;
  permissionPolicy?: PermissionPolicy;
}

export interface CreateTaskInput {
  description: string;
  priority?: TaskPriority;
  /** Absent for a standalone task, which gets a fresh asteroid. */
  projectId?: Id;
  blockedBy?: Id[];
}

export interface SpawnAgentInput {
  role: AgentRole;
  runtime: AgentRuntime;
  supervisorId?: Id;
  taskId?: Id;
  projectId?: Id;
  prompt: string;
  caps?: Partial<AgentCaps>;
  bare?: boolean;
}

export interface CreateProposalInput {
  requestText: string;
  kind: BodyKind;
  proposedBody: ProposedBody;
  workspace: string;
  rationale: string;
}

export type ProposalDecision =
  | { decision: 'approve' }
  | { decision: 'edit'; changes: Partial<Pick<Proposal, 'kind' | 'proposedBody' | 'workspace'>> }
  | { decision: 'reject'; reason?: string }
  | { decision: 'park'; reason: string };

export interface OpenQuestionInput {
  kind: QuestionKind;
  originAgentId: Id;
  context: QuestionContext;
}

export interface AnswerQuestionInput {
  questionId: Id;
  answer: string;
  by: Actor;
  /** The version the answerer saw; a stale answer is refused with "already answered by …". */
  version?: number;
}

export type ControlAction =
  | { action: 'stop' }
  | { action: 'cancel' }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'edit'; changes: Record<string, unknown> }
  | { action: 'close' }
  | { action: 'archive' }
  | { action: 'pin'; pinned: boolean }
  | { action: 'reopen' };

/** What every command returns: the affected aggregate plus the events it appended. */
export interface CommandResult<T> {
  value: T;
  events: Event[];
}

/**
 * The command surface that brain tools and panel actions call (TECHNOLOGY §5). Every command
 * runs under the one write rule (§6.1): domain mutation + event insert in one transaction.
 * Phase 0 defines it; Phase 2 implements it.
 */
export interface DomainCommands {
  // projects and tasks
  createProject(input: CreateProjectInput): Promise<CommandResult<Project>>;
  updateProject(
    projectId: Id,
    changes: Partial<Omit<Project, 'id' | 'createdAt' | 'updatedAt' | 'state'>>,
  ): Promise<CommandResult<Project>>;
  setProjectState(projectId: Id, state: WorkState): Promise<CommandResult<Project>>;
  closeProject(projectId: Id, by: Actor): Promise<CommandResult<Project>>;
  createTask(input: CreateTaskInput): Promise<CommandResult<Task>>;
  updateTask(
    taskId: Id,
    changes: Partial<Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'state'>>,
  ): Promise<CommandResult<Task>>;
  setTaskState(taskId: Id, state: WorkState): Promise<CommandResult<Task>>;
  closeTask(taskId: Id, by: Actor): Promise<CommandResult<Task>>;

  // bodies (SPEC §3)
  assignBody(bodyId: Id, host: Host): Promise<CommandResult<Body>>;
  moveHost(host: Host, toBodyId: Id): Promise<CommandResult<Body>>;
  freeBody(bodyId: Id): Promise<CommandResult<Body>>;

  // agents
  spawnAgent(input: SpawnAgentInput): Promise<CommandResult<Agent>>;
  stopAgent(agentId: Id, by: Actor): Promise<CommandResult<Agent>>;
  pauseAgent(agentId: Id, by: Actor): Promise<CommandResult<Agent>>;
  resumeAgent(agentId: Id, by: Actor): Promise<CommandResult<Agent>>;
  /** Folds a normalised adapter event into the domain (status store, question creation, …). */
  recordAgentEvent(event: AgentEvent): Promise<CommandResult<void>>;

  // proposals (SPEC §3.3)
  createProposal(input: CreateProposalInput): Promise<CommandResult<Proposal>>;
  decideProposal(
    proposalId: Id,
    decision: ProposalDecision,
    by: Actor,
  ): Promise<CommandResult<Proposal>>;

  // questions (SPEC §2.6)
  openQuestion(input: OpenQuestionInput): Promise<CommandResult<Question>>;
  answerQuestion(input: AnswerQuestionInput): Promise<CommandResult<Question>>;
  escalateQuestion(questionId: Id, by: Actor): Promise<CommandResult<Question>>;
  reassignQuestion(questionId: Id, to: Actor, reason: string): Promise<CommandResult<Question>>;

  // panel actions (SPEC decision 11b)
  control(target: ControlTarget, action: ControlAction, by: Actor): Promise<CommandResult<void>>;
}
