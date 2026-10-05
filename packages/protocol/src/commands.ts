import type {
  Actor,
  Agent,
  AgentCaps,
  Body,
  BodyOccupancy,
  BudgetTarget,
  Host,
  PermissionPolicy,
  Project,
  ProposedBody,
  Proposal,
  Question,
  QuestionContext,
  Task,
  TrustLevel,
} from './domain.js';
import type {
  AgentRole,
  AgentRuntime,
  WorkBodyKind,
  QuestionKind,
  RequestOrigin,
  TaskPriority,
  WorkState,
} from './enums.js';
import type { AgentEvent, ControlTarget, Event, ProjectChanges, TaskChanges } from './events.js';
import type { ToolDefinition } from './adapter.js';
import type { Id, Meta } from './primitives.js';

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
  kind?: Exclude<WorkBodyKind, 'asteroid'>;
  permissionPolicy?: PermissionPolicy;
  /** Default `approved`: a project is created when its proposal is approved (decision 3). */
  state?: Extract<WorkState, 'proposed' | 'approved'>;
  /** Stored as the row's `meta` (e.g. the Harmonizer's `proposalId`, P2-08). */
  meta?: Meta;
}

export interface CreateTaskInput {
  description: string;
  priority?: TaskPriority;
  /** Absent for a standalone task, which gets a fresh asteroid. */
  projectId?: Id;
  blockedBy?: Id[];
  /** Standalone tasks only: a free asteroid to use instead of a fresh one. */
  bodyId?: Id;
  /** Default `approved`; a Waykeeper's plan creates its tasks `proposed` until the card is approved. */
  state?: Extract<WorkState, 'proposed' | 'approved'>;
  /** Stored as the row's `meta` (e.g. the Harmonizer's `proposalId` and a standalone task's workspace, P2-08). */
  meta?: Meta;
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
  /** Brains: their tools and system prompt (TECHNOLOGY §5.1). */
  tools?: ToolDefinition[];
  systemPrompt?: string;
  /**
   * Working directory of an agent outside any project: the Harmonizer, or the Steward of a
   * standalone task (SPEC §3.5). An agent of a project runs in its task's worktree or the
   * project's workspace and may not override it (decision 24).
   */
  cwd?: string;
}

/** Where an agent sits in the hierarchy; what `updateAgent` may change. */
export type AgentPlacement = Partial<
  Pick<Agent, 'supervisorId' | 'bodyId' | 'taskId' | 'projectId'>
>;

/**
 * What a new project needs a body for (P2-02, decision 10): a planet, or a moon — of its parent
 * project's planet for a sub-project, else preferably of a planet without a Waykeeper.
 */
export type BodyRequest = { kind: 'planet' } | { kind: 'moon'; parentProjectId?: Id };

/**
 * The catalogue's answer to a `BodyRequest`: a free body, or why there is none. "No free planet"
 * lists every occupied planet and its occupant (decision 16: the refusal offers downsizing or
 * closing a completed project early, and the proposal is parked). "No free moon" for a
 * sub-project means it stays a task on the planet (SPEC §3.2).
 */
export type BodyChoice =
  | { ok: true; body: Body }
  | { ok: false; reason: 'no_free_planet'; occupied: BodyOccupancy[] }
  | { ok: false; reason: 'no_free_moon'; planetId?: Id; occupied: BodyOccupancy[] };

/** Reopening finished work (decision 11b): the old body if it is still free, else `bodyId`. */
export interface ReopenInput {
  bodyId?: Id;
}

export interface CreateProposalInput {
  requestText: string;
  kind: WorkBodyKind;
  proposedBody: ProposedBody;
  workspace: string;
  rationale: string;
  /** Speculative card data (a promotion request's task, …); a plan card is made by `proposePlan`. */
  meta?: Meta;
}

/** One task of a Waykeeper's plan (P2-10). */
export interface PlanTaskInput {
  description: string;
  priority?: TaskPriority;
  /** Earlier tasks of the same plan (0-based positions) or existing task ids. */
  blockedBy?: (number | Id)[];
}

/**
 * A Waykeeper's task plan (P2-10; SPEC §3.3): its tasks are created `proposed` and the plan card
 * (a proposal carrying `meta.plan`) is created with them, in one transaction.
 */
export interface ProposePlanInput {
  projectId: Id;
  /** The Waykeeper presenting the plan. */
  waykeeperId: Id;
  /** What the plan does, one or two lines: the card's text. */
  summary: string;
  rationale?: string;
  tasks: PlanTaskInput[];
}

