import type { Id, QualityTier, Task, WorkState } from '@galactic/protocol';
import type { WorldState } from '../../../state/reduce.js';
import type { Selection } from '../../../state/selection.js';
import { agentsFor } from '../../../console/hierarchy/shared.js';
import { primaryAgent } from '../../../panel/nav-model.js';
import { SPIN_PERIOD } from '../../bodies/layout.js';
import { planetLook } from '../../bodies/appearance.js';
import { moonRole, stateText, type MoonRole } from '../../labels/label-model.js';
import { hashId } from '../../satellites/machine.js';
import { linearRgb, pulseAt, WAITING_AMBER, type Pulse } from '../../satellites/look.js';
import type { DetailBody } from '../detail-body.js';
import type { DetailKind } from '../mode.js';

/**
 * The project overlay of the detail view (P6-04; SPEC decision 88, and §3.2, §4.1, decisions 9,
 * 66, 68, 73, 77, 84), as plain data — no three.js, no React — so placement, looks and selection
 * are tested without WebGL. `ProjectOverlay.tsx` draws it.
 *
 * - **Which tasks.** A body's project tasks (decision 9: a project task lives on its project's
 *   body, `task.bodyId`): every task with a `projectId` on the shown body, except archived and
 *   moved work (`projectTasksOn`). In a planet's view the tasks of its **sub-project moons** are
 *   shown on those moons too (SPEC §3.2: a sub-project reads as part of the planet's project).
 * - **Where.** A rocky planet or a moon has a surface: each task takes a **surface slot**, a fixed
 *   point of a Fibonacci lattice over the band ±`SURFACE_LAT_MAX` (the poles stay clear), riding
 *   the body's spin like its terrain. A gas or ice giant has none (`footingOf`'s rule): each task
 *   takes an **orbit slot** on one of three low rings, inside the satellites' shells.
 * - **Deterministic.** A task's slot is `hash(task id) mod slots`, the next free one when taken
 *   (linear probing), the tasks taken oldest first (`createdAt`, then id): a task's slot depends
 *   only on itself and older tasks, so it is the same in every session and a new task never moves
 *   an old one (`assignSlots`). Beyond the slots (a very big project), the newest closed tasks
 *   are the ones left out (`MAX_MARKERS` per tier).
 * - **Look** (`markerLook`): colour by the task's state with the satellites' palette (amber and
 *   blinking when blocked on the user, light blue in progress, violet paused, red failed, warm
 *   and dim completed, grey planned), never colour alone: blocked is larger and blinks, closed
 *   work smaller and dim; under reduced motion nothing pulses.
 * - **Selection** (`taskSelection`, `selectedTaskOf`): a task selects what its row in the panel's
 *   navigation selects — its Steward, the newest live one else the newest (`primaryAgent`); a task
 *   no Steward has started yet selects nothing and shows what it is. The panel's selection of a
 *   Steward highlights its task's marker.
 */

/** The detail part's id (`parts.ts`). */
export const OVERLAY_PART = 'project-overlay';

/** The sub-scenes the overlay belongs to: bodies that host projects. */
export const OVERLAY_KINDS: readonly DetailKind[] = ['rocky', 'giant', 'moon'];

/** Where a body's tasks go. */
export type TaskFooting = 'surface' | 'orbit';

/** A giant (gas or ice: no surface) puts its tasks in orbit; everything else on its surface. */
export function overlayFooting(body: DetailBody): TaskFooting {
  if (body.kind !== 'giant' && body.kind !== 'rocky') return 'surface';
  const style = planetLook(body.name).style;
  return style === 'gas' || style === 'ice' ? 'orbit' : 'surface';
}

/** Task states that leave the body: archived (out of the world's picture) and moved (elsewhere). */
const GONE: ReadonlySet<WorkState> = new Set<WorkState>(['archived', 'moved']);
/** Closed work: shown, dim, and the first to be left out when slots run out. */
const CLOSED: ReadonlySet<WorkState> = new Set<WorkState>(['completed']);

/** What the markers are made from: only the tasks (a Steward's state never changes a marker). */
export type OverlayWorld = Pick<WorldState, 'tasks'>;

const byAge = (a: Task, b: Task) =>
  a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The project tasks on a body, oldest first (the slot order). At most `max`: when there are more,
 * open work wins over completed work, and the newest completed tasks are dropped first.
 */
