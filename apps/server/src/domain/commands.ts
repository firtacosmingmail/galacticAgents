import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  AgentEvent,
  DISMISSED_BY_USER,
  SUPERSEDED_BY_MESSAGE,
  type DismissQuestionInput,
  type AllowSimilarInput,
  type PermissionRule,
  type Project,
  type RemovePermissionRuleInput,
  type RequestOrigin,
  type SimilarPreviewResponse,
  type Actor,
  type Agent,
  type AgentPlacement,
  type AnswerQuestionInput,
  type BodyRequest,
  type BudgetTarget,
  type CommandResult,
  type ControlAction,
  type ControlTarget,
  type CreateProjectInput,
  type CreateProposalInput,
  type CreateTaskInput,
  type DomainCommands,
  type ProjectEdit,
  type TaskEdit,
  type Event,
  type Host,
  type Id,
  type OpenQuestionInput,
  type PermissionPolicy,
  type ProposalDecision,
  type ProposePlanInput,
  type Question,
  type ReopenInput,
  type SpawnAgentInput,
  type Task,
  type WorkState,
  type WriteOptions,
  type ControlOptions,
  type AddDeliverableInput,
  type DeliverableEdit,
  type DeliverableWriteOptions,
  type OpenAction,
} from '@galactic/protocol';
import type { SpawnRequest, SpawnResult } from '../runtime/agent-runtime.js';
import { checkPlacement, recordSpawned, updateAgent } from './agents.js';
import { assignBody, freeBody, moveHost, sweepMarkers } from './bodies.js';
import { agentEffect, agentsOf } from './cascade.js';
import { EARTH_ID, chooseBody, freeMoons, freePlanets, type ChooseOptions } from './catalogue.js';
import { recordControl } from './control.js';
import { checkSpawnBudget, setBudget } from './budgets.js';
import { DomainError, must } from './errors.js';
import {
  addDeliverable,
  recordOpened,
  recordRunEnded,
  recordRunPorts,
  recordRunStarted,
  removeDeliverable,
  restoreDeliverable,
  updateDeliverable,
  type RunEndInput,
  type RunStartInput,
} from './deliverables.js';
import type { CommandContext, EventLog } from './event-log.js';
import {
  archiveProject,
  closeProject,
  createProject,
  pinProject,
  reopenProject,
  updateProject,
} from './projects.js';
import {
  globalDefaultPolicy,
  noLooserThan,
  resolvePolicy,
  type PolicyContext,
  type PolicyWrite,
} from './permissions.js';
import {
  aliasesOf,
  draftDigest,
  similarOptions,
  type RuleDraft,
  type SimilarOptions,
} from './permission-rules.js';
import { userFoldersOf } from '../deliverables/folder.js';
import {
  addPermissionRule,
  checkRuleAllowed,
  removePermissionRule,
  RULES_END_IN,
} from './project-rules.js';
import type { ProposalOptions } from './approval.js';
import { createProposal, decideProposal, proposePlan } from './proposals.js';
import {
  endAgentQuestions,
  holdersNow,
  logRouting,
  openFromNeedsInput,
  openRouted,
  type QuestionRouting,
} from './question-service.js';
import {
  answerQuestion,
  cancelQuestion,
  checkAnswer,
  checkDismiss,
  type Dismissal,
  consumeConfirmation,
  isRecordedAnswer,
  escalateQuestion,
  reassignQuestion,
  COMMAND_SOURCE,
} from './questions.js';
import { setProjectState, setTaskState } from './states.js';
import {
  archiveTask,
  closeTask,
  createTask,
  moveTask,
  pinTask,
  reopenTask,
  updateTask,
} from './tasks.js';

/**
 * What the command surface needs from the agent runtime: the agent-level effects that involve an
 * adapter session. `AgentRuntime` provides it; tests may pass a stand-in or nothing (then the
 * agent commands are refused).
 */
export interface AgentControl {
  spawn(req: SpawnRequest): Promise<SpawnResult>;
  stop(agentId: Id, by: Actor): Promise<void>;
  pause(agentId: Id, by: Actor): Promise<void>;
  resumeAgent(agentId: Id, by: Actor): Promise<void>;
  /** `answerId`: the answerer's idempotency key (P7-05), recorded with the answer. */
  answer(questionId: Id, answer: string, by: Actor, answerId?: string): Promise<void>;
  /** Whether a live session asked the question and takes its answer through the adapter. */
  hasQuestion(questionId: Id): boolean;
  /**
   * Dismisses a question a live session waits on (P9-14): through the adapter, then logged as
   * `question.cancelled` with `by`. Absent: such a question cannot be dismissed (refused).
   */
  dismiss?(questionId: Id, reason: string, dismissal: Dismissal): Promise<void>;
  /** Agents with a live adapter session: whom a task or project control reaches (P2-14). */
  liveAgents?(): Agent[];
  /**
   * Where a live agent's permission requests are judged (P9-17): its project, table and gate
   * context. Absent or `undefined` (not running here): read from the rows.
   */
  permissionContext?(
    agentId: Id,
  ): { projectId: Id | undefined; policy: PermissionPolicy; ctx: PolicyContext } | undefined;
}

export interface CommandsOptions {
  log: EventLog;
  agents?: AgentControl;
  /** Question routing (P2-03); default: the log alone (liveness from lifecycle events). */
  questions?: QuestionRouting;
  /** Whether an agent still runs (the status store), for decision 10's Waykeeper-less planets. */
  isRunning?: (agentId: Id) => boolean;
  /**
   * The server lets remote clients set up auto-approvals (`config.autoApproveRemote`, TECHNOLOGY
   * §8): no policy write is floored. Default off: a write not marked local is floored (P2-21).
   */
  autoApproveRemote?: boolean;
  /**
   * Validates a proposal card's workspace (P2-09; the server passes `Workspaces.checkPath`): a
   * user's edit and the approval are refused for a workspace decision 27 forbids.
   */
  checkWorkspace?: (path: string) => string;
}

