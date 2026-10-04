import {
  ENDED_STATES,
  type Agent,
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
 * - `keepLanded` (P4-04, on in the scene): completed work keeps its satellite, `landed: true` —
 *   the newest Steward of a `completed` task, the newest Waykeeper of a `completed` project, once
 *   the agent is no longer live (it finished, or the close stopped it; `hasLanded`). It lands on
 *   the work's body, is drawn with the `finished` look whatever its record says (or without a
 *   record: the server drops ended records after a day, retention lasts longer, decision 4), and
 *   stays until the work is archived or reopened. The body itself is marked colonised by
 *   `colonies/` when its host is completed. At most `LANDED_PER_BODY` (the newest agents') are
 *   drawn per body.
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

/** What the scene draws (P4-02: failed agents and the HQ station; P4-04: landed satellites). */
export const SCENE_SATELLITES: Readonly<SatelliteListOptions> = {
  keepFailed: true,
  keepLanded: true,
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

/**
 * The newest agent that ran, per role and work (`steward:<taskId>`, `waykeeper:<projectId>`):
 * built once per list (`satelliteList`), so the "is it superseded?" question is a lookup, not a
 * scan of every agent per agent (O(agents) per list instead of O(agents²): a project with
 * hundreds of finished Stewards over its retention). "Ran": it has a status record or a session
 * (`ran`) — a Steward created and not started yet supersedes nothing, so it does not hide the
 * older landed (or failed) satellite before it has done anything.
 */
export type NewestAgents = ReadonlyMap<string, Agent>;

const workKey = (agent: Agent): string | undefined => {
  if (agent.role === 'steward') return agent.taskId && `steward:${agent.taskId}`;
  if (agent.role === 'waykeeper') return agent.projectId && `waykeeper:${agent.projectId}`;
  return undefined;
};

/** Whether an agent ran: a status record, or a session the adapter reported. */
const ran = (world: SatelliteWorld, agent: Agent): boolean =>
  world.statuses[agent.id] !== undefined || agent.sessionRef !== undefined;

export function newestAgents(world: SatelliteWorld): NewestAgents {
  const newest = new Map<string, Agent>();
  for (const agent of Object.values(world.agents)) {
    if (!agent || !ran(world, agent)) continue;
    const key = workKey(agent);
    if (!key) continue;
    const known = newest.get(key);
    if (!known || isNewer(agent, known)) newest.set(key, agent);
  }
  return newest;
}

/**
 * Whether an agent's work completed and its satellite lands (P4-04, decisions 4, 11): a Steward
 * whose task is `completed`, or a Waykeeper whose project is `completed`, that is no longer live
 * (finished, or stopped by the close — `control.close` stops the work's live agents) and is the
 * newest agent of its role on that work (`isSuperseded`: one landed satellite per task or
 * project, not one per attempt). The agent must have run (a status record or a session): a
 * Steward created and never started leaves nothing to land. An archived or reopened task, or
 * project, is not `completed`, so the satellite takes off or goes. `newest`: the list's index
 * (`newestAgents`), built here when not given.
 */
export function hasLanded(
  world: SatelliteWorld,
  agentId: Id,
  newest: NewestAgents = newestAgents(world),
): boolean {
  const agent = world.agents[agentId];
  if (!agent || agent.role === 'harmonizer' || isLive(world, agentId)) return false;
  if (!ran(world, agent)) return false;
  const completed =
    agent.role === 'steward'
      ? agent.taskId !== undefined && world.tasks[agent.taskId]?.state === 'completed'
      : agent.projectId !== undefined && world.projects[agent.projectId]?.state === 'completed';
  return completed && !isSuperseded(world, agentId, newest);
}

/** Newer: by `createdAt` (ISO timestamps compare as strings), then by id. */
function isNewer(a: { createdAt: string; id: Id }, b: { createdAt: string; id: Id }): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

/**
 * Whether a newer agent of the same role that ran has the agent's task (Steward) or project
 * (Waykeeper), live or ended: a respawned Steward supersedes the failed one for good — when the
 * replacement finishes or fails in turn, the old failure does not come back (the newest failure
 * is the one to show). A newer agent that has not run yet (no record, no session) does not
 * supersede it yet. `newest`: the list's index (`newestAgents`), built here when not given.
 */
export function isSuperseded(
  world: SatelliteWorld,
  agentId: Id,
  newest: NewestAgents = newestAgents(world),
): boolean {
  const agent = world.agents[agentId];
  if (!agent) return false;
  const key = workKey(agent);
  if (!key) return false;
  const top = newest.get(key);
  return top !== undefined && top.id !== agentId && isNewer(top, agent);
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
  newest?: NewestAgents,
): boolean {
  if (isLive(world, agentId)) return true;
  if (!options.keepLanded && !options.keepFailed) return false;
  const index = newest ?? newestAgents(world);
  // Landed first: a failed Steward of a task closed anyway lands with its completed work.
  if (options.keepLanded && hasLanded(world, agentId, index)) return true;
  const state = world.statuses[agentId]?.state;
  if (options.keepFailed && state === 'failed') {
    return !isSuperseded(world, agentId, index) && !isWorkOver(world, agentId);
  }
  return false;
}

/**
 * At most this many landed satellites per body (the newest agents'): a big project's planet
 * collects one landed Steward per completed task over its retention, and a surface covered in
 * dim satellites says nothing more than six do — the colonised lights and the labels still tell
 * the story. The rest are simply not drawn (same spirit as the beacons' cap).
 */
export const LANDED_PER_BODY = 6;

/**
 * The satellites of a world, by agent id (a stable order). One pass over the agents, plus the
 * `newestAgents` index built once; landed satellites beyond `LANDED_PER_BODY` on a body (the
 * oldest agents') are dropped.
 */
export function satelliteList(
  world: SatelliteWorld,
  options: SatelliteListOptions = {},
): SatelliteSpec[] {
  const newest = newestAgents(world);
  const specs: SatelliteSpec[] = [];
  const landedOn = new Map<Id, Agent[]>();
  for (const agentId of Object.keys(world.agents).sort()) {
    const agent = world.agents[agentId];
    const status = world.statuses[agentId];
    if (!agent || !showsSatellite(world, agentId, options, newest)) continue;
    if (agent.role === 'harmonizer' && !options.harmonizer) continue;
    // A live or failed agent has a record; a landed one may have outlived it (`hasLanded`).
    const landed = options.keepLanded === true && hasLanded(world, agentId, newest);
    if (!status && !landed) continue;
    const bodyId = workBody(world, agentId);
    if (!bodyId) continue;
    if (landed) {
      const on = landedOn.get(bodyId);
      if (on) on.push(agent);
      else landedOn.set(bodyId, [agent]);
    }
    specs.push({
      agentId,
      role: agent.role,
      bodyId,
      // Landed work takes the `finished` look (`STATE_LOOK`), whether the agent finished or the
      // close stopped it, and its activity is over.
      state: landed ? 'finished' : (status?.state ?? 'finished'),
      activity: landed ? undefined : status?.currentActivity,
      archetype: landed || !status ? undefined : deriveArchetype(agent.role, status), // P4-03
      landed,
      supervisorId: agent.supervisorId,
    });
  }
  let dropped: Set<Id> | undefined;
  for (const agents of landedOn.values()) {
    if (agents.length <= LANDED_PER_BODY) continue;
    agents.sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0));
    dropped ??= new Set();
    for (const a of agents.slice(LANDED_PER_BODY)) dropped.add(a.id);
  }
  const drop = dropped;
  return drop ? specs.filter((s) => !drop.has(s.agentId)) : specs;
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
