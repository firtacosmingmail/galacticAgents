import { randomUUID } from 'node:crypto';
import {
  ENDED_STATES,
  HARNESS_META_KEY,
  isHarnessMeta,
  type Actor,
  type Agent,
  type AgentCaps,
  type AgentEvent,
  type AgentState,
  type HarnessActionResponse,
  type HarnessActivity,
  type HarnessActivityBody,
  type HarnessAgentBody,
  type HarnessAgentResponse,
  type HarnessClearResponse,
  type HarnessListResponse,
  type HarnessQuestionBody,
  type HarnessScenarioBody,
  type HarnessScenarioResponse,
  type HarnessState,
  type HarnessStateBody,
  type Id,
} from '@galactic/protocol';
import { checkPlacement, createAgent, recordSpawned } from '../domain/agents.js';
import { EARTH_ID } from '../domain/catalogue.js';
import type { Commands } from '../domain/commands.js';
import { DomainError, must } from '../domain/errors.js';
import type { CommandContext, EventLog } from '../domain/event-log.js';
import { FINISHED_WORK } from '../domain/states.js';
import { cancelQuestionsOf } from '../domain/questions.js';
import { DEFAULT_CAPS } from './caps.js';
import type { StatusStore } from './status-store.js';

/**
 * The scene harness (P4-06): drives the solar-system scene through the real event log, for the
 * Phase 4 exit criteria ("switching an agent's state in a test harness changes its satellite
 * within a second"; "moving a task to a project flies its satellite there") and for looking at
 * every state, activity, flight, landing and beacon without running agents. Development only:
 * the `/dev/harness/*` routes (`http/dev-routes.ts`) are registered with `GALACTIC_DEV=1` alone.
 *
 * Nothing here writes around the domain:
 * - **Fake agents** are agent rows made the way the runtime makes them (`createAgent` +
 *   `recordSpawned`, under the hierarchy's `checkPlacement`), flagged `meta.harness`, with no
 *   adapter session and no process. The status store folds their events like any agent's; the
 *   composition never lets one go `stalled` on its own and recovery ends one `stopped` instead of
 *   reopening it.
 * - **States and activities** are the agent events the runtime would log (`agent.progress`,
 *   `agent.tool_call`, `agent.idle`, `agent.paused`, …) through `Commands.recordAgentEvent`, which
 *   opens a permission question from `agent.needs_input` and settles an ending agent's questions
 *   exactly as the runtime does. So the status store, the work-state deriver and the client see
 *   real events; a status diff reaches the page within the store's 100 ms batch.
 * - **Work** (projects, tasks, moves, closes, questions, answers) goes through `Commands`.
 *
 * A harness project's Waykeeper and a harness asteroid's Stewards answer to a **dormant harness
 * Harmonizer**: an agent row that never runs (no session, no status record, `createdAt` at the
 * epoch so it is never "the newest Harmonizer"). It satisfies the hierarchy's placement rule
 * without making the real Harmonizer's brain wake on harness events (an LLM turn per fake
 * failure); being never alive, it holds no question (routing skips it to the user).
 */

export interface SceneHarnessOptions {
  log: EventLog;
  commands: Commands;
  statuses: StatusStore;
  /** Agents with a live adapter session (the runtime's): never given a fake ending. */
  liveSessions?: () => Agent[];
  caps?: AgentCaps;
}

const USER: Actor = { type: 'user' };

/** States in which a fake agent keeps its open questions (an ending settles them itself). */
const KEEPS_QUESTIONS: ReadonlySet<HarnessState> = new Set<HarnessState>([
  'waiting_for_input',
  'paused',
  'finished',
  'failed',
  'stopped',
]);

/** The tool call each activity preset logs (P4-03's archetypes read it from `currentActivity`). */
export const ACTIVITY_PRESETS: Record<HarnessActivity, { toolName: string; input: unknown }> = {
  gathering: { toolName: 'Grep', input: { pattern: 'TODO', path: 'src' } },
  transporting: { toolName: 'Bash', input: { command: 'git commit -m "harness: save work"' } },
  building: { toolName: 'Bash', input: { command: 'pnpm test' } },
  none: { toolName: 'TodoWrite', input: {} },
};

