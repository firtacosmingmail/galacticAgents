import type { EventEnvelope, Id, WorkState } from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import { canTransition, setProjectState, setTaskState } from '../domain/states.js';
import {
  ENDED_PHASES,
  deriveProjectState,
  deriveTaskState,
  type AgentFact,
  type AgentPhase,
  type WorkFacts,
} from '../domain/work-states.js';

/**
 * The task/project state projection (P2-15; SPEC §4.4, TECHNOLOGY §6.2). A log subscriber: after
 * each committed event it recomputes the tasks and projects the event concerns and, when the
 * derived state differs from the row, writes it through the domain command as a
 * `task.state_changed` / `project.state_changed` **without `by`** — so rows, snapshot and events
 * agree and the web reducer folds derived states like any other (no client-side derivation).
 *
 * It never loops: a state change it wrote only triggers the item's parent project (a task's
 * change) or nothing (a project's), and a recomputation that agrees with the row writes nothing.
 * It is idempotent on restart: `rebuild` replays the log into the agent-phase table without
 * writing, and `reconcile` then writes only what a crash between a commit and its derivation
 * left stale.
 */

interface AgentTrack {
  phase: AgentPhase;
  beforePause?: AgentPhase;
  endedSeq?: number;
  /** `seq` of its latest `agent.spawned` / `agent.resumed`: lifts an explicit hold set before it. */
  startedSeq: number;
  /** Where it was last seen (rows can change under `agent.updated`). */
  taskId?: Id;
  projectId?: Id;
}

export interface WorkStateDeriverOptions {
  onError?: (error: unknown) => void;
}

const key = (kind: 'task' | 'project', id: Id) => `${kind}:${id}`;

