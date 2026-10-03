import {
  ENDED_STATES,
  type AgentRole,
  type AgentState,
  type Id,
  type WorkState,
} from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { HEADQUARTERS_BODY_ID } from '../picking/body-action.js';
import type { ActivityArchetype } from './machine.js';
import { deriveArchetype } from './archetype.js';

/**
 * Which satellites the scene draws (P4-01; SPEC §4.1, decisions 9, 53). No three.js.
 *
 * One satellite per **live** Waykeeper and Steward: the agent has a status record (the server's
 * projection, TECHNOLOGY §4) whose state is not an ended one (`ENDED_STATES`: finished, failed,
 * stopped, interrupted). An agent that ends loses its satellite; an agent never started (no
 * record) has none yet. The rule is one predicate, `showsSatellite`, with two switches (off by
 * default; the scene's own choice is `SCENE_SATELLITES`):
 * - `keepFailed` (P4-02, on in the scene): a `failed` agent keeps its satellite, drawn in its
 *   failure colour (`look.ts`), until a newer agent of the same role is given its work (a
 *   respawned Steward on the task, a new Waykeeper on the project — live or not, so the old
 *   failure never comes back when the replacement ends: `isSuperseded`) or its work is over (task
 *   completed, archived or moved; project closed, archived, moved or cancelled: `isWorkOver`);
 * - `keepLanded` (P4-04): a `finished` Steward whose task is `completed` keeps its satellite,
 *   `landed: true`, while the server retains its record (the satellite lands and the body is
 *   colonised).
 *
 * Its body is the body of its work — a Waykeeper's project's body, a Steward's task's body (a
 * project task lives on the project's body, decision 9) — falling back to the agent's own `bodyId`
 * while the work row is not loaded. When work moves (`body.moved`), the server points the task or
 * project, and the agents working on it, at the new body; the spec's `bodyId` changes and the
 * actor flies there (`machine.ts`).
 *
 * The Harmonizer's HQ station (P4-02, `hq/`) orbits Earth: `harmonizer: true` adds it to the
 * list, on the headquarters body (on in the scene).
 */
export interface SatelliteSpec {
  agentId: Id;
  role: AgentRole;
  bodyId: Id;
  state: AgentState;
  /** `StatusRecord.currentActivity` (raw; P4-03 derives the archetype from it). */
  activity: string | undefined;
  /** The archetype the machine is driven with (P4-03 fills it; `undefined` for now). */
  archetype: ActivityArchetype | undefined;
  /** P4-04: the work completed and the satellite lands (only with `keepLanded`, `hasLanded`). */
  landed: boolean;
  /** The agent's supervisor (a Steward's Waykeeper): P4-03's transport shuttles fly to it. */
  supervisorId: Id | undefined;
}

export type SatelliteWorld = Pick<WorldState, 'agents' | 'statuses' | 'tasks' | 'projects'>;

/** Which ended agents keep a satellite (both off by default: today only live agents show). */
export interface SatelliteRuleOptions {
  /** P4-02: a `failed` agent keeps its satellite (shown in its failure colour). */
  keepFailed?: boolean;
  /** P4-04: a `finished` Steward whose task is `completed` keeps its satellite, landed. */
  keepLanded?: boolean;
}

export interface SatelliteListOptions extends SatelliteRuleOptions {
  /** P4-02: include the Harmonizer's HQ station, orbiting Earth. */
  harmonizer?: boolean;
}

/** What the scene draws (P4-02: failed agents and the HQ station; P4-04 adds `keepLanded`). */
export const SCENE_SATELLITES: Readonly<SatelliteListOptions> = {
  keepFailed: true,
  harmonizer: true,
};

/** The body an agent's satellite belongs to. */
export function workBody(world: SatelliteWorld, agentId: Id): Id | undefined {
  const agent = world.agents[agentId];
  if (!agent) return undefined;
  switch (agent.role) {
    case 'harmonizer':
      return HEADQUARTERS_BODY_ID;
    case 'waykeeper':
      return (agent.projectId && world.projects[agent.projectId]?.bodyId) || agent.bodyId;
    case 'steward':
      return (agent.taskId && world.tasks[agent.taskId]?.bodyId) || agent.bodyId;
  }
}

/** Whether an agent is live: a status record in a state that is not an ended one. */
export function isLive(world: SatelliteWorld, agentId: Id): boolean {
  const status = world.statuses[agentId];
  return status !== undefined && !ENDED_STATES.has(status.state);
}

/** Whether an agent's work completed and its satellite lands: a finished Steward, task completed. */
export function hasLanded(world: SatelliteWorld, agentId: Id): boolean {
  const agent = world.agents[agentId];
  const status = world.statuses[agentId];
  if (agent?.role !== 'steward' || status?.state !== 'finished' || !agent.taskId) return false;
  return world.tasks[agent.taskId]?.state === 'completed';
}