/** The working line of a fresh scenario's agents: a mix, so every archetype shows at once. */
const SCENARIO_ACTIVITIES: readonly HarnessActivity[] = ['gathering', 'building', 'transporting'];

const harnessMeta = (extra: Record<string, unknown> = {}) => ({
  [HARNESS_META_KEY]: true,
  ...extra,
});

export class SceneHarness {
  private readonly log: EventLog;
  private readonly commands: Commands;
  private readonly statuses: StatusStore;
  private readonly caps: AgentCaps;

  constructor(private readonly opts: SceneHarnessOptions) {
    this.log = opts.log;
    this.commands = opts.commands;
    this.statuses = opts.statuses;
    this.caps = opts.caps ?? DEFAULT_CAPS;
  }

  /** What the harness made that is not archived (the dormant Harmonizer is not listed). */
  list(): HarnessListResponse {
    const { tables } = this.log;
    return {
      projects: tables.projects
        .all()
        .filter((p) => isHarnessMeta(p.meta) && p.state !== 'archived')
        .map((p) => p.id),
      tasks: tables.tasks
        .all()
        .filter((t) => isHarnessMeta(t.meta) && t.state !== 'archived')
        .map((t) => t.id),
      agents: tables.agents
        .all()
        .filter((a) => isHarnessMeta(a.meta) && a.role !== 'harmonizer')
        .map((a) => a.id),
    };
  }

  /** A project with a Waykeeper and Stewards, plus a standalone task on an asteroid: all working. */
  async scenario(input: HarnessScenarioBody): Promise<HarnessScenarioResponse> {
    const stewards = input.stewards ?? 2;
    const n = this.log.tables.projects.all().filter((p) => isHarnessMeta(p.meta)).length + 1;
    const { value: project } = await this.commands.createProject(
      {
        name: `Harness project ${n}`,
        workspace: `/tmp/galactic-harness/project-${n}`,
        ...(input.bodyId ? { bodyId: input.bodyId } : { kind: input.kind ?? 'planet' }),
        meta: harnessMeta(),
      },
      { origin: 'local' },
    );
    const waykeeper = this.fake({ role: 'waykeeper', projectId: project.id });
    const taskIds: Id[] = [];
    const stewardIds: Id[] = [];
    for (let i = 0; i < stewards; i++) {
      const { value: task } = await this.commands.createTask({
        description: `Harness task ${n}.${i + 1}`,
        projectId: project.id,
        meta: harnessMeta(),
      });
      taskIds.push(task.id);
      stewardIds.push(this.fake({ role: 'steward', taskId: task.id }).id);
    }
    let asteroid: { taskId: Id; stewardId: Id } | undefined;
    if (input.asteroid ?? true) {
      const { value: task } = await this.commands.createTask({
        description: `Harness asteroid task ${n}`,
        meta: harnessMeta(),
      });
      asteroid = { taskId: task.id, stewardId: this.fake({ role: 'steward', taskId: task.id }).id };
    }
    await this.setState(waykeeper.id, { state: 'working', activity: 'Planning the next tasks' });
    const all = [...stewardIds, ...(asteroid ? [asteroid.stewardId] : [])];
    for (const [i, id] of all.entries()) {
      await this.setActivity(id, { preset: SCENARIO_ACTIVITIES[i % SCENARIO_ACTIVITIES.length]! });
    }
    return {
      seq: this.log.currentSeq(),
      projectId: project.id,
      bodyId: project.bodyId,
      waykeeperId: waykeeper.id,
      taskIds,
      stewardIds,
      ...(asteroid
        ? { asteroidTaskId: asteroid.taskId, asteroidStewardId: asteroid.stewardId }
        : {}),
    };
  }

