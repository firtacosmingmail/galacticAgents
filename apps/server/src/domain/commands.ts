import { randomUUID } from 'node:crypto';
import {
  AgentEvent,
  type Actor,
  type Agent,
  type AgentPlacement,
  type AnswerQuestionInput,
  type BodyRequest,
  type CommandResult,
  type ControlAction,
  type ControlTarget,
  type CreateProjectInput,
  type CreateProposalInput,
  type CreateTaskInput,
  type DomainCommands,
  type Event,
  type Host,
  type Id,
  type OpenQuestionInput,
  type ProposalDecision,
  type ReopenInput,
  type SpawnAgentInput,
  type WorkState,
} from '@galactic/protocol';
import type { SpawnRequest, SpawnResult } from '../runtime/agent-runtime.js';
import { checkPlacement, recordSpawned, updateAgent } from './agents.js';
import { assignBody, freeBody, moveHost, sweepMarkers } from './bodies.js';
import { agentEffect, agentsOf } from './cascade.js';
import { EARTH_ID, chooseBody, freeMoons, freePlanets, type ChooseOptions } from './catalogue.js';
import { recordControl } from './control.js';
import { DomainError, must } from './errors.js';
import type { CommandContext, EventLog } from './event-log.js';
import {
  archiveProject,
  closeProject,
  createProject,
  pinProject,
  reopenProject,
  updateProject,
  type ProjectChanges,
} from './projects.js';
import { createProposal, decideProposal } from './proposals.js';
import {
  endAgentQuestions,
  holdersNow,
  logRouting,
  openFromNeedsInput,
  openRouted,
  type QuestionRouting,
} from './question-service.js';
import { answerQuestion, checkAnswer, escalateQuestion, reassignQuestion } from './questions.js';
import { setProjectState, setTaskState } from './states.js';
import {
  archiveTask,
  closeTask,
  createTask,
  moveTask,
  pinTask,
  reopenTask,
  updateTask,
  type TaskChanges,
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
  answer(questionId: Id, answer: string, by: Actor): Promise<void>;
  /** Whether a live session asked the question and takes its answer through the adapter. */
  hasQuestion(questionId: Id): boolean;
  /** Agents with a live adapter session: whom a task or project control reaches (P2-14). */
  liveAgents?(): Agent[];
}

export interface CommandsOptions {
  log: EventLog;
  agents?: AgentControl;
  /** Question routing (P2-03); default: the log alone (liveness from lifecycle events). */
  questions?: QuestionRouting;
  /** Whether an agent still runs (the status store), for decision 10's Waykeeper-less planets. */
  isRunning?: (agentId: Id) => boolean;
}

const ENDINGS = new Set(['agent.finished', 'agent.failed', 'agent.stopped', 'agent.interrupted']);

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

  constructor(opts: CommandsOptions) {
    this.log = opts.log;
    this.agents = opts.agents;
    this.questions = opts.questions ?? logRouting(opts.log);
    this.choose = opts.isRunning ? { isRunning: opts.isRunning } : {};
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

  createProject(input: CreateProjectInput) {
    return this.run((ctx) => createProject(ctx, input, this.choose));
  }
  updateProject(projectId: Id, changes: ProjectChanges) {
    return this.run((ctx) => updateProject(ctx, projectId, changes));
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
    return this.run((ctx) => reopenProject(ctx, projectId, by, input));
  }
  createTask(input: CreateTaskInput) {
    return this.run((ctx) => createTask(ctx, input));
  }
  updateTask(taskId: Id, changes: TaskChanges) {
    return this.run((ctx) => updateTask(ctx, taskId, changes));
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
    return this.run((ctx) => moveTask(ctx, taskId, toProjectId, by));
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
    if (input.role === 'harmonizer') {
      const running = tables.agents
        .all()
        .find((a) => a.role === 'harmonizer' && this.questions.isLiving(a.id));
      if (running) {
        throw new DomainError('conflict', `the Harmonizer is already running (${running.id})`);
      }
      must(tables.bodies.get(EARTH_ID), 'body', EARTH_ID);
    }
    // Earth is the headquarters (SPEC §3.1): the Harmonizer orbits it without it hosting work, so
    // the reserved body is neither assigned nor occupied (P2-20).
    const bodyId =
      input.role === 'harmonizer'
        ? EARTH_ID
        : input.role === 'steward'
          ? task?.bodyId
          : project?.bodyId;

    const since = this.log.currentSeq();
    const result = await this.runtime().spawn({
      role: input.role,
      runtime: input.runtime,
      prompt: input.prompt,
      cwd,
      ...(project ? { workspace: project.workspace, projectId: project.id } : {}),
      ...(project?.permissionPolicy ? { permissionPolicy: project.permissionPolicy } : {}),
      ...(bodyId ? { bodyId } : {}),
      ...(task ? { taskId: task.id } : {}),
      ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
      ...(input.caps ? { caps: input.caps } : {}),
      ...(input.bare ? { bare: true } : {}),
      ...(input.tools ? { tools: input.tools } : {}),
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
    });
    if (!result.ok) throw new DomainError('conflict', result.reason);
    return { value: result.agent, events: this.eventsOf(since, result.agent.id) };
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
    return this.run((ctx) => createProposal(ctx, input));
  }
  decideProposal(proposalId: Id, decision: ProposalDecision, _by: Actor) {
    return this.run((ctx) => decideProposal(ctx, proposalId, decision));
  }

  // -- questions -------------------------------------------------------------------------------

  openQuestion(input: OpenQuestionInput) {
    return this.run((ctx) =>
      openRouted(ctx, { ...input, id: `q-${randomUUID()}` }, this.questions),
    );
  }

  /**
   * First answer wins (SPEC §2.6): refused with "already answered by …" when someone was first or
   * the question changed since `version`. A question a live session asked gets the answer through
   * its adapter before the log records it, so the log never holds an answer the agent did not
   * receive; any other open question is answered in the log alone.
   */
  async answerQuestion(input: AnswerQuestionInput) {
    const { questionId } = input;
    const answer = {
      questionId,
      answer: input.answer,
      answeredBy: input.by,
      ...(input.version !== undefined ? { version: input.version } : {}),
    };
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    checkAnswer(question, answer);
    if (!this.agents?.hasQuestion(questionId)) {
      return this.run((ctx) =>
        answerQuestion(ctx, { ...answer, holders: holdersNow(ctx, questionId, this.questions) }),
      );
    }
    const since = this.log.currentSeq();
    await this.agents!.answer(questionId, input.answer, input.by);
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

  // -- panel actions ---------------------------------------------------------------------------

  /**
   * A panel action (decision 11b). On an agent: stop/cancel, pause and resume through the runtime
   * (which records `control.*` itself). On a task or project: recorded with its domain effect.
   */
  async control(
    target: ControlTarget,
    action: ControlAction,
    by: Actor,
  ): Promise<CommandResult<void>> {
    if (target.kind === 'agent') {
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
    const own = await this.run((ctx) =>
      recordControl(ctx, target, action, by, { isLive: (id) => live.has(id) }),
    );
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