/** Newer: by `createdAt` (ISO timestamps compare as strings), then by id. */
function isNewer(a: { createdAt: string; id: Id }, b: { createdAt: string; id: Id }): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

/**
 * Whether a newer agent of the same role has the failed agent's task (Steward) or project
 * (Waykeeper), live or not: a respawned Steward supersedes the failed one for good — when the
 * replacement finishes or fails in turn, the old failure does not come back (the newest failure
 * is the one to show).
 */
export function isSuperseded(world: SatelliteWorld, agentId: Id): boolean {
  const agent = world.agents[agentId];
  if (!agent || agent.role === 'harmonizer') return false;
  const key = agent.role === 'steward' ? 'taskId' : 'projectId';
  const work = agent[key];
  if (!work) return false;
  return Object.values(world.agents).some(
    (other) =>
      other !== undefined &&
      other.id !== agentId &&
      other.role === agent.role &&
      other[key] === work &&
      isNewer(other, agent),
  );
}

/**
 * Work states after which a failed agent's satellite is no longer shown. A project that failed
 * was cancelled (derivation never fails a project, SPEC §4.4); a task's own `failed` is what its
 * failed Steward made it (the latest ended Steward decides), so it does not count — a cancel stops
 * a live Steward (`stopped`, no satellite) and is refused on a task that already failed.
 */
const TASK_OVER: ReadonlySet<WorkState> = new Set<WorkState>(['completed', 'archived', 'moved']);
const PROJECT_OVER: ReadonlySet<WorkState> = new Set<WorkState>([
  'completed',
  'archived',
  'moved',
  'failed',
]);

/** Whether a failed agent's work is over: its task or project closed, cancelled or moved. */
export function isWorkOver(world: SatelliteWorld, agentId: Id): boolean {
  const agent = world.agents[agentId];
  if (!agent) return false;
  const projectOver = (projectId: Id | undefined) => {
    const state = projectId ? world.projects[projectId]?.state : undefined;
    return state !== undefined && PROJECT_OVER.has(state);
  };
  switch (agent.role) {
    case 'harmonizer':
      return false;
    case 'waykeeper':
      return projectOver(agent.projectId);
    case 'steward': {
      const task = agent.taskId ? world.tasks[agent.taskId] : undefined;
      if (task && TASK_OVER.has(task.state)) return true;
      return projectOver(task?.projectId);
    }
  }
}

/**
 * The list rule: whether an agent has a satellite. A live agent always does; an ended one only
 * when an option keeps it (`failed` with `keepFailed`, landed with `keepLanded`).
 */
export function showsSatellite(
  world: SatelliteWorld,
  agentId: Id,
  options: SatelliteRuleOptions = {},
): boolean {
  if (isLive(world, agentId)) return true;
  const state = world.statuses[agentId]?.state;
  if (options.keepFailed && state === 'failed') {
    return !isSuperseded(world, agentId) && !isWorkOver(world, agentId);
  }
  return options.keepLanded === true && hasLanded(world, agentId);
}

/** The satellites of a world, by agent id (a stable order). */
export function satelliteList(
  world: SatelliteWorld,
  options: SatelliteListOptions = {},
): SatelliteSpec[] {
  const specs: SatelliteSpec[] = [];
  for (const agentId of Object.keys(world.agents).sort()) {
    const agent = world.agents[agentId];
    const status = world.statuses[agentId];
    if (!agent || !status || !showsSatellite(world, agentId, options)) continue;
    if (agent.role === 'harmonizer' && !options.harmonizer) continue;
    const bodyId = workBody(world, agentId);
    if (!bodyId) continue;
    specs.push({
      agentId,
      role: agent.role,
      bodyId,
      state: status.state,
      activity: status.currentActivity,
      archetype: deriveArchetype(agent.role, status), // P4-03 (`archetype.ts`)
      landed: options.keepLanded === true && hasLanded(world, agentId),
      supervisorId: agent.supervisorId,
    });
  }
  return specs;
}

/** Two lists draw the same thing (keeps the scene from re-rendering on unrelated world changes). */
export function sameSatellites(a: readonly SatelliteSpec[], b: readonly SatelliteSpec[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i];
    return (
      t !== undefined &&
      s.agentId === t.agentId &&
      s.role === t.role &&
      s.bodyId === t.bodyId &&
      s.state === t.state &&
      s.activity === t.activity &&
      s.archetype === t.archetype &&
      s.landed === t.landed &&
      s.supervisorId === t.supervisorId
    );
  });
}