  /**
   * A fake agent for existing work: a Waykeeper for a project; a Steward for a task, for a new
   * task of a project, or for a new standalone task on a fresh asteroid. It starts `starting`.
   */
  async createAgent(input: HarnessAgentBody): Promise<HarnessAgentResponse> {
    if (input.role === 'waykeeper') {
      if (!input.projectId) throw new DomainError('invalid', 'a Waykeeper needs a project');
      const agent = this.fake({ role: 'waykeeper', projectId: input.projectId });
      return { seq: this.log.currentSeq(), agentId: agent.id };
    }
    let taskId = input.taskId;
    if (!taskId) {
      const { value: task } = await this.commands.createTask({
        description: input.projectId ? 'Harness task' : 'Harness asteroid task',
        ...(input.projectId ? { projectId: input.projectId } : {}),
        meta: harnessMeta(),
      });
      taskId = task.id;
    }
    const agent = this.fake({ role: 'steward', taskId });
    return { seq: this.log.currentSeq(), agentId: agent.id, taskId };
  }

  /**
   * Puts an agent in a state with the event the runtime would log for it. An ended agent is
   * spawned again first (`agent.spawned`: the status store's only way out of an ended state); a
   * paused one is resumed first unless it is paused again. `waiting_for_input` asks a permission
   * question; `working` logs a progress line (`activity`, or a default).
   */
  async setState(agentId: Id, input: HarnessStateBody): Promise<HarnessActionResponse> {
    const agent = must(this.log.tables.agents.get(agentId), 'agent', agentId);
    if (agent.role === 'harmonizer' && isHarnessMeta(agent.meta)) {
      throw new DomainError('invalid', 'the dormant harness Harmonizer never runs');
    }
    const ending = ENDED_STATES.has(input.state);
    if (this.hasSession(agentId) && (ending || input.state === 'starting')) {
      throw new DomainError(
        'conflict',
        `agent ${agentId} has a live session: stop it from the panel, not from the harness`,
      );
    }
    let current: AgentState | undefined = this.statuses.get(agentId)?.state;
    if (current === undefined || ENDED_STATES.has(current) || input.state === 'starting') {
      await this.record(this.spawned(agent));
      current = 'starting';
    }
    if (current === 'paused' && input.state !== 'paused') {
      await this.record({ type: 'agent.resumed', agentId, by: USER });
    }
    // A fake agent that moves on from waiting no longer needs its open questions: they are
    // withdrawn (their beacons go out), as a session that stopped asking would leave none open.
    if (isHarnessMeta(agent.meta) && !KEEPS_QUESTIONS.has(input.state)) {
      this.log.runCommand((ctx) =>
        cancelQuestionsOf(ctx, agentId, 'the agent moved on (scene harness)'),
      );
    }
    switch (input.state) {
      case 'starting':
        break;
      case 'working':
        await this.record({
          type: 'agent.progress',
          agentId,
          summary: input.activity ?? 'Working (scene harness)',
        });
        break;
      case 'idle':
        await this.record({ type: 'agent.idle', agentId });
        break;
      case 'waiting_for_input':
        return this.ask(agentId, { kind: 'permission' });
      case 'paused':
        if (current !== 'paused') await this.record({ type: 'agent.paused', agentId, by: USER });
        break;
      case 'stalled':
        await this.record({ type: 'agent.stalled', agentId, silentForMs: 60_000 });
        break;
      case 'finished':
        await this.record({ type: 'agent.finished', agentId, result: 'Done (scene harness)' });
        break;
      case 'failed':
        await this.record({
          type: 'agent.failed',
          agentId,
          error: 'Failed (scene harness)',
          reason: 'crash',
        });
        break;
      case 'stopped':
        await this.record({ type: 'agent.stopped', agentId, by: USER });
        break;
    }
    return { seq: this.log.currentSeq() };
  }