/**
 * A row's budget changes through `setBudget` only (P8-01): its own event and remote rule. The types
 * leave `budgetUsd` out of the update commands; this refuses an untyped caller's.
 */
function noBudget(changes: object): void {
  if ((changes as { budgetUsd?: unknown }).budgetUsd !== undefined) {
    throw new DomainError('invalid', 'a budget is set with setBudget, not by an update');
  }
}

const SYSTEM: Actor = { type: 'system' };

const ENDINGS = new Set(['agent.finished', 'agent.failed', 'agent.stopped', 'agent.interrupted']);

/** How often the same refused spawn is logged again (P8-01 review): once an hour. */
export const SPAWN_REFUSED_EVERY_MS = 3_600_000;

/**
 * `DomainCommands` (P2-01; TECHNOLOGY §5, §6.1): the one command surface brain tools, panel
 * actions and the REST/WS routes call. Domain commands run synchronously under the one write
 * rule — mutation and events in one transaction, a `DomainError` rolls both back — and resolve
 * with the row and the events they appended. Agent commands go through the runtime, which owns
 * the adapter sessions and logs their events itself.
 */
export class Commands implements DomainCommands {
  private readonly log: EventLog;
  private readonly agents: AgentControl | undefined;
  private readonly questions: QuestionRouting;
  private readonly choose: ChooseOptions;
  private readonly autoApproveRemote: boolean;
  private readonly proposalOptions: ProposalOptions;
  /**
   * Spawns under way, by slot (`harmonizer`, `waykeeper:<project>`, `steward:<task>`): a slot is
   * taken synchronously, before the spawn's session reports, so two concurrent spawns can never
   * both pass the "one live agent" check (wave-4 review).
   */
  private readonly spawning = new Set<string>();
  /**
   * Refused spawns already logged (P8-01 review): one `budget.spawn_refused` per work, role and
   * budget value per `SPAWN_REFUSED_EVERY_MS`, so a brain retrying a refused spawn does not fill
   * the log. The caller is refused every time.
   */
  private readonly refusedLogged = new Map<string, number>();
  /**
   * Answers being handed to an agent's adapter, by `<questionId> <answerId>` (P7-05): a retry of
   * the same answer (its acknowledgement was lost) waits for the first copy instead of being
   * refused as "already being answered".
   */
  private readonly answering = new Map<string, Promise<CommandResult<Question>>>();

  constructor(opts: CommandsOptions) {
    this.log = opts.log;
    this.agents = opts.agents;
    this.questions = opts.questions ?? logRouting(opts.log);
    this.choose = opts.isRunning ? { isRunning: opts.isRunning } : {};
    this.autoApproveRemote = opts.autoApproveRemote ?? false;
    this.proposalOptions = {
      ...this.choose,
      // A promotion moved in the approval hands its agents over to living supervisors (P2-12).
      handOver: { isLiving: (id: Id) => this.questions.isLiving(id) },
      ...(opts.checkWorkspace ? { checkWorkspace: opts.checkWorkspace } : {}),
    };
  }

  /** How a command's policy write is judged (P2-21): its origin plus the server's setting. */
  private policyWrite(write: WriteOptions = {}): PolicyWrite {
    return { origin: write.origin, autoApproveRemote: this.autoApproveRemote };
  }

  /** Hand-overs prefer a living supervisor (P2-12). */
  private handOver() {
    return { isLiving: (id: Id) => this.questions.isLiving(id) };
  }

  private run<T>(fn: (ctx: CommandContext) => T): Promise<CommandResult<T>> {
    try {
      const out = this.log.runCommand(fn);
      return Promise.resolve({ value: out.value, events: out.events.map((e) => e.event) });
    } catch (error) {
      return Promise.reject(error as Error);
    }
  }

  private runtime(): AgentControl {
    if (!this.agents) throw new DomainError('invalid', 'no agent runtime');
    return this.agents;
  }

  /** The events logged since `seq` that concern `agentId` (an agent command's own events). */
  private eventsOf(since: number, agentId: Id): Event[] {
    return this.log
      .eventsSince(since, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => {
        if (e.type === 'agent.created') return e.agent.id === agentId;
        if (e.type.startsWith('control.')) {
          const target = (e as { target: ControlTarget }).target;
          return target.kind === 'agent' && target.id === agentId;
        }
        return 'agentId' in e && e.agentId === agentId;
      });
  }

  /**
   * The events an agent-level effect by `by` caused on `agentIds` (logged since `since`): the
   * runtime's `control.*{agent}` and the agents' paused / resumed / stopped carrying `by`. Nothing
   * else the agents or anyone did meanwhile — a brain's mailbox drops a tool call's events as its
   * own, so over-reporting here would swallow other actors' events (wave-2 review).
   */
  private effectEvents(since: number, agentIds: readonly Id[], by: Actor): Event[] {
    const sameActor = (a: Actor | undefined) => a?.type === by.type && a.id === by.id;
    return this.log
      .eventsSince(since, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => {
        if (e.type.startsWith('control.')) {
          const c = e as { target: ControlTarget; by: Actor };
          return c.target.kind === 'agent' && agentIds.includes(c.target.id) && sameActor(c.by);
        }
        // A stop ends the agent once; the adapter may report it as the system's, whoever asked.
        if (e.type === 'agent.stopped') return agentIds.includes(e.agentId);
        if (e.type === 'agent.paused' || e.type === 'agent.resumed') {
          return agentIds.includes(e.agentId) && sameActor(e.by);
        }
        return false;
      });
  }

