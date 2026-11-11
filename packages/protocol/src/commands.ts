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
  Panel,
  PanelChanges,
  PanelDraft,
  PanelLayout,
  RunData,
  UsedSource,
} from './dashboard.js';
import type { StandingApproval } from './waykeeper-approvals.js';
import type { AgentLaunch, LaunchContext, LaunchFlag, LaunchRequest } from './launch-flags.js';
import type { Provider } from './providers.js';
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
import type {
  Deliverable,
  DeliverableCommand,
  DeliverableKind,
  DeliverableLocation,
  DeliverableSource,
} from './deliverables.js';
import type { Id, Meta } from './primitives.js';
import type { SetAnswer, SetQuestionInput } from './question-set.js';
import type {
  Area,
  FollowUp,
  Job,
  JobDraft,
  JobRun,
  JobRunOutcome,
  JobRunPurpose,
  JobState,
  ProposalPanel,
} from './long-term.js';

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
  /**
   * A long-term project (P10-01; SPEC decision 142): placed on a big planet (else a planet with
   * moons) and stored with its purpose and goals.
   */
  longTerm?: { purpose: string; goals: string[] };
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
  /** The AI provider, exact model and flags of the task (P11-02). */
  provider?: Provider;
  model?: string;
  publishes?: boolean;
  makesImages?: boolean;
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
  /** The exact model to run (P11-02); absent: the runtime's default. */
  model?: string;
  /** Approved launch flags (P12): a Steward only. */
  launchFlags?: LaunchFlag[];
  /** The approved launch record the server keeps in `meta.launch` (P12). */
  launch?: AgentLaunch;
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
 * project's planet for a sub-project, else preferably of a planet without a Waykeeper. A
 * long-term project's planet (`longTerm`, P10-02) is a big planet, else a planet with moons.
 */
export type BodyRequest =
  { kind: 'planet'; longTerm?: true } | { kind: 'moon'; parentProjectId?: Id };

/**
 * The catalogue's answer to a `BodyRequest`: a free body, or why there is none. "No free planet"
 * lists every occupied planet and its occupant (decision 16: the refusal offers downsizing or
 * closing a completed project early, and the proposal is parked). "No free moon" for a
 * sub-project means it stays a task on the planet (SPEC §3.2). "No planet with moons" refuses a
 * long-term project: no free planet has a moon for its areas (P10-02).
 */
export type BodyChoice =
  | { ok: true; body: Body }
  | { ok: false; reason: 'no_free_planet'; occupied: BodyOccupancy[] }
  | { ok: false; reason: 'no_planet_with_moons'; occupied: BodyOccupancy[] }
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
  /** The AI provider, exact model and flags of the task (P11-02). */
  provider?: Provider;
  model?: string;
  publishes?: boolean;
  makesImages?: boolean;
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
  | {
      decision: 'approve';
      /**
       * A job stop or change card (P15-03): also remove the dashboard panels the job no longer
       * fills (`affectedPanels`), as "job stopped" / "no longer reported".
       */
      removePanels?: true;
    }
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
  /**
   * The user answered by replying to the question in this brain's chat (P8-17): carried on
   * `question.answered.repliedIn`, so that brain learns it once, from the reply's message.
   */
  repliedIn?: Id;
  /**
   * The structured answer behind `answer` (P10-01), stored in `meta.answerDetail` as sets do: a
   * reply finding's edited text travels as `detail.text`.
   */
  detail?: SetAnswer;
}

/**
 * A dismissal (P9-14, SPEC decision 135): the user withdraws an open question without answering.
 * A clarification is cancelled and its asker told; a permission request is denied through its
 * adapter ("dismissed by the user") and cancelled — never allowed.
 */
export interface DismissQuestionInput {
  questionId: Id;
  by: Actor;
  /** The version the user saw; a question answered or moved since is refused as stale. */
  version?: number;
  /** Where the dismissal came from (decision 90), recorded on the event. */
  origin?: RequestOrigin;
}

/** A set of related clarifications asked at once (P8-19, SPEC decision 141). */
export interface OpenQuestionSetInput {
  originAgentId: Id;
  title: string;
  questions: SetQuestionInput[];
  /** Skip the supervisor chain and ask the user directly. */
  toUser?: boolean;
}

/** The user's (or a supervisor's) answers for a set, recorded in one transaction. */
export interface AnswerQuestionSetInput {
  setId: Id;
  by: Actor;
  answers: { questionId: Id; version?: number; answer: SetAnswer }[];
  /** Idempotency key as on `AnswerQuestionInput`. */
  answerId?: string;
  origin?: RequestOrigin;
}

