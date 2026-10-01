import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentCaps,
  AgentPlacement,
  AgentRole,
  AgentRuntime,
  Id,
} from '@galactic/protocol';
import { EARTH_ID, createAsteroid, type Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';

/**
 * Agent-row commands (P1-21). Each runs inside `EventLog.runCommand` and emits the events that
 * fully describe its mutation (TECHNOLOGY §6.2), so a replaying client builds the same rows as
 * a snapshotting one. Phase 2's `spawnAgent` command composes `createAgent` with the body and
 * task bookkeeping; the Phase 1 runtime calls it directly.
 */

export interface CreateAgentInput {
  role: AgentRole;
  runtime: AgentRuntime;
  caps: AgentCaps;
  /** The body the agent orbits. Absent (Phase 1 ops console): a procedural asteroid is created. */
  bodyId?: Id;
  supervisorId?: Id;
  taskId?: Id;
  projectId?: Id;
  /** A fixed id (tests, resume); default: generated. */
  agentId?: Id;
  /**
   * What the resume path needs to reopen the session (P1-14): the working directory, the
   * workspace root and the prompt. Kept in `meta` (corner case 20) until tasks and projects
   * carry them in Phase 2.
   */
  meta?: Record<string, unknown>;
}

/** Inserts the agent row (and, when no body is given, its procedural asteroid). */
export function createAgent(ctx: CommandContext, input: CreateAgentInput): Agent {
  const id = input.agentId ?? `a-${randomUUID()}`;
  const bodyId = input.bodyId ?? createAsteroid(ctx).id;
  const agent: Agent = {
    id,
    role: input.role,
    runtime: input.runtime,
    bodyId,
    caps: input.caps,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  ctx.tables.agents.insert(agent);
  ctx.emit({ type: 'agent.created', agent });
  return agent;
}

/** What the hierarchy rules look at: an agent's role and placement (a row, or one to be). */
export type Placed = Pick<Agent, 'role'> &
  Partial<Pick<Agent, 'id' | 'supervisorId' | 'taskId' | 'projectId'>>;

/**
 * The supervisor the hierarchy prescribes for `agent` (P2-20; SPEC §2, decision 6), as a
 * predicate on candidate agents plus a description for refusals. A Waykeeper answers to the
 * Harmonizer — or, for a sub-project, to its parent project's Waykeeper (SPEC §3.2); a project
 * Steward to its project's Waykeeper; an asteroid Steward to the Harmonizer. Undefined for the
 * Harmonizer, who answers to the user alone.
 */
function prescribedSupervisor(
  ctx: Reader,
  agent: Placed,
): { matches: (s: Agent) => boolean; what: string } | undefined {
  const waykeeperOf = (projectId: Id) => ({
    matches: (s: Agent) => s.role === 'waykeeper' && s.projectId === projectId,
    what: `the Waykeeper of project ${projectId}`,
  });
  const harmonizer = { matches: (s: Agent) => s.role === 'harmonizer', what: 'the Harmonizer' };
  switch (agent.role) {
    case 'harmonizer':
      return undefined;
    case 'waykeeper': {
      const project = must(ctx.tables.projects.get(agent.projectId!), 'project', agent.projectId!);
      return project.parentProjectId ? waykeeperOf(project.parentProjectId) : harmonizer;
    }
    case 'steward': {
      const task = must(ctx.tables.tasks.get(agent.taskId!), 'task', agent.taskId!);
      return task.projectId ? waykeeperOf(task.projectId) : harmonizer;
    }
  }
}

/**
 * The placement invariants (P2-20; SPEC §2, decisions 6, 24), checked by `spawnAgent` before a
 * session opens and by `updateAgent` on the row it would write:
 * - the Harmonizer has no supervisor, task or project (and lives on Earth: `spawnAgent` puts it
 *   there, `updateAgent` never moves it);
 * - a Waykeeper runs a project and no task; a Steward runs a task, and its `projectId` is the
 *   task's project (absent for an asteroid task);
 * - a Waykeeper or Steward always has a supervisor, and it is the one the hierarchy prescribes:
 *   matched by role and project (any Harmonizer; the Waykeeper of that project), not by liveness —
 *   an orphan's questions go to the next living supervisor (P2-03), its row keeps its supervisor.
 */
export function checkPlacement(ctx: Reader, agent: Placed): void {
  const who = agent.id ? `agent ${agent.id}` : `the new ${agent.role}`;
  if (agent.role === 'harmonizer') {
    if (agent.supervisorId) throw new DomainError('invalid', 'the Harmonizer has no supervisor');
    if (agent.taskId || agent.projectId) {
      throw new DomainError('invalid', 'the Harmonizer runs no task or project');
    }
    return;
  }
  if (agent.role === 'waykeeper') {
    if (!agent.projectId) throw new DomainError('invalid', 'a Waykeeper needs a project');
    if (agent.taskId) throw new DomainError('invalid', 'a Waykeeper runs a project, not a task');
  } else {
    if (!agent.taskId) throw new DomainError('invalid', 'a Steward needs a task');
    const task = must(ctx.tables.tasks.get(agent.taskId), 'task', agent.taskId);
    if (task.projectId !== agent.projectId) {
      throw new DomainError(
        'invalid',
        task.projectId
          ? `${who}'s task ${task.id} belongs to project ${task.projectId}`
          : `${who}'s task ${task.id} is a standalone task, outside any project`,
      );
    }
  }
  const rule = prescribedSupervisor(ctx, agent)!;
  if (!agent.supervisorId) {
    throw new DomainError('invalid', `${who} needs a supervisor: ${rule.what}`);
  }
  const supervisor = must(ctx.tables.agents.get(agent.supervisorId), 'agent', agent.supervisorId);
  if (!rule.matches(supervisor)) {
    throw new DomainError(
      'invalid',
      `${who} answers to ${rule.what}, not to ${supervisor.role} ${supervisor.id}`,
    );
  }
}

/**
 * Moves an agent in the hierarchy (P2-01): a new supervisor (a promotion hand-over, a resumed
 * Waykeeper), body, task or project. Unchanged fields are dropped; nothing left is a no-op. A
 * supervisor must exist, and no agent may end up supervising itself through the chain. A change
 * of supervisor, task or project must leave the row within the placement invariants
 * (`checkPlacement`, P2-20); the Harmonizer never leaves Earth.
 */
export function updateAgent(ctx: CommandContext, agentId: Id, changes: AgentPlacement): Agent {
  const current = must(ctx.tables.agents.get(agentId), 'agent', agentId);
  const defined = Object.fromEntries(
    Object.entries(changes).filter(
      ([k, v]) => v !== undefined && v !== current[k as keyof AgentPlacement],
    ),
  ) as AgentPlacement;
  if (defined.supervisorId) {
    for (let id: Id | undefined = defined.supervisorId; id;) {
      if (id === agentId) {
        throw new DomainError('invalid', `agent ${agentId} would supervise itself`);
      }
      id = must(ctx.tables.agents.get(id), 'agent', id).supervisorId;
    }
  }
  if (defined.bodyId) must(ctx.tables.bodies.get(defined.bodyId), 'body', defined.bodyId);
  if (defined.taskId) must(ctx.tables.tasks.get(defined.taskId), 'task', defined.taskId);
  if (defined.projectId) {
    must(ctx.tables.projects.get(defined.projectId), 'project', defined.projectId);
  }
  if (Object.keys(defined).length === 0) return current;
  if (current.role === 'harmonizer' && defined.bodyId && defined.bodyId !== EARTH_ID) {
    throw new DomainError('invalid', 'the Harmonizer lives on Earth');
  }
  const next = { ...current, ...defined };
  if (
    'supervisorId' in defined ||
    'taskId' in defined ||
    'projectId' in defined
  ) {
    checkPlacement(ctx, next);
  }
  const agent = ctx.tables.agents.upsert({ ...next, updatedAt: ctx.now });
  ctx.emit({ type: 'agent.updated', agentId, changes: defined });
  return agent;
}

/**
 * The adapter's session is open: the row remembers the ref and `agent.spawned` reports the
 * session — one command, so the row and the log can never disagree about the session ref.
 */
export function recordSpawned(
  ctx: CommandContext,
  agent: Agent,
  sessionRef: string | undefined,
): Agent {
  let current = agent;
  if (sessionRef && sessionRef !== agent.sessionRef) {
    current = ctx.tables.agents.upsert({ ...agent, sessionRef, updatedAt: ctx.now });
  }
  ctx.emit({
    type: 'agent.spawned',
    agentId: current.id,
    role: current.role,
    runtime: current.runtime,
    bodyId: current.bodyId,
    ...(current.sessionRef ? { sessionRef: current.sessionRef } : {}),
    ...(current.supervisorId ? { supervisorId: current.supervisorId } : {}),
    ...(current.taskId ? { taskId: current.taskId } : {}),
    ...(current.projectId ? { projectId: current.projectId } : {}),
  });
  return current;
}