export type ProposalDecision =
  | { decision: 'approve' }
  | {
      decision: 'edit';
      /**
       * `initGit`: the user's consent to `git init` an existing non-git workspace (decision 27);
       * `trust`: the trust level of the project the card creates (decision 49). Both the user's only.
       */
      changes: Partial<
        Pick<Proposal, 'kind' | 'proposedBody' | 'workspace'> & {
          initGit: boolean;
          trust: TrustLevel;
          /** The work's dollar budget (P8-01): `meta.budgetUsd`, applied on approval; `null` drops it. */
          budgetUsd: number | null;
        }
      >;
    }
  | { decision: 'reject'; reason?: string }
  | { decision: 'park'; reason: string };

export interface OpenQuestionInput {
  kind: QuestionKind;
  originAgentId: Id;
  context: QuestionContext;
  /**
   * A clarification only the user may answer (a Waykeeper's merge conflict with external
   * changes, SPEC decision 30): held by the user from the start, never by a supervisor, and its
   * supervisors' mailboxes are not woken by it. Refused for a permission question (already the
   * user's).
   */
  toUser?: boolean;
}

export interface AnswerQuestionInput {
  questionId: Id;
  answer: string;
  by: Actor;
  /** The version the answerer saw; a stale answer is refused with "already answered by …". */
  version?: number;
  /**
   * Idempotency key (P7-05): an answer already recorded under this key is a success that changes
   * nothing (`events: []`), whatever `version` says; a retry while the first copy is still being
   * handed to the agent waits for it.
   */
  answerId?: string;
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

/**
 * Who a write is for (P2-21): the origin of the request that caused it. Policy-writing commands
 * (`createProject`, `updateProject`, `control` edit) floor a `permissionPolicy` at the global
 * default unless `origin` is `local` or the server sets `autoApproveRemote`: an unknown origin
 * counts as remote. A brain passes the origin of the user message it acts on (`message.sent`).
 */
export interface WriteOptions {
  origin?: RequestOrigin | undefined;
}

/** `control`'s options: the write's origin, and a confirmation it uses up (P5-07). */
export interface ControlOptions extends WriteOptions {
  /**
   * The `ask_confirmation` question whose answer allows this stop or cancel (decision 83): marked
   * used on the question row (`meta.usedFor`) in the control's own transaction, so one answer
   * allows one control — a second use is refused, and a refused control leaves it unused.
   */
  confirmation?: Id | undefined;
}

/** What every command returns: the affected aggregate plus the events it appended. */
export interface CommandResult<T> {
  value: T;
  events: Event[];
}

/**
 * The command surface that brain tools and panel actions call (TECHNOLOGY §5). Every command
 * runs under the one write rule (§6.1): domain mutation + event insert in one transaction.
 * Phase 0 defined it; P2-01 implements it (`apps/server/src/domain/commands.ts`). A command that
 * is refused (unknown id, invalid transition, stale answer, …) rejects with a `DomainError`
 * and writes nothing.
 */
export interface DomainCommands {
  // projects and tasks
  /** A `permissionPolicy` is floored unless `write.origin` is `local` (P2-21). */
  createProject(input: CreateProjectInput, write?: WriteOptions): Promise<CommandResult<Project>>;
  /**
   * `null` clears a clearable field (`ProjectChanges`, P2-20); a `permissionPolicy` is floored
   * unless `write.origin` is `local` (P2-21).
   */
  updateProject(
    projectId: Id,
    changes: ProjectChanges,
    write?: WriteOptions,
  ): Promise<CommandResult<Project>>;
  setProjectState(projectId: Id, state: WorkState): Promise<CommandResult<Project>>;
  closeProject(projectId: Id, by: Actor): Promise<CommandResult<Project>>;
  archiveProject(projectId: Id, by: Actor): Promise<CommandResult<Project>>;
  pinProject(projectId: Id, pinned: boolean): Promise<CommandResult<Project>>;
  reopenProject(projectId: Id, by: Actor, input?: ReopenInput): Promise<CommandResult<Project>>;
  createTask(input: CreateTaskInput): Promise<CommandResult<Task>>;
  /** `null` clears a clearable field (`TaskChanges`, P2-20). */
  updateTask(taskId: Id, changes: TaskChanges): Promise<CommandResult<Task>>;
  setTaskState(taskId: Id, state: WorkState): Promise<CommandResult<Task>>;
  closeTask(taskId: Id, by: Actor): Promise<CommandResult<Task>>;
  archiveTask(taskId: Id, by: Actor): Promise<CommandResult<Task>>;
  pinTask(taskId: Id, pinned: boolean): Promise<CommandResult<Task>>;
  reopenTask(taskId: Id, by: Actor, input?: ReopenInput): Promise<CommandResult<Task>>;
  /** A standalone task joins a project and lives on its body from now on (decision 9). */
  moveTask(taskId: Id, toProjectId: Id, by: Actor): Promise<CommandResult<Task>>;