/** Saves (or with `null` clears) the user's unsent draft on an open set row. */
export interface DraftQuestionInput {
  questionId: Id;
  draft: SetAnswer | null;
  by: Actor;
}

/** Dismisses every open row of a set in one transaction. */
export interface DismissQuestionSetInput {
  setId: Id;
  by: Actor;
  origin?: RequestOrigin;
}

/**
 * The user's "Allow similar" on a permission card (P9-17, SPEC decision 138, amended by P14): the
 * request is answered "allow" once and one rule per ticked row — drafted by the server from the
 * request, never sent by the client — is stored on the asking agent's project. `digests` are the
 * ticked rows' preview digests, `callDigest` the call's. Only the user makes rules (no brain tool
 * does); a remote or unknown `origin` needs `autoApproveRemote`. `version` and `answerId` as for
 * an answer.
 */
export interface AllowSimilarInput {
  questionId: Id;
  digests: string[];
  callDigest: string;
  by: Actor;
  origin?: RequestOrigin;
  version?: number;
  answerId?: string;
}

/** The user removes a project's "Allow similar" rule (P9-17): remote only with `autoApproveRemote`. */
export interface RemovePermissionRuleInput {
  projectId: Id;
  ruleId: Id;
  by: Actor;
  origin?: RequestOrigin;
}

/**
 * The user's "let the Waykeeper approve these" on a forwarded permission card (P13-05, SPEC
 * decision 154): the request is answered "allow" and a standing approval of its kind is stored on
 * the asking agent's project, in one command. Only the user; allowed from a remote client too (it
 * widens nothing the user has not allowed). Refused unless the card carries at least
 * `SIMILAR_APPROVALS_THRESHOLD` similar approvals, and never for a push or an upload. `version`
 * and `answerId` as for an answer.
 */
export interface StandingApprovalInput {
  questionId: Id;
  by: Actor;
  origin?: RequestOrigin;
  version?: number;
  answerId?: string;
}

/**
 * `approval`: the standing approval stored. `notStored`: the request was allowed, but the standing
 * approval could not be stored after it (the project ended meanwhile, say): said to the user.
 */
export interface StandingApprovalResult {
  approval?: StandingApproval;
  notStored?: string;
}

/** The user turns a project's Waykeeper approvals on or off; `on` needs the Mac (or `autoApproveRemote`). */
export interface SetWaykeeperApprovalsInput {
  projectId: Id;
  on: boolean;
  by: Actor;
  origin?: RequestOrigin;
}