  /** A working agent's activity: a preset tool call (one per archetype) or a progress line. */
  async setActivity(agentId: Id, input: HarnessActivityBody): Promise<HarnessActionResponse> {
    const agent = must(this.log.tables.agents.get(agentId), 'agent', agentId);
    const state = this.statuses.get(agentId)?.state;
    if (state === undefined || ENDED_STATES.has(state)) {
      if (this.hasSession(agentId)) {
        throw new DomainError('conflict', `agent ${agentId} has a live session`);
      }
      await this.record(this.spawned(agent));
    } else if (state === 'paused') {
      await this.record({ type: 'agent.resumed', agentId, by: USER });
    }
    if (input.preset) {
      const preset = ACTIVITY_PRESETS[input.preset];
      await this.record({
        type: 'agent.tool_call',
        agentId,
        toolName: preset.toolName,
        toolUseId: `harness-${randomUUID()}`,
        input: preset.input,
      });
    } else {
      await this.record({ type: 'agent.progress', agentId, summary: input.text! });
    }
    return { seq: this.log.currentSeq() };
  }

  /**
   * The agent asks the user. A permission takes the runtime's path (`agent.needs_input`, which
   * opens the routed question in the same command; permissions are always the user's). A
   * clarification is opened for the user (`toUser`) and the agent waits on it.
   */
  async ask(agentId: Id, input: HarnessQuestionBody): Promise<HarnessActionResponse> {
    const agent = must(this.log.tables.agents.get(agentId), 'agent', agentId);
    if (this.hasSession(agentId)) {
      throw new DomainError('conflict', `agent ${agentId} has a live session: it asks for itself`);
    }
    const state = this.statuses.get(agentId)?.state;
    if (state === undefined || ENDED_STATES.has(state)) await this.record(this.spawned(agent));
    else if (state === 'paused') await this.record({ type: 'agent.resumed', agentId, by: USER });
    if (input.kind === 'permission') {
      const questionId = `q-${randomUUID()}`;
      await this.record({
        type: 'agent.needs_input',
        agentId,
        questionId,
        kind: 'permission',
        question: {
          text: input.text ?? 'May Bash run `rm -rf build`? (scene harness)',
          toolCall: { toolName: 'Bash', input: { command: 'rm -rf build' } },
        },
      });
      return { seq: this.log.currentSeq(), questionId };
    }
    const text = input.text ?? 'Which colour should the button be? (scene harness)';
    const { value: question } = await this.commands.openQuestion({
      kind: 'clarification',
      originAgentId: agentId,
      context: { text, options: ['Blue', 'Green'] },
      toUser: true,
    });
    // The agent waits on it, as a session blocked on its question would (status: waiting).
    this.log.runCommand(({ emit }) =>
      emit({
        type: 'agent.needs_input',
        agentId,
        questionId: question.id,
        kind: 'clarification',
        question: { text, options: ['Blue', 'Green'] },
      }),
    );
    return { seq: this.log.currentSeq(), questionId: question.id };
  }

  /** The user answers (first answer wins; the agent goes back to work). */
  async answer(questionId: Id, answer?: string): Promise<HarnessActionResponse> {
    const question = must(this.log.tables.questions.get(questionId), 'question', questionId);
    await this.commands.answerQuestion({
      questionId,
      answer: answer ?? (question.kind === 'permission' ? 'allow' : 'Blue'),
      by: USER,
    });
    return { seq: this.log.currentSeq() };
  }

  /** A standalone task joins a project (its Stewards fly there, decision 9). */
  async move(taskId: Id, projectId: Id): Promise<HarnessActionResponse> {
    await this.commands.moveTask(taskId, projectId, USER);
    return { seq: this.log.currentSeq() };
  }

  /**
   * The task completes: its live fake Stewards finish (as a Steward reports done), then the task is
   * closed as the panel closes it (`control.close`). Its newest Steward lands (decision 77).
   */
  async complete(taskId: Id): Promise<HarnessActionResponse> {
    const task = must(this.log.tables.tasks.get(taskId), 'task', taskId);
    if (task.state === 'completed') {
      throw new DomainError('invalid_transition', `task ${taskId} is already completed`);
    }
    await this.finishFakes((a) => a.role === 'steward' && a.taskId === taskId);
    await this.commands.control({ kind: 'task', id: taskId }, { action: 'close' }, USER);
    return { seq: this.log.currentSeq() };
  }