  private async agentCommand(
    agentId: Id,
    by: Actor,
    fn: (runtime: AgentControl) => Promise<void>,
  ): Promise<CommandResult<Agent>> {
    must(this.log.tables.agents.get(agentId), 'agent', agentId);
    const since = this.log.currentSeq();
    await fn(this.runtime());
    return {
      value: this.log.tables.agents.get(agentId)!,
      events: this.effectEvents(since, [agentId], by),
    };
  }

  // -- projects and tasks ----------------------------------------------------------------------

  /** A `permissionPolicy` is floored at the global default unless `write.origin` is local. */
  createProject(input: CreateProjectInput, write?: WriteOptions) {
    return this.run((ctx) => createProject(ctx, input, this.choose, this.policyWrite(write)));
  }
  /** A new `permissionPolicy` is floored at the global default unless `write.origin` is local. */
  updateProject(projectId: Id, changes: ProjectEdit, write?: WriteOptions) {
    return this.run((ctx) => {
      noBudget(changes);
      return updateProject(ctx, projectId, changes, this.policyWrite(write), this.handOver());
    });
  }
  setProjectState(projectId: Id, state: WorkState) {
    return this.run((ctx) => setProjectState(ctx, projectId, state));
  }
  closeProject(projectId: Id, by: Actor) {
    return this.run((ctx) => closeProject(ctx, projectId, by));
  }
  archiveProject(projectId: Id, by: Actor) {
    return this.run((ctx) => archiveProject(ctx, projectId, by));
  }
  pinProject(projectId: Id, pinned: boolean) {
    return this.run((ctx) => pinProject(ctx, projectId, pinned));
  }
  reopenProject(projectId: Id, by: Actor, input?: ReopenInput) {
    return this.run((ctx) => reopenProject(ctx, projectId, by, input, this.choose));
  }
  createTask(input: CreateTaskInput) {
    return this.run((ctx) => createTask(ctx, input));
  }
  updateTask(taskId: Id, changes: TaskEdit) {
    return this.run((ctx) => {
      noBudget(changes);
      return updateTask(ctx, taskId, changes);
    });
  }

  // -- budgets (P8-01) -------------------------------------------------------------------------

  /** Raising or removing a budget is refused for a remote or unknown origin (see `setBudget`). */
  setBudget(target: BudgetTarget, usd: number | null, by: Actor, write?: WriteOptions) {
    return this.run((ctx) => setBudget(ctx, target, usd, by, this.policyWrite(write)));
  }
  setTaskState(taskId: Id, state: WorkState) {
    return this.run((ctx) => setTaskState(ctx, taskId, state));
  }
  closeTask(taskId: Id, by: Actor) {
    return this.run((ctx) => closeTask(ctx, taskId, by));
  }
  archiveTask(taskId: Id, by: Actor) {
    return this.run((ctx) => archiveTask(ctx, taskId, by));
  }
  pinTask(taskId: Id, pinned: boolean) {
    return this.run((ctx) => pinTask(ctx, taskId, pinned));
  }
  reopenTask(taskId: Id, by: Actor, input?: ReopenInput) {
    return this.run((ctx) => reopenTask(ctx, taskId, by, input));
  }
  moveTask(taskId: Id, toProjectId: Id, by: Actor) {
    return this.run((ctx) => moveTask(ctx, taskId, toProjectId, by, this.handOver()));
  }

  // -- bodies ----------------------------------------------------------------------------------

  assignBody(bodyId: Id, host: Host) {
    return this.run((ctx) => assignBody(ctx, bodyId, host));
  }
  moveHost(host: Host, toBodyId: Id) {
    return this.run((ctx) => moveHost(ctx, host, toBodyId));
  }
  freeBody(bodyId: Id) {
    return this.run((ctx) => freeBody(ctx, bodyId));
  }
  freePlanets() {
    return Promise.resolve(freePlanets(this.log));
  }
  freeMoons(planetId?: Id) {
    return Promise.resolve(freeMoons(this.log, planetId));
  }
  chooseBody(request: BodyRequest) {
    return Promise.resolve(chooseBody(this.log, request, this.choose));
  }
  /**
   * The retention sweep for "moved to …" markers (decision 15), by the log's clock. A system job:
   * P2-13's scheduler calls it with the retention setting.
   */
  sweepMarkers(retentionMs?: number) {
    return this.run((ctx) => sweepMarkers(ctx, retentionMs));
  }

  // -- agents ----------------------------------------------------------------------------------