/** The user removes a project's standing approval, from anywhere. */
export interface RemoveStandingApprovalInput {
  projectId: Id;
  approvalId: Id;
  by: Actor;
  origin?: RequestOrigin;
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

/**
 * What `addDeliverable` takes (P9-01): the row without its id, version, stamps, `addedBy` (the
 * caller's actor) or run. `projectId` is derived from the task when absent (a project task's
 * deliverable carries both). `detectedKey` only on a project's `detected` row.
 */
export interface AddDeliverableInput {
  projectId?: Id;
  taskId?: Id;
  kind: DeliverableKind;
  title: string;
  description?: string;
  source: DeliverableSource;
  location?: DeliverableLocation;
  command?: DeliverableCommand;
  url?: string;
  detectedKey?: string;
  meta?: Meta;
}

/**
 * What `updateDeliverable` may change (P9-01): the row's own fields, never its owner, source or
 * detected key (those move only with their task, decision 124). `null` clears a clearable field;
 * `meta` is merged into the row's (`null` drops a key).
 */
export interface DeliverableEdit {
  kind?: DeliverableKind;
  title?: string;
  description?: string | null;
  location?: DeliverableLocation | null;
  command?: DeliverableCommand | null;
  url?: string | null;
  meta?: Record<string, unknown>;
}

/** A deliverable write's options: its origin (decision 131) and the version the writer saw. */
export interface DeliverableWriteOptions extends WriteOptions {
  expectedVersion?: number | undefined;
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
// Long-term projects, areas and jobs (P10-01; SPEC decisions 142–145).

/** Makes a project long-term, or changes a long-term project's purpose and goals. */
export interface SetLongTermInput {
  projectId: Id;
  purpose: string;
  goals: string[];
  by: Actor;
}

/** A job in an existing area (`areaId`) or a new one made by `name` (an existing name is reused). */
export interface CreateJobInput {
  projectId: Id;
  area: { areaId: Id } | { name: string };
  draft: JobDraft;
  by: Actor;
  /** Where the approval granting the job's unattended rules came from (kept on each rule). */
  origin?: RequestOrigin;
}

export interface UpdateJobInput {
  jobId: Id;
  /** `areaId` moves the job (and its task) to another area of the project. */
  changes: Partial<JobDraft> & { areaId?: Id };
  by: Actor;
  /** Where the approval came from: kept on each rule it adds or changes. */
  origin?: RequestOrigin;
}

/**
 * A Waykeeper's job card (P10-06): create a job, change one or stop one. The card (a proposal
 * carrying `meta.job`) is checked like the command its approval runs, before it exists.
 */
export type ProposeJobInput = {
  projectId: Id;
  /** The Waykeeper proposing; it owns the card like a plan card. */
  waykeeperId: Id;
  rationale?: string;
} & (
  | { action: 'create'; area: { areaId: Id } | { name: string }; draft: JobDraft }
  | { action: 'change'; jobId: Id; changes: Partial<JobDraft> & { areaId?: Id } }
  | { action: 'stop'; jobId: Id }
);

/**
 * A Waykeeper's panel card (P15-03; SPEC decision 156): the card as `ProposalPanel` describes it.
 * The server builds what the card shows from it — the panel as it is (`before`, any given one is
 * ignored) and the job part, checked like `proposeJob` (its `moonId` and `before` too).
 */
export type ProposePanelInput = Omit<ProposalPanel, 'waykeeperId' | 'before'> & {
  waykeeperId: Id;
  rationale?: string;
};

/** One panel's place in `arrangePanels`. */
export interface PanelPlacement {
  panelId: Id;
  layout: PanelLayout;
}

export interface SetJobStateInput {
  jobId: Id;
  state: JobState;
  by: Actor;
  /** Why it was paused or stopped. */
  reason?: string;
}

export interface StartJobRunInput {
  jobId: Id;
  purpose: JobRunPurpose;
  /** The occurrence the run is for (ISO timestamp). */
  dueAt: string;
  followUp?: FollowUp;
  note?: string;
}

export interface AttachJobRunAgentInput {
  runId: Id;
  agentId: Id;
}

export interface EndJobRunInput {
  runId: Id;
  outcome: Exclude<JobRunOutcome, 'running'>;
  summary?: string;
  numbers?: Record<string, number>;
  /** The tables, lists, calendars, statuses and texts the run reported (P15-02). */
  data?: RunData;
  /** What the run actually used, recorded by Mission Control (P15-02). */
  sources?: UsedSource[];
  /** For `failed`: the reason the failure question gives. */
  failureReason?: string;
  /**
   * For `interrupted`: the job keeps its scheduled `nextRunAt` instead of becoming due now (the
   * user stopped the run's Steward, ledger ruling R9). Recorded on the run as `meta.keptSchedule`.
   */
  keepSchedule?: boolean;
}

/** A job run's finding, brought to the user as a job-owned question. */
export interface OpenFindingInput {
  runId: Id;
  originAgentId: Id;
  kind: 'suggestion' | 'reply';
  title: string;
  text: string;
  /** A reply's draft. */
  draft?: string;
}

/**
 * What a job run's Steward reports about its run (`report_run`, ledger ruling R3): kept on the run
 * as `meta.report` until the turn-end handler ends the run with it.
 */
export interface JobRunReport {
  outcome: 'quiet' | 'findings' | 'failed';
  summary: string;
  numbers?: Record<string, number>;
  /** The tables, lists, calendars, statuses, texts and source problems the run reported (P15-02). */
  data?: RunData;
  /** For `failed`: why. */
  failureReason?: string;
}

export interface ReportJobRunInput {
  runId: Id;
  /** The run's Steward. */
  agentId: Id;
  report: JobRunReport;
}

/** A `spend` question; job-owned when `runId` names a job run. */
export interface RequestSpendInput {
  originAgentId: Id;
  amount: number;
  /** ISO 4217; default `USD`. */
  currency?: string;
  purpose: string;
  runId?: Id;
}

/** A `publish` question (P11-02); job-owned when `runId` names a job run. */
export interface RequestPublishInput {
  originAgentId: Id;
  platform: string;
  account: string;
  text: string;
  /** Workspace paths of the files to publish; the server hashes them. */
  files?: string[];
  runId?: Id;
}

/** A `launch` question (P12-07): a Waykeeper asks to start a Steward with flags. */
export interface RequestLaunchInput {
  originAgentId: Id;
  taskId: Id;
  request: LaunchRequest;
  instructions: string;
  cwd: string;
  runtime: AgentRuntime;
}

/** Sets (`null`: clears) a project's default AI provider (P11-02). */
export interface SetProjectProviderInput {
  projectId: Id;
  provider: Provider | null;
  by: Actor;
}

/**
 * What `updateProject` / `updateTask` take: the row changes without the budget, which only
 * `setBudget` changes (its own `budget.set` event and loosening rule, P8-01). The events'
 * `ProjectChanges` / `TaskChanges` still carry `budgetUsd`: `setBudget` writes it that way.
 */
export type ProjectEdit = Omit<ProjectChanges, 'budgetUsd'>;
export type TaskEdit = Omit<TaskChanges, 'budgetUsd'>;

export interface DomainCommands {
  // projects and tasks
  /** A `permissionPolicy` is floored unless `write.origin` is `local` (P2-21). */
  /** `input.longTerm` makes a long-term project (P10-01). */
  createProject(input: CreateProjectInput, write?: WriteOptions): Promise<CommandResult<Project>>;
  /**
   * `null` clears a clearable field (`ProjectChanges`, P2-20); a `permissionPolicy` is floored
   * unless `write.origin` is `local` (P2-21).
   */
  updateProject(
    projectId: Id,
    changes: ProjectEdit,
    write?: WriteOptions,
  ): Promise<CommandResult<Project>>;
  setProjectState(projectId: Id, state: WorkState): Promise<CommandResult<Project>>;
  closeProject(projectId: Id, by: Actor): Promise<CommandResult<Project>>;
  archiveProject(projectId: Id, by: Actor): Promise<CommandResult<Project>>;
  pinProject(projectId: Id, pinned: boolean): Promise<CommandResult<Project>>;
  reopenProject(projectId: Id, by: Actor, input?: ReopenInput): Promise<CommandResult<Project>>;
  createTask(input: CreateTaskInput): Promise<CommandResult<Task>>;
  /** `null` clears a clearable field (`TaskChanges`, P2-20). */
  updateTask(taskId: Id, changes: TaskEdit): Promise<CommandResult<Task>>;
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
  /**
   * The user dismisses an open question (P9-14, SPEC decision 135): `question.cancelled` with
   * `by` and the reason "dismissed by the user". A question a live session waits on is resolved
   * through its adapter first (a clarification declined with that text, a permission request
   * denied); a stale `version` is refused like a stale answer.
   */
  dismissQuestion(input: DismissQuestionInput): Promise<CommandResult<Question>>;