export class WorkStateDeriver {
  private readonly agents = new Map<Id, AgentTrack>();
  /** Items whose current state was set explicitly (with `by`), and at which `seq`. */
  private readonly holds = new Map<string, number>();
  /** Items touched by the commit being folded, derived when its last event arrives. */
  private readonly pendingTasks = new Set<Id>();
  private readonly pendingProjects = new Set<Id>();
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly log: EventLog,
    opts: WorkStateDeriverOptions = {},
  ) {
    this.onError = opts.onError ?? (() => {});
  }

  /** Replays a log into the agent and hold tables without deriving anything. */
  rebuild(events: Iterable<EventEnvelope>): void {
    this.agents.clear();
    this.holds.clear();
    for (const envelope of events) this.track(envelope);
  }

  /** Recomputes every task and project; writes only the ones whose row disagrees. */
  reconcile(): void {
    for (const task of this.log.tables.tasks.all()) this.deriveTask(task.id);
    for (const project of this.log.tables.projects.all()) this.deriveProject(project.id);
  }

  /** Wire as a log subscriber (after the status store's). */
  fold(envelope: EventEnvelope): void {
    const affected = this.affected(envelope);
    this.track(envelope);
    for (const id of affected.tasks) this.pendingTasks.add(id);
    for (const id of affected.projects) this.pendingProjects.add(id);
    // Derive only once the whole commit is folded: a command that sets a task and its project
    // explicitly (a cancel) must have both holds recorded before either is re-derived.
    if (envelope.seq < this.log.currentSeq()) return;
    const tasks = [...this.pendingTasks];
    const projects = [...this.pendingProjects];
    this.pendingTasks.clear();
    this.pendingProjects.clear();
    for (const id of tasks) this.deriveTask(id);
    for (const id of projects) this.deriveProject(id);
  }

  // -- facts -----------------------------------------------------------------------------------

  private track({ seq, event }: EventEnvelope): void {
    switch (event.type) {
      case 'agent.created':
        // Created, not yet spawned: like a stopped agent, it says nothing about the work.
        this.agents.set(event.agent.id, {
          phase: 'stopped',
          endedSeq: 0,
          startedSeq: 0,
          ...placement(event.agent),
        });
        return;
      case 'agent.updated': {
        const a = this.agents.get(event.agentId);
        if (!a) return;
        if (event.changes.taskId !== undefined) a.taskId = event.changes.taskId;
        if (event.changes.projectId !== undefined) a.projectId = event.changes.projectId;
        return;
      }
      case 'task.state_changed':
        if (event.by) this.holds.set(key('task', event.taskId), seq);
        else this.holds.delete(key('task', event.taskId));
        return;
      case 'project.state_changed':
        if (event.by) this.holds.set(key('project', event.projectId), seq);
        else this.holds.delete(key('project', event.projectId));
        return;
      case 'question.answered': {
        // The status store wakes a waiting agent on the answer; so does this table.
        const origin = this.log.tables.questions.get(event.questionId)?.originAgentId;
        const a = origin ? this.agents.get(origin) : undefined;
        if (a && !ENDED_PHASES.has(a.phase) && a.phase !== 'paused') a.phase = 'running';
        return;
      }
      default:
        break;
    }
    if (!event.type.startsWith('agent.') || !('agentId' in event)) return;
    let a = this.agents.get(event.agentId);
    if (!a) {
      // An agent whose `agent.created` was pruned from the log: placement from the row.
      const row = this.log.tables.agents.get(event.agentId);
      a = { phase: 'running', startedSeq: 0, ...(row ? placement(row) : {}) };
      this.agents.set(event.agentId, a);
    }
    const ended = ENDED_PHASES.has(a.phase);
    if (ended && event.type !== 'agent.spawned') return; // an ended agent is a sink (P1-17)
    const paused = a.phase === 'paused';
    const end = (phase: AgentPhase) => {
      a.phase = phase;
      a.endedSeq = seq;
      delete a.beforePause;
    };
    switch (event.type) {
      case 'agent.spawned':
        a.phase = 'running';
        a.startedSeq = seq;
        delete a.endedSeq;
        delete a.beforePause;
        return;
      case 'agent.tool_call':
      case 'agent.progress':
      case 'agent.needs_input':
      case 'agent.stalled':
        if (!paused) a.phase = 'running';
        return;
      case 'agent.idle':
        if (paused) a.beforePause = 'idle';
        else a.phase = 'idle';
        return;
      case 'agent.paused':
        if (!paused) a.beforePause = a.phase;
        a.phase = 'paused';
        return;
      case 'agent.resumed':
        a.phase = a.beforePause ?? 'running';
        a.startedSeq = seq;
        delete a.beforePause;
        return;
      case 'agent.finished':
        return end('finished');
      case 'agent.failed':
        return end('failed');
      case 'agent.stopped':
        return end('stopped');
      case 'agent.interrupted':
        return end('interrupted');
      default:
        return;
    }
  }

  /** The tasks and projects an event concerns (before it is tracked: old placements count). */
  private affected({ event }: EventEnvelope): { tasks: Set<Id>; projects: Set<Id> } {
    const tasks = new Set<Id>();
    const projects = new Set<Id>();
    const { tables } = this.log;
    const addTask = (taskId: Id | undefined) => {
      if (!taskId) return;
      tasks.add(taskId);
      const projectId = tables.tasks.get(taskId)?.projectId;
      if (projectId) projects.add(projectId);
    };
    const addAgent = (agentId: Id | undefined) => {
      if (!agentId) return;
      const tracked = this.agents.get(agentId);
      const row = tables.agents.get(agentId);
      for (const where of [tracked, row]) {
        addTask(where?.taskId);
        if (where?.projectId) projects.add(where.projectId);
      }
    };
    switch (event.type) {
      case 'question.opened':
        addAgent(event.question.originAgentId);
        break;
      case 'question.escalated':
      case 'question.reassigned':
      case 'question.answered':
      case 'question.cancelled':
        addAgent(tables.questions.get(event.questionId)?.originAgentId);
        break;
      case 'task.state_changed': {
        // Never the task itself (its own change must not re-trigger it): only its project.
        const projectId = tables.tasks.get(event.taskId)?.projectId;
        if (projectId) projects.add(projectId);
        break;
      }
      case 'task.created':
        if (event.task.projectId) projects.add(event.task.projectId);
        break;
      case 'task.updated':
        if (event.changes.projectId) projects.add(event.changes.projectId);
        break;
      default:
        if (event.type.startsWith('agent.') && 'agentId' in event) addAgent(event.agentId);
        else if (event.type === 'agent.created') addAgent(event.agent.id);
    }
    return { tasks, projects };
  }

  private factsOf(agentIds: Iterable<Id>): { agents: AgentFact[]; started: number; ids: Set<Id> } {
    const agents: AgentFact[] = [];
    const ids = new Set<Id>();
    let started = 0;
    for (const id of agentIds) {
      ids.add(id);
      const a = this.agents.get(id);
      if (!a) continue;
      agents.push({
        phase: a.phase,
        ...(a.endedSeq !== undefined ? { endedSeq: a.endedSeq } : {}),
      });
      started = Math.max(started, a.startedSeq);
    }
    return { agents, started, ids };
  }

  private userQuestions(agentIds: ReadonlySet<Id>): number {
    return this.log.tables.questions
      .all()
      .filter(
        (q) => q.status === 'open' && q.holder.type === 'user' && agentIds.has(q.originAgentId),
      ).length;
  }

  private isHeld(kind: 'task' | 'project', id: Id, started: number): boolean {
    const at = this.holds.get(key(kind, id));
    return at !== undefined && started <= at;
  }

  private deriveTask(taskId: Id): void {
    const task = this.log.tables.tasks.get(taskId);
    if (!task) return;
    const own = this.log.tables.agents
      .all()
      .filter((a) => a.taskId === taskId)
      .map((a) => a.id);
    const { agents, started, ids } = this.factsOf(own);
    const facts: WorkFacts = {
      current: task.state,
      held: this.isHeld('task', taskId, started),
      userQuestions: this.userQuestions(ids),
      agents,
    };
    this.write('task', taskId, task.state, deriveTaskState(facts));
  }

  private deriveProject(projectId: Id): void {
    const project = this.log.tables.projects.get(projectId);
    if (!project) return;
    const tasks = this.log.tables.tasks.all().filter((t) => t.projectId === projectId);
    const taskIds = new Set(tasks.map((t) => t.id));
    const all = this.log.tables.agents
      .all()
      .filter((a) => a.projectId === projectId || (a.taskId && taskIds.has(a.taskId)));
    // The project's own agents (the Waykeeper) speak for it directly; its tasks' agents through
    // their tasks' states — except for the user-held questions, which count wherever they are.
    const projectLevel = this.factsOf(all.filter((a) => !a.taskId).map((a) => a.id));
    const everyone = this.factsOf(all.map((a) => a.id));
    const facts: WorkFacts = {
      current: project.state,
      held: this.isHeld('project', projectId, everyone.started),
      userQuestions: this.userQuestions(everyone.ids),
      agents: projectLevel.agents,
      tasks: tasks.map((t) => t.state),
    };
    this.write('project', projectId, project.state, deriveProjectState(facts));
  }

  private write(kind: 'task' | 'project', id: Id, from: WorkState, to: WorkState): void {
    // A move the transition table lacks is left alone rather than forced: derivation proposes,
    // the table decides (the explicit commands and the derivation share one table).
    if (from === to || !canTransition(from, to)) return;
    try {
      this.log.runCommand((ctx) => {
        if (kind === 'task') setTaskState(ctx, id, to);
        else setProjectState(ctx, id, to);
      });
    } catch (error) {
      this.onError(error);
    }
  }
}

function placement(agent: { taskId?: Id | undefined; projectId?: Id | undefined }): {
  taskId?: Id;
  projectId?: Id;
} {
  return {
    ...(agent.taskId ? { taskId: agent.taskId } : {}),
    ...(agent.projectId ? { projectId: agent.projectId } : {}),
  };
}