export function projectTasksOn(
  world: Pick<WorldState, 'tasks'>,
  bodyId: Id,
  max = Infinity,
): Task[] {
  const tasks = Object.values(world.tasks)
    .filter((t) => t.projectId !== undefined && t.bodyId === bodyId && !GONE.has(t.state))
    .sort(byAge);
  if (tasks.length <= max) return tasks;
  const open = tasks.filter((t) => !CLOSED.has(t.state));
  const keep = new Set(open.slice(0, max).map((t) => t.id));
  for (const t of tasks) {
    if (keep.size >= max) break;
    if (CLOSED.has(t.state)) keep.add(t.id);
  }
  return tasks.filter((t) => keep.has(t.id));
}

/** Surface slots: points of a Fibonacci lattice over the band of latitudes ±this (radians). */
export const SURFACE_LAT_MAX = (55 * Math.PI) / 180;
export const SURFACE_SLOTS = 48;
/** Orbit slots: three rings (radii in the body's anchor radius, under the satellites' 1.8). */
export const ORBIT_RINGS = [
  { radius: 1.22, inclination: 0.05, period: 70 },
  { radius: 1.38, inclination: -0.09, period: 84 },
  { radius: 1.54, inclination: 0.13, period: 98 },
] as const;
export const ORBIT_PER_RING = 12;
export const ORBIT_SLOTS = ORBIT_RINGS.length * ORBIT_PER_RING;