  /** The user's standing approval from a forwarded card (P13-05): answers "allow" and stores it. */
  standingApproval(input: StandingApprovalInput): Promise<CommandResult<StandingApprovalResult>>;
  /** Turns a project's Waykeeper approvals on or off (P13-05). */
  setWaykeeperApprovals(input: SetWaykeeperApprovalsInput): Promise<CommandResult<Project>>;
  /** Removes a project's standing approval (P13-05). */
  removeStandingApproval(
    input: RemoveStandingApprovalInput,
  ): Promise<CommandResult<StandingApproval>>;

  // question sets (P8-19, SPEC decision 141)
  openQuestionSet(input: OpenQuestionSetInput): Promise<CommandResult<Question[]>>;
  answerQuestionSet(input: AnswerQuestionSetInput): Promise<CommandResult<Question[]>>;
  draftQuestion(input: DraftQuestionInput): Promise<CommandResult<Question>>;
  dismissQuestionSet(input: DismissQuestionSetInput): Promise<CommandResult<Question[]>>;

  // budgets (P8-01; SPEC decision 18)
  /**
   * Sets (`usd`), changes or removes (`null`) the dollar budget of a project or task: the row's
   * `budgetUsd` plus a `budget.set` event, in one transaction. Loosening it (raising or removing)
   * is refused for a remote or unknown `write.origin` unless the server sets `autoApproveRemote`
   * (SPEC decision 98, like decision 37's floor); setting or lowering is allowed from anywhere.
   */
  setBudget(
    target: BudgetTarget,
    usd: number | null,
    by: Actor,
    write?: WriteOptions,
  ): Promise<CommandResult<Project | Task>>;

