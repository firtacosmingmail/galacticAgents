import { randomUUID } from 'node:crypto';
import type { Agent, AgentCaps, AgentRole, AgentRuntime, Body, Id } from '@galactic/protocol';
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
  now: string;
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
    createdAt: input.now,
    updatedAt: input.now,
    ...(input.supervisorId ? { supervisorId: input.supervisorId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
  };
  ctx.tables.agents.insert(agent);
  ctx.emit({ type: 'agent.created', agent });
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
  now: string,
): Agent {
  let current = agent;
  if (sessionRef && sessionRef !== agent.sessionRef) {
    current = ctx.tables.agents.upsert({ ...agent, sessionRef, updatedAt: now });
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