/** How many markers a view draws at most, per tier (each is a few instances: cheap). */
export const MAX_MARKERS: Readonly<Record<QualityTier, number>> = {
  high: SURFACE_SLOTS,
  balanced: 36,
  mobile: 24,
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export type Vec3 = [number, number, number];

/** The unit direction of surface slot `i` (in the body's own frame: y is the spin axis). */
export function surfaceSlot(i: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const n = SURFACE_SLOTS;
  const y = Math.sin(SURFACE_LAT_MAX) * (1 - (2 * (i + 0.5)) / n);
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE;
  out[0] = r * Math.cos(phi);
  out[1] = y;
  out[2] = r * Math.sin(phi);
  return out;
}

/** Orbit slot `i`: its ring and its angle on the ring at time 0. */
export function orbitSlot(i: number): { ring: number; angle: number } {
  const ring = Math.floor(i / ORBIT_PER_RING) % ORBIT_RINGS.length;
  const k = i % ORBIT_PER_RING;
  // Rings are offset by half a step, so markers on neighbouring rings do not line up.
  return { ring, angle: (2 * Math.PI * (k + 0.5 * ring)) / ORBIT_PER_RING };
}

/**
 * Each task's slot, deterministic: `hash(id) mod count`, the next free slot when taken. `ids` in
 * slot order (oldest first, `projectTasksOn`): a task's slot depends on it and the older tasks
 * only. Ids beyond `count` get none.
 */
export function assignSlots(ids: readonly Id[], count: number): Map<Id, number> {
  const slots = new Map<Id, number>();
  const used = new Uint8Array(count);
  for (const id of ids) {
    if (slots.size >= count) break;
    let slot = hashId(id) % count;
    while (used[slot]) slot = (slot + 1) % count;
    used[slot] = 1;
    slots.set(id, slot);
  }
  return slots;
}

/** The planet's spin angle now (the per-kind components' formula), 0 under reduced motion. */
export function spinAngle(now: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : (now / SPIN_PERIOD) * Math.PI * 2;
}

/**
 * A surface point in the view's frame: `dir` turned by the spin about y, then by the tilt about z
 * (as the per-kind components nest them: tilt group, spinning mesh), at `radius`. Into `out`.
 */
export function surfacePoint(
  dir: readonly number[],
  tilt: number,
  spin: number,
  radius: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  const x1 = (dir[0] ?? 0) * cs + (dir[2] ?? 0) * ss;
  const y1 = dir[1] ?? 0;
  const z1 = -(dir[0] ?? 0) * ss + (dir[2] ?? 0) * cs;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  out[0] = (x1 * ct - y1 * st) * radius;
  out[1] = (x1 * st + y1 * ct) * radius;
  out[2] = z1 * radius;
  return out;
}

/**
 * An orbit slot's point in the view's frame at time `t` (still at 0 under reduced motion): on its
 * ring in the planet's (tilted) equatorial plane, inclined a little, at the ring's radius times
 * `radius` (the anchor's).
 */
export function orbitPoint(
  slot: number,
  tilt: number,
  t: number,
  radius: number,
  out: Vec3 = [0, 0, 0],
): Vec3 {
  const { ring, angle } = orbitSlot(slot);
  const r = ORBIT_RINGS[ring]!;
  const a = angle + (2 * Math.PI * t) / r.period;
  const x = Math.cos(a);
  const z = -Math.sin(a);
  // Inclined about the x axis, then tilted with the planet.
  const ci = Math.cos(r.inclination);
  const si = Math.sin(r.inclination);
  return surfacePoint([x, -z * si, z * ci], tilt, 0, r.radius * radius, out);
}

/** How a marker looks for its task's state. */
export interface MarkerLook {
  /** Linear RGB. */
  color: readonly [number, number, number];
  /** Brightness multiplier of the glowing head (above ~1.4 it blooms with a composer). */
  level: number;
  /** Brightness under reduced motion. */
  still: number;
  pulse: Pulse;
  /** Size multiplier (a cue that survives colour blindness and reduced motion). */
  scale: number;
}

/** The light blue of a working Steward (`SATELLITE_LOOK.steward`), for work in progress. */
const IN_PROGRESS = '#a8dcff';

const LOOKS: Readonly<Record<WorkState, Omit<MarkerLook, 'color'> & { hex: string }>> = {
  blocked_on_user: { hex: WAITING_AMBER, level: 1, still: 1.7, pulse: 'blink', scale: 1.35 },
  in_progress: { hex: IN_PROGRESS, level: 1.1, still: 1.2, pulse: 'breathe', scale: 1 },
  awaiting_closure: { hex: '#9fe6b8', level: 1, still: 1, pulse: 'steady', scale: 1 },
  approved: { hex: '#c9d3e6', level: 0.8, still: 0.8, pulse: 'steady', scale: 0.9 },
  proposed: { hex: '#8e97ad', level: 0.6, still: 0.6, pulse: 'steady', scale: 0.8 },
  paused: { hex: '#a58fff', level: 0.85, still: 0.85, pulse: 'steady', scale: 1 },
  interrupted: { hex: '#ff7a45', level: 0.8, still: 0.8, pulse: 'steady', scale: 0.9 },
  failed: { hex: '#ff4d5a', level: 0.7, still: 0.6, pulse: 'flicker', scale: 0.85 },
  completed: { hex: '#ffd49a', level: 0.45, still: 0.45, pulse: 'steady', scale: 0.75 },
  archived: { hex: '#6f7891', level: 0.4, still: 0.4, pulse: 'steady', scale: 0.7 },
  moved: { hex: '#6f7891', level: 0.4, still: 0.4, pulse: 'steady', scale: 0.7 },
};

/** One look per state, built once (read for every marker every frame: no allocation). */
const BUILT = new Map<WorkState, MarkerLook>();

export function markerLook(state: WorkState): MarkerLook {
  let look = BUILT.get(state);
  if (!look) {
    const { hex, ...rest } = LOOKS[state];
    look = Object.freeze({ ...rest, color: linearRgb(hex) });
    BUILT.set(state, look);
  }
  return look;
}

/** The head's brightness now: the state's level and pulse; the still level under reduced motion. */
export function markerBrightness(
  look: MarkerLook,
  now: number,
  reducedMotion: boolean,
  taskId: Id,
): number {
  if (reducedMotion) return look.still;
  return look.level * pulseAt(look.pulse, now, hashId(taskId));
}

/** What a task's marker selects: its Steward (the panel's rule), or nothing yet. */
export function taskSelection(
  world: Pick<WorldState, 'agents' | 'statuses'>,
  taskId: Id,
): Selection | undefined {
  const agent = primaryAgent(world, agentsFor(world, { taskId }));
  return agent ? { kind: 'steward', id: agent.id } : undefined;
}

/** The task a panel selection is about (a Steward's), for the marker's highlight. */
export function selectedTaskOf(
  world: Pick<WorldState, 'agents'>,
  selection: Selection,
): Id | undefined {
  if (selection.kind !== 'steward') return undefined;
  const agent = world.agents[selection.id];
  return agent?.role === 'steward' ? agent.taskId : undefined;
}

/** The hover label's text: "Task · <description> · <state>". */
export function taskHoverText(task: Pick<Task, 'description' | 'state'>): string {
  const flat = task.description.replace(/\s+/g, ' ').trim();
  const name = flat.length <= 48 ? flat : `${flat.slice(0, 47).trimEnd()}…`;
  return `${name} · ${stateText(task.state)}`;
}

/** The info card of a task with no Steward yet: what `activateTask` shows. */
export function taskInfoDetail(task: Pick<Task, 'description' | 'state'>): string {
  return `${task.description} · ${stateText(task.state)} · no Steward yet`;
}

/** A moon of the shown planet that hosts a project, and how it relates to the planet's work. */
export interface MoonLink {
  moonId: Id;
  role: MoonRole;
}

/**
 * The shown planet's moons that host a project (SPEC §3.2): a **sub-project** is drawn as part of
 * the planet's project (a tether from the planet, its tasks on the moon); an **independent**
 * project keeps the scene's teal ring (`MoonMarkers`, decision 66) and nothing ties it to the
 * planet. Sorted by moon id.
 */
export function moonLinks(
  world: Pick<WorldState, 'bodies' | 'projects'>,
  moonIds: readonly Id[],
): MoonLink[] {
  const links: MoonLink[] = [];
  for (const moonId of [...moonIds].sort()) {
    const body = world.bodies[moonId];
    if (!body) continue;
    const role = moonRole({ ...world, tasks: {} }, body);
    if (role) links.push({ moonId, role });
  }
  return links;
}

/**
 * A moon shown on its own that is a sub-project: the planet its parent project lives on (the
 * tether points there), else `undefined`.
 */
export function parentPlanetOf(
  world: Pick<WorldState, 'bodies' | 'projects'>,
  moonId: Id,
): Id | undefined {
  const body = world.bodies[moonId];
  if (!body || moonRole({ ...world, tasks: {} }, body) !== 'sub-project') return undefined;
  return body.parentId;
}

/** One marker of the view, as placed: which task, on which body, in which slot. */
export interface MarkerSpec {
  taskId: Id;
  /** The body it stands on or orbits (the shown body, or one of its sub-project moons). */
  bodyId: Id;
  footing: TaskFooting;
  slot: number;
  state: WorkState;
}

/**
 * Every marker of a view: the shown body's tasks (`footing`), then — in a planet's view — each
 * sub-project moon's tasks on that moon's surface. Slots are per body. At most `max` per body.
 */
export function overlayMarkers(
  world: OverlayWorld,
  body: DetailBody,
  max: number,
  subMoons: readonly Id[] = [],
): MarkerSpec[] {
  const out: MarkerSpec[] = [];
  const add = (bodyId: Id, footing: TaskFooting) => {
    const tasks = projectTasksOn(world, bodyId, max);
    const count = footing === 'orbit' ? ORBIT_SLOTS : SURFACE_SLOTS;
    const slots = assignSlots(
      tasks.map((t) => t.id),
      count,
    );
    for (const t of tasks) {
      const slot = slots.get(t.id);
      if (slot !== undefined) out.push({ taskId: t.id, bodyId, footing, slot, state: t.state });
    }
  };
  add(body.bodyId, overlayFooting(body));
  for (const moonId of subMoons) add(moonId, 'surface');
  return out;
}

/** How many instances each of the overlay's instanced meshes holds. */
export interface OverlayCapacity {
  /** Pins on the shown body (cut by the cutaway). */
  pins: number;
  /** Pins on sub-project moons (never cut). */
  moonPins: number;
  buoys: number;
  /** Uncut glows: buoy and moon-pin heads, drone lights. */
  glow: number;
  /** Cut glows: the shown body's pin heads, robot lights. */
  cutGlow: number;
}

/** Capacities are rounded up to this step: a task more or fewer rarely rebuilds the meshes. */
export const CAPACITY_STEP = 8;

/**
 * The capacities a marker list needs (`bodyId`: the shown body), with `standIns` robots or drones:
 * every marker fits, whatever its sub-project moons hold (each moon has up to `MAX_MARKERS` of its
 * own), so no drawn marker is ever dropped by a full list.
 */
export function overlayCapacity(
  markers: readonly Pick<MarkerSpec, 'bodyId' | 'footing'>[],
  bodyId: Id,
  standIns: number,
): OverlayCapacity {
  let pins = 0;
  let moonPins = 0;
  let buoys = 0;
  for (const m of markers) {
    if (m.footing === 'orbit') buoys++;
    else if (m.bodyId === bodyId) pins++;
    else moonPins++;
  }
  const up = (n: number) => Math.max(CAPACITY_STEP, Math.ceil(n / CAPACITY_STEP) * CAPACITY_STEP);
  return {
    pins: up(pins),
    moonPins: up(moonPins),
    buoys: up(buoys),
    glow: up(buoys + moonPins + standIns),
    cutGlow: up(pins + standIns),
  };
}

/**
 * Whether a Steward's robot is out of sight (P6-04): a robot (surface footing) whose place on the
 * shown body is removed by the cutaway. Its frame is then hidden from every reader (`hidden` on its
 * placement override). Drones in orbit are never cut.
 */
export function standInCut(
  footing: TaskFooting,
  planes: Parameters<typeof cutAway>[0],
  position: readonly number[],
): boolean {
  return footing === 'surface' && cutAway(planes, position);
}

/** Two marker lists draw the same thing (keeps React from re-rendering on unrelated changes). */
export function sameMarkers(a: readonly MarkerSpec[], b: readonly MarkerSpec[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const n = b[i];
      return (
        n !== undefined &&
        m.taskId === n.taskId &&
        m.bodyId === n.bodyId &&
        m.footing === n.footing &&
        m.slot === n.slot &&
        m.state === n.state
      );
    })
  );
}