  // deliverables (P9-01; SPEC §4.7, TECHNOLOGY §9.1)
  /**
   * Adds a deliverable for a project or a task (`deliverable.added`). No path is checked here:
   * `DeliverableService` checks and copies before calling it. A user's addition is refused for a
   * remote or unknown `write.origin` unless `autoApproveRemote` (decision 131).
   */
  addDeliverable(
    input: AddDeliverableInput,
    by: Actor,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
  /**
   * Edits its own fields (`deliverable.updated`, `version` bumped); `write.expectedVersion`
   * refuses a changed row as `stale`. An agent edits only what an agent declared.
   */
  updateDeliverable(
    deliverableId: Id,
    changes: DeliverableEdit,
    by: Actor,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
  /** Removes it from the lists (`deliverable.removed`); never deletes a file (decision 122). */
  removeDeliverable(
    deliverableId: Id,
    by: Actor,
    reason?: string,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;
  /** Lists a removed deliverable again (`deliverable.restored`). */
  restoreDeliverable(
    deliverableId: Id,
    by: Actor,
    write?: DeliverableWriteOptions,
  ): Promise<CommandResult<Deliverable>>;

  // long-term projects, areas and jobs (P10-01; SPEC decisions 142–145)
  /** Makes a project long-term (moving it to a planet with moons when needed), or edits it. */
  setLongTerm(input: SetLongTermInput): Promise<CommandResult<Project>>;
  /** A job, its hidden task and, for a new area name, the area on a moon — in one transaction. */
  createJob(input: CreateJobInput): Promise<CommandResult<{ job: Job; area: Area }>>;
  updateJob(input: UpdateJobInput): Promise<CommandResult<Job>>;
  /**
   * A Waykeeper's job card (`meta.job`); its approval runs `createJob` / `updateJob` /
   * `setJobState('stopped')` in the deciding transaction, a rejection changes nothing.
   */
  proposeJob(input: ProposeJobInput): Promise<CommandResult<Proposal>>;
  setJobState(input: SetJobStateInput): Promise<CommandResult<Job>>;

  // the project dashboard (P15-03; SPEC decision 156)
  /** Refused unless the project is long-term and open (`invalid`), or at 24 panels (`limit`). */
  createPanel(projectId: Id, draft: PanelDraft, by: Actor): Promise<CommandResult<Panel>>;
  updatePanel(panelId: Id, changes: PanelChanges, by: Actor): Promise<CommandResult<Panel>>;
  removePanel(panelId: Id, by: Actor, reason: string): Promise<CommandResult<void>>;
  /** The user's alone: every panel of the project, with distinct `order`s. */
  arrangePanels(projectId: Id, layouts: PanelPlacement[], by: Actor): Promise<CommandResult<void>>;
  /** The panel ignores runs before now (`historyFrom`). */
  clearPanelHistory(panelId: Id, by: Actor): Promise<CommandResult<Panel>>;
  /** Deletes the `numbers` and `data` of the job's runs up to now; lists the panels reading it. */
  clearJobValues(jobId: Id, by: Actor): Promise<CommandResult<{ upTo: string; panels: Id[] }>>;
  suggestPanelRemoval(panelId: Id): Promise<CommandResult<void>>;
  /** A Waykeeper's panel card (`meta.panel`); its approval writes the panel and any job part. */
  proposePanel(input: ProposePanelInput): Promise<CommandResult<Proposal>>;
  /** Records a run's start; refused while the job has a run going or is not active. */
  startJobRun(input: StartJobRunInput): Promise<CommandResult<JobRun>>;
  attachJobRunAgent(input: AttachJobRunAgentInput): Promise<CommandResult<JobRun>>;
  /** Records a run's end; a failure pauses the job and opens its one failure question. */
  endJobRun(input: EndJobRunInput): Promise<CommandResult<JobRun>>;
  openFinding(input: OpenFindingInput): Promise<CommandResult<Question>>;
  /** Keeps the Steward's report on its running run (`meta.report`); no event (REST-only rows). */
  reportJobRun(input: ReportJobRunInput): Promise<CommandResult<JobRun>>;
  requestSpend(input: RequestSpendInput): Promise<CommandResult<Question>>;
  requestPublish(input: RequestPublishInput): Promise<CommandResult<{ questionId: Id }>>;
  /** A `launch` approval held by the user alone (P12-07). */
  requestLaunch(input: RequestLaunchInput): Promise<CommandResult<{ questionId: Id }>>;
  /** Takes an approved launch once, for its task, as the Waykeeper that asked (P12-07). */
  takeLaunchApproval(input: {
    questionId: Id;
    taskId: Id;
    by: Actor;
  }): Promise<CommandResult<LaunchContext>>;
  setProjectProvider(input: SetProjectProviderInput): Promise<CommandResult<Project>>;

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