  // bodies (SPEC §3)
  assignBody(bodyId: Id, host: Host): Promise<CommandResult<Body>>;
  moveHost(host: Host, toBodyId: Id): Promise<CommandResult<Body>>;
  freeBody(bodyId: Id): Promise<CommandResult<Body>>;
  /** The free, unreserved planets in catalogue order (P2-02; deterministic, no judgement). */
  freePlanets(): Promise<Body[]>;
  /** The free, unreserved moons (of one planet, or all) in catalogue order. */
  freeMoons(planetId?: Id): Promise<Body[]>;
  /** Which body a new project would get under decision 10; changes nothing. */
  chooseBody(request: BodyRequest): Promise<BodyChoice>;

  // agents
  spawnAgent(input: SpawnAgentInput): Promise<CommandResult<Agent>>;
  updateAgent(agentId: Id, changes: AgentPlacement): Promise<CommandResult<Agent>>;
  stopAgent(agentId: Id, by: Actor): Promise<CommandResult<Agent>>;
  pauseAgent(agentId: Id, by: Actor): Promise<CommandResult<Agent>>;
  resumeAgent(agentId: Id, by: Actor): Promise<CommandResult<Agent>>;
  /** Folds a normalised adapter event into the domain (status store, question creation, …). */
  recordAgentEvent(event: AgentEvent): Promise<CommandResult<void>>;

  // proposals (SPEC §3.3)
  createProposal(input: CreateProposalInput): Promise<CommandResult<Proposal>>;
  /** A Waykeeper's plan card and its `proposed` tasks, in one transaction (P2-10). */
  proposePlan(
    input: ProposePlanInput,
  ): Promise<CommandResult<{ proposal: Proposal; tasks: Task[] }>>;
  /**
   * `write`: the request's origin (P2-21): the policy of the trust level an approval gives the
   * project it creates (decision 49) is floored unless `write.origin` is `local`.
   */
  decideProposal(
    proposalId: Id,
    decision: ProposalDecision,
    by: Actor,
    write?: WriteOptions,
  ): Promise<CommandResult<Proposal>>;

  // questions (SPEC §2.6)
  openQuestion(input: OpenQuestionInput): Promise<CommandResult<Question>>;
  answerQuestion(input: AnswerQuestionInput): Promise<CommandResult<Question>>;
  escalateQuestion(questionId: Id, by: Actor): Promise<CommandResult<Question>>;
  reassignQuestion(questionId: Id, to: Actor, reason: string): Promise<CommandResult<Question>>;
  /**
   * Withdraws an open clarification that no longer needs an answer (`question.cancelled` with
   * `reason`): an agent only its own, and never one a live session is blocked on (that one ends
   * with its agent). A question that is not open is returned unchanged.
   */
  withdrawQuestion(questionId: Id, reason: string, by: Actor): Promise<CommandResult<Question>>;

  // budgets (P8-01; SPEC decision 18)
  /**
   * Sets (`usd`), changes or removes (`null`) the dollar budget of a project or task: the row's
   * `budgetUsd` plus a `budget.set` event, in one transaction. Loosening it (raising or removing)
   * is refused for a remote or unknown `write.origin` unless the server sets `autoApproveRemote`
   * (proposed decision 97, like decision 37's floor); setting or lowering is allowed from anywhere.
   */
  setBudget(
    target: BudgetTarget,
    usd: number | null,
    by: Actor,
    write?: WriteOptions,
  ): Promise<CommandResult<Project | Task>>;

  // panel actions (SPEC decision 11b)
  /**
   * A project edit's `permissionPolicy` is floored unless `write.origin` is `local` (P2-21);
   * `write.confirmation` is used up in the same transaction (P5-07).
   */
  control(
    target: ControlTarget,
    action: ControlAction,
    by: Actor,
    write?: ControlOptions,
  ): Promise<CommandResult<void>>;
}