/**
 * Whether a world point is removed by the cutaway's planes (P6-03: two planes with
 * `clipIntersection` — a point is clipped only when it is on the negative side of both). `planes`
 * as `{ normal, constant }` (three's `Plane`). No planes: never.
 */
export function cutAway(
  planes: readonly { normal: { x: number; y: number; z: number }; constant: number }[] | undefined,
  p: readonly number[],
): boolean {
  if (!planes || planes.length === 0) return false;
  for (const plane of planes) {
    const d =
      plane.normal.x * (p[0] ?? 0) +
      plane.normal.y * (p[1] ?? 0) +
      plane.normal.z * (p[2] ?? 0) +
      plane.constant;
    if (d >= 0) return false;
  }
  return true;
}

/** Steward stand-ins: how many per view, per tier (the rest keep their satellites). */
export const MAX_STAND_INS: Readonly<Record<QualityTier, number>> = {
  high: 16,
  balanced: 12,
  mobile: 6,
};

/** Sizes, in the anchor's radius of the body they are on (`R`). */
export const MARKER_SIZE = {
  /** Surface pin: pad width, mast height, head size. */
  pad: 0.05,
  mast: 0.07,
  head: 0.03,
  /** Orbit buoy: body and glow. */
  buoy: 0.035,
  buoyGlow: 0.05,
  /** A marker is never smaller than this on screen (CSS pixels of span). */
  minPx: 7,
  /** …nor larger than this (a buoy or drone right in front of the camera). */
  maxPx: 44,
  /** The pick target's radius on screen, at least (CSS pixels). */
  targetPx: 9,
  /** The pick centre sits this high above the surface (R): never inside the body's pick sphere. */
  lift: 1.05,
} as const;

/** Steward stand-ins: robot on a surface, drone in orbit (in R of their body). */
export const STAND_IN = {
  robot: 0.06,
  drone: 0.05,
  /** A robot stands beside its task's pin (radians on the body), a drone above its buoy (R). */
  beside: 0.07,
  above: 0.07,
  /** The robot's frame is this high above the surface (R): on the near side never occluded. */
  lift: 1.04,
  /** The claimed frame's span (activities, pick target) relative to the satellite's. */
  frameScale: 0.5,
} as const;

/** The cross-fade eased for the stand-ins' descent (0 system … 1 detail). */
export function descent(mix: number): number {
  const x = Math.min(1, Math.max(0, mix));
  return x * x * (3 - 2 * x);
}