  /**
   * The user closes the project (decision 11): its fake Waykeeper finishes, then `control.close`.
   * Unfinished tasks are left as they are (decision 75: Close leaves them).
   */
  async closeProject(projectId: Id): Promise<HarnessActionResponse> {
    must(this.log.tables.projects.get(projectId), 'project', projectId);
    await this.finishFakes((a) => a.role === 'waykeeper' && a.projectId === projectId);
    await this.commands.control({ kind: 'project', id: projectId }, { action: 'close' }, USER);
    return { seq: this.log.currentSeq() };
  }

  /**
   * Clears what the harness made: every fake agent still running is stopped, every harness task
   * is closed (when still open) and archived, then every harness project likewise — bodies are
   * freed, the scene and the navigation forget them. Real agents and work are never touched;
   * rows are never deleted (the log keeps the story).
   */
  async clear(): Promise<HarnessClearResponse> {
    const { tables } = this.log;
    const stopped: Id[] = [];
    const skipped: { id: Id; reason: string }[] = [];
    /** One step; a refusal is reported and the rest goes on (clear is best effort). */
    const attempt = async (id: Id, step: () => Promise<unknown>): Promise<boolean> => {
      try {
        await step();
        return true;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        skipped.push({ id, reason: error.message });
        return false;
      }
    };
    for (const agent of tables.agents.all()) {
      if (!isHarnessMeta(agent.meta) || agent.role === 'harmonizer') continue;
      const state = this.statuses.get(agent.id)?.state;
      if (state === undefined || ENDED_STATES.has(state)) continue;
      const ok = await attempt(agent.id, () =>
        this.record({ type: 'agent.stopped', agentId: agent.id, by: USER }),
      );
      if (ok) stopped.push(agent.id);
    }
    const tasks: Id[] = [];
    for (const task of tables.tasks.all()) {
      if (!isHarnessMeta(task.meta) || task.state === 'archived') continue;
      const ok = await attempt(task.id, async () => {
        if (!FINISHED_WORK.has(task.state) && task.state !== 'proposed') {
          await this.commands.closeTask(task.id, USER);
        }
        await this.commands.archiveTask(task.id, USER);
      });
      if (ok) tasks.push(task.id);
    }
    const projects: Id[] = [];
    // Sub-projects first: a parent is archived only once its children are finished.
    const own = tables.projects
      .all()
      .filter((p) => isHarnessMeta(p.meta) && p.state !== 'archived')
      .sort((a, b) => Number(Boolean(b.parentProjectId)) - Number(Boolean(a.parentProjectId)));
    for (const { id } of own) {
      const ok = await attempt(id, async () => {
        const state = tables.projects.get(id)!.state;
        if (!FINISHED_WORK.has(state) && state !== 'proposed') {
          await this.commands.closeProject(id, USER);
        }
        await this.commands.archiveProject(id, USER);
      });
      if (ok) projects.push(id);
    }
    return { seq: this.log.currentSeq(), stopped, tasks, projects, skipped };
  }

  // ---------------------------------------------------------------------------------------------

  private hasSession(agentId: Id): boolean {
    return (this.opts.liveSessions?.() ?? []).some((a) => a.id === agentId);
  }

  private async record(event: AgentEvent): Promise<void> {
    await this.commands.recordAgentEvent(event);
  }

  private spawned(agent: Agent): AgentEvent {
    return {
      type: 'agent.spawned',
      agentId: agent.id,
      role: agent.role,
      runtime: agent.runtime,
      bodyId: agent.bodyId,
      ...(agent.supervisorId ? { supervisorId: agent.supervisorId } : {}),
      ...(agent.taskId ? { taskId: agent.taskId } : {}),
      ...(agent.projectId ? { projectId: agent.projectId } : {}),
    };
  }

  /** Every live fake agent `which` selects finishes (a real session is left alone). */
  private async finishFakes(which: (a: Agent) => boolean): Promise<void> {
    for (const agent of this.log.tables.agents.all()) {
      if (!which(agent) || !isHarnessMeta(agent.meta) || this.hasSession(agent.id)) continue;
      const state = this.statuses.get(agent.id)?.state;
      if (state === undefined || ENDED_STATES.has(state)) continue;
      await this.record({
        type: 'agent.finished',
        agentId: agent.id,
        result: 'Done (scene harness)',
      });
    }
  }

