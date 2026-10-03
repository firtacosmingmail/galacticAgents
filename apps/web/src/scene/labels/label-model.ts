import type { Body, Host, WorkState } from '@galactic/protocol';
import type { WorldState } from '../../state/reduce.js';
import { bodyName } from '../picking/body-action.js';

/**
 * The scene's domain labels as data (P3-07; SPEC §3.1, §3.2, §4.1, §4.4, decisions 9, 10, 15).
 * No three.js and no DOM: the label layer (`LabelLayer.tsx`) renders what this returns, the
 * projector (`LabelProjector.tsx`) places it.
 *
 * Which bodies get a label:
 * - a body hosting a project (planet or moon) or a task (asteroid): the work's name and its state
 *   (the server's derived state, P2-15), as a compact pill;
 * - a body that only shows a "moved to …" marker (decision 15): the work that left and where to;
 * - nothing else: free bodies, and the reserved ones (the Sun, Earth — the headquarters, which
 *   picking already maps to the Harmonizer — and Earth's Moon) stay unlabelled.
 *
 * A moon hosting a project says which of the two occupants of decision 10 it is: a sub-project
 * reads as part of its parent ("↳ part of <parent>"), an independent small project carries an
 * "own project" badge (and a ring in the scene, `MoonMarkers.tsx`).
 */
export type LabelTone = 'beacon' | 'active' | 'waiting' | 'warn' | 'fail' | 'done';

export type MoonRole = 'sub-project' | 'independent';

export interface BodyLabel {
  bodyId: string;
  /** What the label is about: hosted work, or the marker left by work that moved away. */
  kind: 'project' | 'task' | 'moved';
  /** The work's name, shortened for the label (`fullTitle` is the tooltip). */
  title: string;
  fullTitle: string;
  /** The work's state; `undefined` while the work is not loaded. */
  state: WorkState | undefined;
  /** The pill's text ("in progress", "blocked on you", "moved to Jupiter", "✓ completed"). */
  stateText: string;
  tone: LabelTone;
  /** For a moon hosting a project: a sub-project of its planet's project, or a project of its own. */
  moon?: MoonRole;
  /** For a sub-project: the parent project's name. */
  partOf?: string;
  /** For a "moved to …" marker: the body the work went to. */
  movedTo?: { bodyId: string; name: string };
  /** The body is the selected agent's body. */
  selected: boolean;
  /** De-clutter rank (higher wins an overlap): `labelPriority`. */
  priority: number;
}

export type LabelWorld = Pick<WorldState, 'bodies' | 'projects' | 'tasks'>;

/** Longest title a label shows before "…" (the tooltip has it all). */
export const TITLE_MAX = 32;