  /**
   * Spawns an agent where the hierarchy puts it (decision 24, P2-20): the one Harmonizer on Earth,
   * refused while another one runs; every other agent under the supervisor the hierarchy
   * prescribes (`checkPlacement`). A Steward in its task's worktree
   * (or the project workspace until P2-05 creates worktrees) on the task's body, a Waykeeper in
   * its project's workspace on the project's body, both under the project's permission policy.
   * Only an agent outside any project names its own working directory: the Harmonizer, and the
   * Steward of a standalone task without a worktree (SPEC §3.5: a related project's workspace or
   * a scratch folder, chosen by the Harmonizer).
   */
  async spawnAgent(input: SpawnAgentInput): Promise<CommandResult<Agent>> {
    const { tables } = this.log;
    const task = input.taskId
      ? must(tables.tasks.get(input.taskId), 'task', input.taskId)
      : undefined;
    const projectId = input.projectId ?? task?.projectId;
    const project = projectId
      ? must(tables.projects.get(projectId), 'project', projectId)
      : undefined;
    if (task?.projectId && input.projectId && task.projectId !== input.projectId) {
      throw new DomainError('invalid', `task ${task.id} belongs to project ${task.projectId}`);
    }
    checkPlacement(this.log, {
      role: input.role,
      ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
      ...(task ? { taskId: task.id } : {}),
      ...(projectId ? { projectId } : {}),
    });
    if (input.cwd && (project || task?.worktreePath)) {
      throw new DomainError('invalid', 'an agent of a project runs in its workspace or worktree');
    }
    const cwd = task?.worktreePath ?? project?.workspace ?? input.cwd;
    if (!cwd)
      throw new DomainError('invalid', 'an agent outside a project needs a working directory');
    // An asteroid Steward in a related project's workspace works under that project's table too,
    // never looser than the global default (SPEC §3.5, decision 22): per category the strictest.
    const borrowed = !project && task ? relatedPolicy(tables, task, cwd) : undefined;
    // One live Harmonizer (decision 32), one live Waykeeper per project, one live Steward per task.
    const slot =
      input.role === 'harmonizer'
        ? { key: 'harmonizer', what: 'the Harmonizer is already running', of: () => true }
        : input.role === 'waykeeper' && projectId
          ? {
              key: `waykeeper:${projectId}`,
              what: `project ${projectId} already has a running Waykeeper`,
              of: (a: Agent) => a.projectId === projectId,
            }
          : input.role === 'steward' && task
            ? {
                key: `steward:${task.id}`,
                what: `task ${task.id} already has a running Steward`,
                of: (a: Agent) => a.taskId === task.id,
              }
            : undefined;
    if (slot) {
      const live = new Set((this.agents?.liveAgents?.() ?? []).map((a) => a.id));
      const running = tables.agents
        .all()
        .find(
          (a) =>
            a.role === input.role &&
            slot.of(a) &&
            (live.has(a.id) || this.questions.isLiving(a.id)),
        );
      if (running || this.spawning.has(slot.key)) {
        throw new DomainError(
          'conflict',
          `${slot.what}${running ? ` (${running.id})` : ' (a spawn is under way)'}`,
        );
      }
    }
    // Dollar budgets (P8-01): no new Waykeeper or Steward for work that has spent its budget.
    // The refusal is logged (the Harmonizer's chat shows it) and the caller gets the reason.
    const overBudget = checkSpawnBudget(tables, {
      role: input.role,
      taskId: task?.id,
      projectId,
    });
    if (overBudget) {
      const key = [
        overBudget.target.kind,
        overBudget.target.id,
        overBudget.usage.budgetUsd,
        input.role,
        task?.id ?? projectId ?? '',
      ].join(':');
      const now = Date.now();
      const last = this.refusedLogged.get(key);
      if (last !== undefined && now - last < SPAWN_REFUSED_EVERY_MS) {
        throw new DomainError('conflict', overBudget.reason);
      }
      this.refusedLogged.set(key, now);
      this.log.runCommand((ctx) =>
        ctx.emit({
          type: 'budget.spawn_refused',
          target: overBudget.target,
          role: input.role,
          ...(task ? { taskId: task.id } : {}),
          ...(projectId ? { projectId } : {}),
          ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
          spentUsd: overBudget.usage.spentUsd,
          budgetUsd: overBudget.usage.budgetUsd!,
          reason: overBudget.reason,
        }),
      );
      throw new DomainError('conflict', overBudget.reason);
    }
    if (input.role === 'harmonizer') must(tables.bodies.get(EARTH_ID), 'body', EARTH_ID);
    // Earth is the headquarters (SPEC §3.1): the Harmonizer orbits it without it hosting work, so
    // the reserved body is neither assigned nor occupied (P2-20).
    const bodyId =
      input.role === 'harmonizer'
        ? EARTH_ID
        : input.role === 'steward'
          ? task?.bodyId
          : project?.bodyId;

    const since = this.log.currentSeq();
    const runtime = this.runtime();
    if (slot) this.spawning.add(slot.key);
    let spawning: Promise<SpawnResult>;
    try {
      spawning = runtime.spawn({
        role: input.role,
        runtime: input.runtime,
        prompt: input.prompt,
        cwd,
        ...(project ? { workspace: project.workspace, projectId: project.id } : {}),
        ...(project?.permissionPolicy ? { permissionPolicy: project.permissionPolicy } : {}),
        ...(borrowed ? { permissionPolicy: borrowed } : {}),
        ...(bodyId ? { bodyId } : {}),
        ...(task ? { taskId: task.id } : {}),
        ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
        ...(input.caps ? { caps: input.caps } : {}),
        ...(input.bare ? { bare: true } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      });
    } catch (error) {
      if (slot) this.spawning.delete(slot.key);
      throw error;
    }
    let result: SpawnResult;
    try {
      result = await spawning;
    } finally {
      if (slot) this.spawning.delete(slot.key);
    }
    if (!result.ok) throw new DomainError('conflict', result.reason);
    // Only what the spawn itself did — the row, its body, the session — never what the new agent
    // did on its own since: a brain drops a tool call's events as its own, so a Steward that
    // finished before the spawn call returned would never wake its supervisor (wave-4 review).
    const created = new Set(['agent.created', 'agent.spawned', 'body.created']);
    const events = this.log
      .eventsSince(since, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter(
        (e) =>
          created.has(e.type) &&
          (e.type === 'agent.created'
            ? e.agent.id === result.agent.id
            : e.type === 'body.created'
              ? e.body.id === result.agent.bodyId
              : e.type === 'agent.spawned' && e.agentId === result.agent.id),
      );
    return { value: result.agent, events };
  }

  updateAgent(agentId: Id, changes: AgentPlacement) {
    return this.run((ctx) => updateAgent(ctx, agentId, changes));
  }
  stopAgent(agentId: Id, by: Actor) {
    return this.agentCommand(agentId, by, (r) => r.stop(agentId, by));
  }
  pauseAgent(agentId: Id, by: Actor) {
    return this.agentCommand(agentId, by, (r) => r.pause(agentId, by));
  }
  resumeAgent(agentId: Id, by: Actor) {
    return this.agentCommand(agentId, by, (r) => r.resumeAgent(agentId, by));
  }

  /**
   * Folds an adapter event into the log the way the runtime does (an `agent.needs_input` opens
   * its routed question in the same transaction; an end cancels the agent's questions and
   * re-routes the ones it held, P2-03). For events that do not come through a live session.
   */
  recordAgentEvent(event: AgentEvent): Promise<CommandResult<void>> {
    const parsed = AgentEvent.parse(event);
    return this.run((ctx) => {
      const agent = must(ctx.tables.agents.get(parsed.agentId), 'agent', parsed.agentId);
      if (parsed.type === 'agent.spawned') {
        // The row keeps the session ref the event reports, as the runtime's spawn does.
        recordSpawned(ctx, agent, parsed.sessionRef);
        return;
      }
      ctx.emit(parsed);
      if (parsed.type === 'agent.needs_input') openFromNeedsInput(ctx, parsed, this.questions);
      else if (ENDINGS.has(parsed.type)) {
        endAgentQuestions(ctx, agent.id, parsed.type.slice('agent.'.length), this.questions);
      }
    });
  }

  // -- proposals -------------------------------------------------------------------------------

  createProposal(input: CreateProposalInput) {
    return this.run((ctx) => createProposal(ctx, input, this.proposalOptions));
  }
  proposePlan(input: ProposePlanInput) {
    return this.run((ctx) => proposePlan(ctx, input));
  }
  /** The trust level an approval gives its project is floored unless `write.origin` is local. */
  decideProposal(proposalId: Id, decision: ProposalDecision, by: Actor, write?: WriteOptions) {
    return this.run((ctx) =>
      decideProposal(ctx, proposalId, decision, by, {
        ...this.proposalOptions,
        policyWrite: this.policyWrite(write),
      }),
    );
  }

  // -- questions -------------------------------------------------------------------------------

  /**
   * `toUser` (a choice only the user may make, decision 30): held by the user from the start, in
   * the same command, so no supervisor holds it on the way and none is woken by it.
   */
  openQuestion(input: OpenQuestionInput) {
    const { toUser, ...rest } = input;
    if (toUser && rest.kind !== 'clarification') {
      return Promise.reject(
        new DomainError('invalid', 'only a clarification is opened for the user explicitly'),
      );
    }
    return this.run((ctx) =>
      openRouted(
        ctx,
        {
          ...rest,
          id: `q-${randomUUID()}`,
          meta: { source: COMMAND_SOURCE, ...(toUser ? { toUser: true } : {}) },
        },
        this.questions,
        toUser ? { type: 'user' } : undefined,
      ),
    );
  }

  /**
   * First answer wins (SPEC §2.6): refused with "already answered by …" when someone was first or
   * the question changed since `version`. A question a live session asked gets the answer through
   * its adapter before the log records it, so the log never holds an answer the agent did not
   * receive; any other open question is answered in the log alone.
   */
  async answerQuestion(input: AnswerQuestionInput): Promise<CommandResult<Question>> {
    const { questionId, answerId } = input;
    const key = answerId !== undefined ? `${questionId} ${answerId}` : undefined;
    const pending = key !== undefined ? this.answering.get(key) : undefined;
    if (pending) return pending;
    const answer = {
      questionId,
      answer: input.answer,
      answeredBy: input.by,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(answerId !== undefined ? { answerId } : {}),
    };
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    // Recorded already under this key: the retry of an answer whose acknowledgement was lost.
    if (isRecordedAnswer(question, answerId)) return { value: question, events: [] };
    checkAnswer(question, answer);
    if (!this.agents?.hasQuestion(questionId)) {
      return this.run((ctx) =>
        answerQuestion(ctx, { ...answer, holders: holdersNow(ctx, questionId, this.questions) }),
      );
    }
    if (key === undefined) return this.answerThroughAdapter(input);
    const result = this.answerThroughAdapter(input);
    this.answering.set(key, result);
    try {
      return await result;
    } finally {
      this.answering.delete(key);
    }
  }

  /** The answer to a question a live session waits on: the adapter first, then the log. */
  private async answerThroughAdapter(input: AnswerQuestionInput): Promise<CommandResult<Question>> {
    const { questionId } = input;
    const since = this.log.currentSeq();
    await this.agents!.answer(questionId, input.answer, input.by, input.answerId);
    const after = must(this.log.tables.questions.get(questionId), 'question', questionId);
    const events = this.log
      .eventsSince(since, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter((e) => e.type === 'question.answered' && e.questionId === questionId);
    return { value: after, events };
  }
  escalateQuestion(questionId: Id, by: Actor) {
    return this.run((ctx) => escalateQuestion(ctx, questionId, by, this.questions.isLiving));
  }
  reassignQuestion(questionId: Id, to: Actor, reason: string) {
    return this.run((ctx) => reassignQuestion(ctx, questionId, to, reason));
  }
  async withdrawQuestion(questionId: Id, reason: string, by: Actor) {
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    if (question.status !== 'open') return { value: question, events: [] };
    if (question.kind !== 'clarification') {
      throw new DomainError('invalid', `${questionId} is a permission question: the user decides`);
    }
    if (by.type === 'agent' && by.id !== question.originAgentId) {
      throw new DomainError('conflict', `${questionId} is not your question`);
    }
    if (this.agents?.hasQuestion(questionId)) {
      throw new DomainError('invalid', `a live session waits on ${questionId}: stop its agent`);
    }
    return this.run(
      (ctx) =>
        cancelQuestion(ctx, questionId, reason, holdersNow(ctx, questionId, this.questions)) ??
        question,
    );
  }

  /**
   * The user dismisses an open question (P9-14, SPEC decision 135). Checked like an answer (a
   * stale `version`, an answered or withdrawn question: 409 `stale`). A question a live session
   * waits on goes through its adapter first (a clarification declined, a permission request
   * denied — never allowed), any other is cancelled in the log; either way `question.cancelled`
   * with `by` and the reason "dismissed by the user", which wakes its asker and holders.
   */
  async dismissQuestion(input: DismissQuestionInput): Promise<CommandResult<Question>> {
    const { questionId, by } = input;
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    checkDismiss(question, by, input.version);
    return this.dismissWith(question, DISMISSED_BY_USER, {
      by,
      ...(input.origin ? { origin: input.origin } : {}),
    });
  }

  // -- "Allow similar" rules (P9-17; SPEC decision 138) ------------------------------------------

  /**
   * Where a permission request is judged: the asking agent's project (a Steward's is its task's),
   * its table and its gate context — the live session's, else the rows' (the workspace, the task's
   * worktree, their other spellings and the deliverables folder, as the gate builds them: review
   * S8, so the preview and the gate judge the same call alike).
   */
  private permissionContextOf(question: Question): {
    projectId: Id | undefined;
    policy: PermissionPolicy;
    ctx: PolicyContext;
  } {
    const live = this.agents?.permissionContext?.(question.originAgentId);
    if (live) return live;
    const { tables } = this.log;
    const agent = tables.agents.get(question.originAgentId);
    const task = agent?.taskId ? tables.tasks.get(agent.taskId) : undefined;
    const projectId = agent?.projectId ?? task?.projectId;
    const project = projectId ? tables.projects.get(projectId) : undefined;
    const workspace = project?.workspace ?? '/';
    const cwd = task?.worktreePath ?? workspace;
    const userFolders = userFoldersOf(
      {
        project: (id) => tables.projects.get(id),
        task: (id) => tables.tasks.get(id),
        projects: () => tables.projects.all(),
      },
      { projectId: agent?.projectId, taskId: agent?.taskId },
      workspace,
    );
    return {
      projectId: project?.id,
      policy: project?.permissionPolicy ?? globalDefaultPolicy(),
      ctx: {
        workspace,
        cwd,
        aliases: aliasesOf(workspace, cwd),
        ...(userFolders.length > 0 ? { userFolders } : {}),
      },
    };
  }

  /** The chooser's options for an open permission request, with the project it would go to. */
  private similarFor(question: Question): SimilarOptions & { project?: Project } {
    if (question.kind !== 'permission') {
      return { refused: 'only a permission request can allow similar actions', options: [] };
    }
    const call = question.context.toolCall;
    if (!call) return { refused: 'the request names no tool call', options: [] };
    const { projectId, policy, ctx } = this.permissionContextOf(question);
    const project = projectId ? this.log.tables.projects.get(projectId) : undefined;
    if (!project) {
      return {
        refused:
          "the request belongs to no project (the Harmonizer's or a standalone task's): allow it once",
        options: [],
      };
    }
    if (RULES_END_IN.has(project.state)) {
      return { project, refused: `project ${project.name} is ${project.state}`, options: [] };
    }
    return { project, ...similarOptions({ call, ctx, policy }) };
  }

  /** Whether a request from `origin` may make or remove rules: the Mac, or `autoApproveRemote`. */
  private mayWriteRules(origin: RequestOrigin | undefined): boolean {
    return origin === 'local' || this.autoApproveRemote;
  }

  /**
   * What the card's "Allow similar" chooser offers for an open permission request (P9-17): one
   * option per scope with its preview, computed here from the request (never by the client).
   */
  similarPreview(questionId: Id, write: WriteOptions = {}): SimilarPreviewResponse {
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    const found = this.similarFor(question);
    return {
      questionId,
      ...(found.project ? { projectId: found.project.id, projectName: found.project.name } : {}),
      ...(found.refused ? { refused: found.refused } : {}),
      options: found.options.map((o) =>
        o.available
          ? {
              scope: o.scope,
              available: true,
              label: o.draft.label,
              preview: o.draft.preview,
              digest: draftDigest(o.draft),
            }
          : { scope: o.scope, available: false, reason: o.reason },
      ),
      allowed: this.mayWriteRules(write.origin) && !found.refused,
    };
  }

  /**
   * The user's "Allow similar" (P9-17, decision 138): the request is answered "allow" (through
   * its session first when one waits on it, like any answer) and the rule of `scope` the server
   * drafts from it is stored on the asking agent's project. Refused before anything happens: not
   * the user (agents never make rules), a remote or unknown origin without `autoApproveRemote`
   * (decisions 37, 90), a stale `version`, a push, a request outside any project or of a project
   * that takes no rules, a scope the chooser does not offer, and — 409 `stale` — a rule that is not
   * the one the preview showed (`digest`, review S1). With no session waiting, the answer and the
   * rule are one transaction; with one, the session gets the answer first and the rule is stored
   * after it — should that fail (the project closed meanwhile), the request stays allowed once
   * and `ruleNotStored` says why (review S6).
   */
  async allowSimilar(
    input: AllowSimilarInput,
  ): Promise<CommandResult<{ rule?: PermissionRule; ruleNotStored?: string }>> {
    const { questionId, by } = input;
    if (by.type !== 'user') {
      throw new DomainError('invalid', 'only the user makes "Allow similar" rules');
    }
    if (!this.mayWriteRules(input.origin)) {
      throw new DomainError(
        'remote_control',
        '"Allow similar" works only from this machine (a remote client may allow once)',
      );
    }
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    const answer = {
      questionId,
      answer: 'allow',
      answeredBy: by,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.answerId !== undefined ? { answerId: input.answerId } : {}),
    };
    checkAnswer(question, answer);
    const found = this.similarFor(question);
    if (found.refused || !found.project) {
      throw new DomainError('invalid', `no rule can be made: ${found.refused ?? 'no project'}`);
    }
    const option = found.options.find((o) => o.scope === input.scope);
    if (!option?.available) {
      throw new DomainError(
        'invalid',
        `no ${input.scope} rule can be made: ${option && !option.available ? option.reason : 'not offered'}`,
      );
    }
    const draft: RuleDraft = option.draft;
    if (draftDigest(draft) !== input.digest) {
      throw new DomainError(
        'stale',
        'the rule is not the one the preview showed any more (the request or the table changed): look at the preview again',
      );
    }
    const projectId = found.project.id;
    // The rule's checks before the answer (review S6): nothing is answered for a rule refused.
    checkRuleAllowed(found.project, draft);
    const made = { by, origin: input.origin ?? ('remote' as const), questionId };
    if (!this.agents?.hasQuestion(questionId)) {
      // No session waits: the answer and the rule in one transaction.
      const result = await this.run((ctx) => {
        answerQuestion(ctx, { ...answer, holders: holdersNow(ctx, questionId, this.questions) });
        return addPermissionRule(ctx, projectId, draft, made);
      });
      return { value: { rule: result.value }, events: result.events };
    }
    const answered = await this.answerQuestion({
      questionId,
      answer: 'allow',
      by,
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.answerId !== undefined ? { answerId: input.answerId } : {}),
    });
    try {
      const stored = await this.run((ctx) => addPermissionRule(ctx, projectId, draft, made));
      return { value: { rule: stored.value }, events: [...answered.events, ...stored.events] };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return {
        value: { ruleNotStored: `allowed once; the rule was not stored: ${error.message}` },
        events: answered.events,
      };
    }
  }

  /** The user removes a project's rule (P9-17): remote only with `autoApproveRemote`. */
  removePermissionRule(input: RemovePermissionRuleInput): Promise<CommandResult<PermissionRule>> {
    if (input.by.type !== 'user') {
      return Promise.reject(new DomainError('invalid', 'only the user removes rules'));
    }
    if (!this.mayWriteRules(input.origin)) {
      return Promise.reject(
        new DomainError('remote_control', 'rules are removed only from this machine'),
      );
    }
    return this.run((ctx) =>
      removePermissionRule(ctx, input.projectId, input.ruleId, input.by, 'removed by the user'),
    );
  }

  /**
   * The user wrote to an agent (P9-14, SPEC decision 135): its own open clarifications, asked
   * before the message, no longer wait for an answer — each is withdrawn as "superseded by the
   * user's message" (`by: system`) and the agent told, so it reads the message instead. Never a
   * permission request, never a question opened for the user alone (decision 30: a merge
   * conflict), never the Harmonizer's (the user's single contact talks with them open, and its
   * closure and confirmation questions are answered only by the user's choice). A question
   * answered or withdrawn meanwhile is skipped. A question whose session could not be told (an
   * adapter error) is reported to `onError` and the others are still withdrawn. Returns the ids
   * withdrawn.
   */
  async supersedeQuestions(
    agentId: Id,
    onError: (questionId: Id, error: unknown) => void = (questionId, error) =>
      console.warn(
        `[commands] superseding ${questionId} failed:`,
        error instanceof Error ? error.message : error,
      ),
  ): Promise<Id[]> {
    const agent = this.log.tables.agents.get(agentId);
    if (!agent || agent.role === 'harmonizer') return [];
    const open = this.log.tables.questions
      .all()
      .filter(
        (q) =>
          q.originAgentId === agentId &&
          q.status === 'open' &&
          q.kind === 'clarification' &&
          q.meta?.['toUser'] !== true,
      );
    const withdrawn: Id[] = [];
    for (const q of open) {
      try {
        const { events } = await this.dismissWith(q, SUPERSEDED_BY_MESSAGE, { by: SYSTEM });
        if (events.length > 0) withdrawn.push(q.id);
      } catch (error) {
        // Answered or withdrawn meanwhile: nothing to supersede. Anything else (the adapter
        // could not be told) is reported, and the next question is still superseded.
        if (!(error instanceof DomainError)) onError(q.id, error);
      }
    }
    return withdrawn;
  }

  private async dismissWith(
    question: Question,
    reason: string,
    dismissal: Dismissal,
  ): Promise<CommandResult<Question>> {
    const questionId = question.id;
    if (this.agents?.hasQuestion(questionId)) {
      if (!this.agents.dismiss) {
        throw new DomainError('invalid', `the session waiting on ${questionId} cannot be told`);
      }
      const since = this.log.currentSeq();
      await this.agents.dismiss(questionId, reason, dismissal);
      const after = must(this.log.tables.questions.get(questionId), 'question', questionId);
      const events = this.log
        .eventsSince(since, Number.MAX_SAFE_INTEGER)
        .map((e) => e.event)
        .filter((e) => e.type === 'question.cancelled' && e.questionId === questionId);
      return { value: after, events };
    }
    return this.run((ctx) => {
      const current = must(ctx.tables.questions.get(questionId), 'question', questionId);
      checkDismiss(current, dismissal.by);
      return (
        cancelQuestion(
          ctx,
          questionId,
          reason,
          holdersNow(ctx, questionId, this.questions),
          dismissal,
        ) ?? current
      );
    });
  }

  // -- deliverables (P9-01) --------------------------------------------------------------------

  /** How a deliverable write is judged: its origin, the server's setting, the version seen. */
  private deliverableWrite(write: DeliverableWriteOptions = {}) {
    return { ...write, autoApproveRemote: this.autoApproveRemote };
  }
  addDeliverable(input: AddDeliverableInput, by: Actor, write?: DeliverableWriteOptions) {
    return this.run((ctx) => addDeliverable(ctx, input, by, this.deliverableWrite(write)));
  }
  updateDeliverable(
    deliverableId: Id,
    changes: DeliverableEdit,
    by: Actor,
    write?: DeliverableWriteOptions,
  ) {
    return this.run((ctx) =>
      updateDeliverable(ctx, deliverableId, changes, by, this.deliverableWrite(write)),
    );
  }
  removeDeliverable(
    deliverableId: Id,
    by: Actor,
    reason?: string,
    write?: DeliverableWriteOptions,
  ) {
    return this.run((ctx) =>
      removeDeliverable(ctx, deliverableId, by, reason, this.deliverableWrite(write)),
    );
  }
  restoreDeliverable(deliverableId: Id, by: Actor, write?: DeliverableWriteOptions) {
    return this.run((ctx) =>
      restoreDeliverable(ctx, deliverableId, by, this.deliverableWrite(write)),
    );
  }
  /** The audit of an open on the Mac (decision 127); the opener (P9-03/P9-07) calls it. */
  recordDeliverableOpened(deliverableId: Id, action: OpenAction, by: Actor) {
    return this.run((ctx) => recordOpened(ctx, deliverableId, action, by));
  }
  /** A run started, after the fork (P9-08's `RunService`; decision 130). */
  recordRunStarted(input: RunStartInput, by: Actor) {
    return this.run((ctx) => recordRunStarted(ctx, input, by));
  }
  /** The ports a run listens on changed. */
  recordRunPorts(runId: Id, ports: number[]) {
    return this.run((ctx) => recordRunPorts(ctx, runId, ports));
  }
  /** A run ended (idempotent). */
  recordRunEnded(runId: Id, input: RunEndInput) {
    return this.run((ctx) => recordRunEnded(ctx, runId, input));
  }

  // -- panel actions ---------------------------------------------------------------------------

  /**
   * A panel action (decision 11b). On an agent: stop/cancel, pause and resume through the runtime
   * (which records `control.*` itself). On a task or project: recorded with its domain effect;
   * a project edit's `permissionPolicy` is floored unless `write.origin` is local (P2-21).
   */
  async control(
    target: ControlTarget,
    action: ControlAction,
    by: Actor,
    write?: ControlOptions,
  ): Promise<CommandResult<void>> {
    if (target.kind === 'agent') {
      if (write?.confirmation) {
        throw new DomainError('invalid', 'a confirmation goes with a task or project control');
      }
      const run = (fn: (r: AgentControl) => Promise<void>) =>
        this.agentCommand(target.id, by, fn).then((r) => ({ value: undefined, events: r.events }));
      switch (action.action) {
        case 'stop':
        case 'cancel':
          return run((r) => r.stop(target.id, by));
        case 'pause':
          return run((r) => r.pause(target.id, by));
        case 'resume':
          return run((r) => r.resumeAgent(target.id, by));
        default:
          throw new DomainError('invalid', `an agent cannot be given "${action.action}"`);
      }
    }
    // A task or project: the event and its state effect in one transaction (refused → nothing
    // happens), then the agent effect on the target's live agents through the runtime (P2-14).
    const live = new Set((this.agents?.liveAgents?.() ?? []).map((a) => a.id));
    const effect = agentEffect(action.action);
    const affected = effect
      ? agentsOf(this.log.tables, target)
          .map((a) => a.id)
          .filter((id) => live.has(id))
      : [];
    const confirmation = write?.confirmation;
    const own = await this.run((ctx) => {
      // One transaction (P5-07): the answer is used up exactly when the control is recorded.
      if (confirmation) {
        consumeConfirmation(ctx, confirmation, `${action.action} ${target.kind} ${target.id}`);
      }
      recordControl(ctx, target, action, by, {
        isLive: (id) => live.has(id),
        write: this.policyWrite(write),
      });
    });
    const since = this.log.currentSeq();
    if (effect && affected.length > 0) {
      const runtime = this.runtime();
      const call = (id: Id) =>
        effect === 'pause'
          ? runtime.pause(id, by)
          : effect === 'resume'
            ? runtime.resumeAgent(id, by)
            : runtime.stop(id, by);
      const results = await Promise.allSettled(affected.map(call));
      const failed = results.flatMap((r, i) =>
        r.status === 'rejected' ? [`${affected[i]}: ${(r.reason as Error).message}`] : [],
      );
      if (failed.length > 0) {
        // The state and the other agents' effects stand; the caller learns which agents refused.
        throw new DomainError(
          'conflict',
          `${action.action} reached not every agent: ${failed.join('; ')}`,
        );
      }
    }
    const events = [...own.events, ...this.effectEvents(since, affected, by)];
    return { value: undefined, events };
  }
}

/**
 * The policy of a standalone task's Steward that works inside one or more projects' workspaces
 * (the related project of its card, SPEC §3.5): per category the strictest of those projects'
 * tables and the global default, so borrowing a workspace never loosens anything. `undefined`
 * when the folder belongs to no live project (the global default applies).
 */
function relatedPolicy(
  tables: EventLog['tables'],
  task: Task,
  cwd: string,
): PermissionPolicy | undefined {
  const inside = (child: string, parent: string) => {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  const relatedId = task.meta?.['relatedProjectId'];
  const related = tables.projects
    .all()
    .filter(
      (p) =>
        p.state !== 'archived' &&
        (p.id === relatedId || inside(cwd, p.workspace) || inside(p.workspace, cwd)),
    );
  if (related.length === 0) return undefined;
  return related.reduce<PermissionPolicy>(
    (policy, p) => noLooserThan(p.permissionPolicy ?? policy, policy),
    resolvePolicy(),
  );
}