  /**
   * A fake agent on its work, in one command: placed as the hierarchy prescribes (its supervisor:
   * the project's Waykeeper for a project task — a harness one, live or not —, else the dormant
   * harness Harmonizer), its row and `agent.created`, then `agent.spawned` (no session). Refused
   * while the work already has a running agent of that role.
   */
  private fake(input: { role: 'waykeeper' | 'steward'; projectId?: Id; taskId?: Id }): Agent {
    return this.log.runCommand((ctx) => {
      const { tables } = ctx;
      const task = input.taskId
        ? must(tables.tasks.get(input.taskId), 'task', input.taskId)
        : undefined;
      const projectId = input.role === 'waykeeper' ? input.projectId : task?.projectId;
      const project = projectId
        ? must(tables.projects.get(projectId), 'project', projectId)
        : undefined;
      if (task && FINISHED_WORK.has(task.state)) {
        throw new DomainError('invalid_transition', `task ${task.id} is ${task.state}`);
      }
      const sameWork = (a: Agent) =>
        a.role === input.role &&
        (input.role === 'waykeeper' ? a.projectId === projectId : a.taskId === task?.id);
      const running = tables.agents.all().find((a) => {
        if (!sameWork(a)) return false;
        const state = this.statuses.get(a.id)?.state;
        return state !== undefined && !ENDED_STATES.has(state);
      });
      if (running) {
        throw new DomainError(
          'conflict',
          `${input.role === 'waykeeper' ? `project ${projectId}` : `task ${task?.id}`} already has a running ${input.role} (${running.id})`,
        );
      }
      const supervisorId =
        input.role === 'steward' && projectId
          ? this.newestWaykeeper(ctx, projectId)
          : this.dormantHarmonizer(ctx).id;
      const placement = {
        role: input.role,
        supervisorId,
        ...(task ? { taskId: task.id } : {}),
        ...(projectId ? { projectId } : {}),
      };
      checkPlacement(ctx, placement);
      const bodyId = input.role === 'steward' ? task!.bodyId : project!.bodyId;
      const agent = createAgent(ctx, {
        ...placement,
        runtime: 'fake',
        caps: this.caps,
        bodyId,
        meta: harnessMeta(),
      });
      recordSpawned(ctx, agent, undefined);
      return agent;
    }).value;
  }

  /** A project task's Steward answers to the project's Waykeeper: the live one, else the newest. */
  private newestWaykeeper(ctx: CommandContext, projectId: Id): Id {
    const waykeepers = ctx.tables.agents
      .all()
      .filter((a) => a.role === 'waykeeper' && a.projectId === projectId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const live = waykeepers.find((a) => {
      const state = this.statuses.get(a.id)?.state;
      return state !== undefined && !ENDED_STATES.has(state);
    });
    const chosen = live ?? waykeepers[0];
    if (!chosen) {
      throw new DomainError('conflict', `project ${projectId} has no Waykeeper: create one first`);
    }
    return chosen.id;
  }

  /** The harness's own Harmonizer row: never spawned, created once, dated at the epoch. */
  private dormantHarmonizer(ctx: CommandContext): Agent {
    const existing = ctx.tables.agents
      .all()
      .find((a) => a.role === 'harmonizer' && isHarnessMeta(a.meta));
    if (existing) return existing;
    const agent: Agent = {
      id: `a-harness-hq-${randomUUID()}`,
      role: 'harmonizer',
      runtime: 'fake',
      bodyId: EARTH_ID,
      caps: this.caps,
      // Never "the newest Harmonizer" (a hand-over's fallback, the panel's Harmonizer).
      createdAt: new Date(0).toISOString(),
      updatedAt: ctx.now,
      meta: harnessMeta({ dormant: true }),
    };
    ctx.tables.agents.insert(agent);
    ctx.emit({ type: 'agent.created', agent });
    return agent;
  }
}
