import type { Id, WorkState } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { HARMONIZER, type Selection } from '../../state/selection.js';
import { agentsFor } from '../../console/hierarchy/shared.js';
import { currentHarmonizer } from '../../console/hierarchy/HierarchyConsole.js';
import { primaryAgent } from '../../panel/nav-model.js';
import { SUN_ANCHOR_ID } from '../anchors.js';

/**
 * What clicking a body does (P3-05; SPEC §4.1, §4.2, decision 53), as data:
 * - a planet or moon hosting a project selects the project's Waykeeper, an asteroid hosting a task
 *   selects the task's Steward — the newest live one, else the newest (the panel's navigation
 *   rule, `primaryAgent`);
 * - Earth, the headquarters, selects the Harmonizer (§4.2: "deselect, or click Earth");
 * - anything else — a free body, the Sun or the Moon (reserved), a body that only shows a "moved
 *   to …" marker, work no agent has started on yet — selects nothing: the scene shows what it is.
 * In every case the camera flies there; the camera never changes the selection (decision 64).
 */
export type BodyAction =
  | { kind: 'select'; bodyId: string; name: string; selection: Selection }
  | { kind: 'info'; bodyId: string; name: string; detail: string };

type World = Pick<WorldState, 'bodies' | 'projects' | 'tasks' | 'agents' | 'statuses'>;

/** The catalogue's Earth (migration 0005): the headquarters when no Harmonizer says otherwise. */
export const HEADQUARTERS_BODY_ID = 'b-earth';

/** The body the Harmonizer lives on: its agent's body, else the catalogue's Earth. */
export function headquartersBody(world: Pick<World, 'agents' | 'statuses'>): string {
  return currentHarmonizer(world)?.bodyId ?? HEADQUARTERS_BODY_ID;
}

/** A body's name as the scene shows it (the Sun has one even before the catalogue arrives). */
export function bodyName(world: Pick<World, 'bodies'>, bodyId: string): string {
  return world.bodies[bodyId]?.name ?? (bodyId === SUN_ANCHOR_ID ? 'Sun' : bodyId);
}

const stateText = (state: WorkState) => state.replace(/_/g, ' ');

export function bodyAction(world: World, bodyId: string): BodyAction {
  const body = world.bodies[bodyId];
  const name = bodyName(world, bodyId);
  const info = (detail: string): BodyAction => ({ kind: 'info', bodyId, name, detail });
  if (bodyId === headquartersBody(world)) {
    return { kind: 'select', bodyId, name, selection: HARMONIZER };
  }
  if (!body) return info(bodyId === SUN_ANCHOR_ID ? 'reserved — the Sun' : 'not in the catalogue');
  const host = body.host;
  if (host?.kind === 'project') {
    const project = world.projects[host.id];
    const agent = primaryAgent(world, agentsFor(world, { projectId: host.id }));
    if (agent)
      return { kind: 'select', bodyId, name, selection: { kind: 'waykeeper', id: agent.id } };
    return info(
      project
        ? `${project.name} · ${stateText(project.state)} · no agent yet`
        : 'project not loaded',
    );
  }
  if (host?.kind === 'task') {
    const task = world.tasks[host.id];
    const agent = primaryAgent(world, agentsFor(world, { taskId: host.id }));
    if (agent)
      return { kind: 'select', bodyId, name, selection: { kind: 'steward', id: agent.id } };
    return info(
      task ? `${task.description} · ${stateText(task.state)} · no agent yet` : 'task not loaded',
    );
  }
  if (body.movedTo) return info(`moved to ${bodyName(world, body.movedTo.bodyId)}`);
  if (body.kind === 'star') return info('reserved — the Sun');
  if (body.meta?.['reserved'] === true) return info('reserved — headquarters');
  return info('free');
}

/**
 * The body a selection is about, for the selection ring and the panel → scene flight: the Harmonizer's
 * headquarters; a Waykeeper's project's body; a Steward's task's body (a project task lives on
 * its project's body). Falls back to the agent's own `bodyId`; `undefined` for an unknown agent.
 */
export function selectionBody(world: World, selection: Selection): string | undefined {
  if (selection.kind === 'harmonizer') return headquartersBody(world);
  const agent = world.agents[selection.id];
  if (!agent) return undefined;
  const fromWork = (id: Id | undefined, map: Record<Id, { bodyId: Id }>) =>
    id ? map[id]?.bodyId : undefined;
  if (agent.role === 'waykeeper') return fromWork(agent.projectId, world.projects) ?? agent.bodyId;
  if (agent.role === 'steward') return fromWork(agent.taskId, world.tasks) ?? agent.bodyId;
  return agent.bodyId;
}

/**
 * The body the postprocessing outline draws for a selection: the selection's body, except for the
 * Harmonizer (the default selection). Earth keeps its ring but gets no outline, because a non-empty
 * outline selection costs a depth pass over the whole scene every frame (about +68 draw calls at
 * the high tier's system view), which the default view should not pay.
 */
export function outlineBody(world: World, selection: Selection): string | undefined {
  return selection.kind === 'harmonizer' ? undefined : selectionBody(world, selection);
}
