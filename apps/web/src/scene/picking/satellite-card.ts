import { ENDED_STATES, type AgentState, type Id } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { HARMONIZER, type Selection } from '../../state/selection.js';
import { agentLabel } from '../../console/hierarchy/shared.js';
import type { SatelliteMode } from '../satellites/machine.js';
import { bodyName } from './body-action.js';

/**
 * What hovering a satellite says (P4-08), as data: who the agent is, how it is, and a one-line
 * title of what it is doing. No three.js, no React.
 *
 * - `name`: the panel's own agent name (`agentLabel`): "Waykeeper · Big project",
 *   "Steward · <the task's description, shortened>";
 * - `state`: `StatusRecord.state`, drawn as the panel's state pill (same words, same colours);
 * - `activity`: `StatusRecord.currentActivity` on one line, cut at a word near `ACTIVITY_CHARS`;
 *   without one, what the agent cards say ("no activity yet", or "not running" once it ended);
 *   a landed satellite (P4-04) says "work completed";
 * - `where`: the body it orbits, and what the satellite is doing when that is not plain orbiting
 *   ("scanning · Jupiter", "flying to Saturn").
 */
export interface SatelliteCard {
  agentId: Id;
  name: string;
  state: AgentState | undefined;
  activity: string;
  where: string;
}

type World = Pick<WorldState, 'agents' | 'statuses' | 'projects' | 'tasks' | 'bodies'>;

/** The activity line's length before it is cut (the card is about 300 px wide). */
export const ACTIVITY_CHARS = 90;

/** One line, at most `max` characters: cut at the last word boundary when there is a near one. */
export function oneLine(text: string, max = ACTIVITY_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  const head = space >= max * 0.6 ? cut.slice(0, space) : cut;
  return `${head.replace(/[\s.,;:–-]+$/, '')}…`;
}

export function satelliteCard(
  world: World,
  agentId: Id,
  frame?: { bodyId: Id; mode: SatelliteMode } | undefined,
): SatelliteCard {
  const agent = world.agents[agentId];
  const status = world.statuses[agentId];
  const state = status?.state;
  const raw = status?.currentActivity?.trim();
  const mode = frame?.mode;
  // P4-04: a landed satellite is completed work, whatever its agent's record still says.
  const landed = mode === 'landing' || mode === 'landed';
  const activity = landed
    ? 'work completed'
    : raw
      ? oneLine(raw)
      : state && ENDED_STATES.has(state)
        ? 'not running'
        : 'no activity yet';
  const bodyId = frame?.bodyId ?? agent?.bodyId;
  const body = bodyId ? bodyName(world, bodyId) : undefined;
  let where = body ?? '';
  if (mode === 'flying') where = body ? `flying to ${body}` : 'flying';
  else if (mode && mode !== 'orbiting') where = body ? `${mode} · ${body}` : mode;
  return { agentId, name: agentLabel(agent, world), state, activity, where };
}

/** What clicking a satellite selects: its agent (decision 53); `undefined` for an unknown one. */
export function satelliteSelection(
  world: Pick<WorldState, 'agents'>,
  agentId: Id,
): Selection | undefined {
  const role = world.agents[agentId]?.role;
  if (role === 'waykeeper' || role === 'steward') return { kind: role, id: agentId };
  return role === 'harmonizer' ? HARMONIZER : undefined;
}