export function shortTitle(text: string, max = TITLE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

const STATE_TEXT: Record<WorkState, string> = {
  proposed: 'proposed',
  approved: 'approved',
  in_progress: 'in progress',
  blocked_on_user: 'blocked on you',
  awaiting_closure: 'awaiting closure',
  completed: '✓ completed',
  archived: 'archived',
  failed: 'failed',
  paused: 'paused',
  moved: 'moved',
  interrupted: 'interrupted',
};

const STATE_TONE: Record<WorkState, LabelTone> = {
  proposed: 'waiting',
  approved: 'waiting',
  in_progress: 'active',
  blocked_on_user: 'beacon',
  awaiting_closure: 'waiting',
  completed: 'done',
  archived: 'done',
  failed: 'fail',
  paused: 'warn',
  moved: 'done',
  interrupted: 'warn',
};

export const stateText = (state: WorkState): string => STATE_TEXT[state];
export const stateTone = (state: WorkState): LabelTone => STATE_TONE[state];

/**
 * De-clutter priority (higher wins when labels overlap): the selected body first, then "blocked on
 * user" (the loudest state, SPEC §4.4), then work in progress, then other open work, then finished
 * work and "moved to …" markers.
 */
export const PRIORITY = { selected: 5, blocked: 4, active: 3, open: 2, done: 1 } as const;

export function labelPriority(tone: LabelTone, selected: boolean): number {
  if (selected) return PRIORITY.selected;
  if (tone === 'beacon') return PRIORITY.blocked;
  if (tone === 'active') return PRIORITY.active;
  if (tone === 'done') return PRIORITY.done;
  return PRIORITY.open;
}

/** Reserved bodies are never labelled: the Sun (a star) and the catalogue's `reserved` ones. */
export function isReserved(body: Body): boolean {
  return body.kind === 'star' || body.meta?.['reserved'] === true;
}

/** A moon hosting a project: a sub-project (it has a parent project) or an independent one. */
export function moonRole(world: LabelWorld, body: Body): MoonRole | undefined {
  if (body.kind !== 'moon' || body.host?.kind !== 'project') return undefined;
  const project = world.projects[body.host.id];
  if (!project) return undefined;
  return project.parentProjectId !== undefined ? 'sub-project' : 'independent';
}

function workName(world: LabelWorld, host: Host): string | undefined {
  return host.kind === 'project'
    ? world.projects[host.id]?.name
    : world.tasks[host.id]?.description;
}

function workState(world: LabelWorld, host: Host): WorkState | undefined {
  return host.kind === 'project' ? world.projects[host.id]?.state : world.tasks[host.id]?.state;
}

/** The label of one body, or `undefined` for a body that shows none (free, reserved, unknown). */
export function bodyLabel(
  world: LabelWorld,
  bodyId: string,
  selectedBodyId?: string,
): BodyLabel | undefined {
  const body = world.bodies[bodyId];
  if (!body || isReserved(body)) return undefined;
  const selected = bodyId === selectedBodyId;
  const finish = (label: Omit<BodyLabel, 'selected' | 'priority'>): BodyLabel => ({
    ...label,
    selected,
    priority: labelPriority(label.tone, selected),
  });

  if (body.host) {
    const host = body.host;
    const name = workName(world, host) ?? body.name;
    const state = workState(world, host);
    const label: Omit<BodyLabel, 'selected' | 'priority'> = {
      bodyId,
      kind: host.kind,
      title: shortTitle(name),
      fullTitle: name,
      state,
      stateText: state ? stateText(state) : 'loading',
      tone: state ? stateTone(state) : 'waiting',
    };
    const moon = moonRole(world, body);
    if (moon) label.moon = moon;
    if (moon === 'sub-project' && host.kind === 'project') {
      const parentId = world.projects[host.id]?.parentProjectId;
      const parent = parentId ? world.projects[parentId] : undefined;
      if (parent) label.partOf = shortTitle(parent.name, 24);
    }
    return finish(label);
  }

  if (body.movedTo) {
    const marker = body.movedTo;
    const name = workName(world, marker.host) ?? body.name;
    const target = bodyName(world, marker.bodyId);
    return finish({
      bodyId,
      kind: 'moved',
      title: shortTitle(name),
      fullTitle: name,
      state: 'moved',
      stateText: `moved to ${target}`,
      tone: 'done',
      movedTo: { bodyId: marker.bodyId, name: target },
    });
  }
  return undefined;
}

/** Every label of the world, in body-id order (a stable DOM order). */
export function bodyLabels(world: LabelWorld, selectedBodyId?: string): BodyLabel[] {
  const labels: BodyLabel[] = [];
  for (const bodyId of Object.keys(world.bodies).sort()) {
    const label = bodyLabel(world, bodyId, selectedBodyId);
    if (label) labels.push(label);
  }
  return labels;
}

/** Moons hosting an independent project (SPEC §3.2): the scene rings them (`MoonMarkers`). */
export function independentMoons(world: LabelWorld): string[] {
  return Object.values(world.bodies)
    .filter((b) => moonRole(world, b) === 'independent')
    .map((b) => b.id)
    .sort();
}
