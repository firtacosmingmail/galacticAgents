import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentCaps,
  AgentPlacement,
  AgentRole,
  AgentRuntime,
  Body,
  Id,
} from '@galactic/protocol';
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
  let bodyId = input.bodyId;
  if (!bodyId) {
    const body: Body = {
      id: `b-${randomUUID()}`,
      kind: 'asteroid',
      name: `Asteroid ${id.slice(2, 10)}`,
    };
    ctx.tables.bodies.insert(body);
    ctx.emit({ type: 'body.created', body });
    bodyId = body.id;
  }
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

/**
 * Moves an agent in the hierarchy (P2-01): a new supervisor (an orphaned Steward re-parented, a
 * promotion hand-over), body, task or project. Unchanged fields are dropped; nothing left is a
 * no-op. A supervisor must exist, and no agent may end up supervising itself through the chain.
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
  const agent = ctx.tables.agents.upsert({ ...current, ...defined, updatedAt: ctx.now });
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
