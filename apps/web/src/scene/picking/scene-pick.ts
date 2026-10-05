import type { Vec3 } from '../camera/flight.js';
import {
  CLEAR_TARGET_PX,
  MAX_CANDIDATES,
  pickBodies,
  POINTER_SLOP,
  type PickRay,
  type PickSlop,
  type PickResult,
  type PickSphere,
} from './pick.js';

/**
 * Picking over bodies **and satellites** (P4-08): the same ray-vs-sphere maths as `pickBodies`,
 * with each drawn satellite (`satellites/registry.ts`: its frame's live `position`, half its `size`)
 * as one more sphere, never smaller than `MIN_TARGET_PX` on screen (the slop's, P7-03: larger for a finger). No three.js.
 *
 * The rule, on top of the bodies' one (`pick.ts`):
 * 1. a satellite counts only when the ray passes through its target and no body's drawn surface
 *    is in front of it (a satellite behind its planet is hidden by it);
 * 2. a satellite under the pointer wins over every body that is clearly a target (at least
 *    `CLEAR_TARGET_PX` on screen: the planet it orbits, seen up close) — of several satellites,
 *    the one nearest the pointer on screen;
 * 3. when a speck of a body is under the pointer too (the system view: a planet a few pixels wide
 *    and its satellites all inside a few pixels), nothing is guessed: everything under the
 *    pointer goes to the "what's here" list, satellites first (corner case 24), and the hover
 *    names the body with "+n" (`hoverTarget`);
 * 4. no satellite under the pointer: the bodies' result, unchanged.
 * **Landed satellites** (P4-04: completed work's, sitting on the surface) are not candidates and
 * not in the "+n" count — a completed project's planet may carry several, and clicking it must do
 * what clicking the body does (select its Waykeeper, decision 65), not open a list — EXCEPT a
 * direct hit at their real drawn size (no `MIN_TARGET_PX` floor) while their body is clearly a
 * target (`CLEAR_TARGET_PX`: the camera is close). A landed satellite whose body is not drawn
 * (no sphere) is never a candidate.
 * Satellites merely near the pointer (within `CLUSTER_PX` of their target) are not candidates:
 * they orbit, and a list that flickers with them would be noise. For the same reason the
 * satellites in `candidates` are in a stable order (role, then agent id), never by their per-frame
 * distance to the pointer: at the system view they all sit inside a few pixels and would reshuffle
 * every frame.
 */
export interface SatelliteSphere {
  agentId: string;
  /** Its agent's role, for the stable order of the "what's here" list (unknown: last). */
  role?: string | undefined;
  center: Vec3;
  radius: number;
  /** P4-04: it sits landed on its body (completed work): picked only by a direct, close hit. */
  landed?: boolean | undefined;
  /** The body it belongs to (a landed satellite's body must be clearly a target). */
  bodyId?: string | undefined;
}

export interface SatelliteCandidate {
  agentId: string;
  /** Along the ray to the satellite's centre's closest approach (world units). */
  depth: number;
  /** Pointer to the satellite's centre, in pixels. */
  screenDistance: number;
  /** Its radius on screen, in pixels. */
  screenRadius: number;
}

export type PickTarget = { kind: 'body'; bodyId: string } | { kind: 'satellite'; agentId: string };

export interface ScenePick {
  /** The bodies' own result (`pickBodies`). */
  bodies: PickResult;
  /** The satellites under the pointer and not hidden by a body, nearest the pointer first. */
  satellites: SatelliteCandidate[];
  /**
   * Everything under the pointer: satellites first (by role — Harmonizer, Waykeeper, Steward —
   * then agent id: stable while they orbit), then the bodies' candidates.
   */
  candidates: PickTarget[];
  /** What the pointer means, when that is clear; `undefined` with several candidates. */
  choice: PickTarget | undefined;
}

const body = (bodyId: string): PickTarget => ({ kind: 'body', bodyId });
const satellite = (agentId: string): PickTarget => ({ kind: 'satellite', agentId });

/**
 * Whether a body's drawn sphere stands between the camera and a point: the line of sight to the
 * satellite's centre enters a body before reaching it. (Not "the pointer's ray hits a body in
 * front": a satellite beside a speck of a planet is caught by its minimum target while the ray
 * grazes the planet, and is not hidden by it.)
 */
export function occluded(origin: Vec3, point: Vec3, spheres: readonly PickSphere[]): boolean {
  const ux = point[0] - origin[0];
  const uy = point[1] - origin[1];
  const uz = point[2] - origin[2];
  const length = Math.hypot(ux, uy, uz);
  if (length === 0) return false;
  for (const s of spheres) {
    const vx = s.center[0] - origin[0];
    const vy = s.center[1] - origin[1];
    const vz = s.center[2] - origin[2];
    const along = (vx * ux + vy * uy + vz * uz) / length;
    if (along <= 0) continue;
    const perpSq = vx * vx + vy * vy + vz * vz - along * along;
    const rSq = s.radius * s.radius;
    if (perpSq >= rSq) continue;
    if (along - Math.sqrt(rSq - perpSq) < length) return true;
  }
  return false;
}

export function pickScene(
  ray: PickRay,
  bodySpheres: readonly PickSphere[],
  satelliteSpheres: readonly SatelliteSphere[],
  pxScale: number,
  slop: PickSlop = POINTER_SLOP,
): ScenePick {
  const bodies = pickBodies(ray, bodySpheres, pxScale, slop);
  const satellites: SatelliteCandidate[] = [];
  const listed: SatelliteSphere[] = [];
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  for (const s of satelliteSpheres) {
    const vx = s.center[0] - ox;
    const vy = s.center[1] - oy;
    const vz = s.center[2] - oz;
    const distSq = vx * vx + vy * vy + vz * vz;
    const depth = vx * dx + vy * dy + vz * dz;
    if (depth <= 0 || distSq <= s.radius * s.radius) continue; // behind or around the camera
    const perPx = depth / pxScale;
    const screenDistance = Math.sqrt(Math.max(0, distSq - depth * depth)) / perPx;
    const screenRadius = s.radius / perPx;
    if (s.landed) {
      if (screenDistance > screenRadius) continue; // its real size: no minimum target
      if (!clearTarget(ray.origin, s.bodyId, bodySpheres, pxScale)) continue;
    } else if (screenDistance > Math.max(screenRadius, slop.minTargetPx)) continue;
    if (occluded(ray.origin, s.center, bodySpheres)) continue; // behind a body
    satellites.push({ agentId: s.agentId, depth, screenDistance, screenRadius });
    listed.push(s);
  }
  satellites.sort(
    (a, b) =>
      a.screenDistance - b.screenDistance ||
      a.depth - b.depth ||
      (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
  );
  if (satellites.length === 0) {
    return {
      bodies,
      satellites,
      candidates: bodies.candidates.map((c) => body(c.bodyId)),
      choice: bodies.choice === undefined ? undefined : body(bodies.choice),
    };
  }
  listed.sort((a, b) => roleRank(a.role) - roleRank(b.role) || (a.agentId < b.agentId ? -1 : 1));
  const candidates = [
    ...listed.map((s) => satellite(s.agentId)),
    ...bodies.candidates.map((c) => body(c.bodyId)),
  ].slice(0, MAX_CANDIDATES);
  const speck = bodies.candidates.some((c) => c.hit && c.screenRadius < CLEAR_TARGET_PX);
  return {
    bodies,
    satellites,
    candidates,
    choice: speck ? undefined : satellite(satellites[0]!.agentId),
  };
}

/** Whether a body is at least `CLEAR_TARGET_PX` of radius on screen (from `origin`). */
function clearTarget(
  origin: Vec3,
  bodyId: string | undefined,
  spheres: readonly PickSphere[],
  pxScale: number,
): boolean {
  if (bodyId === undefined) return false;
  for (const b of spheres) {
    if (b.bodyId !== bodyId) continue;
    const distance = Math.hypot(
      b.center[0] - origin[0],
      b.center[1] - origin[1],
      b.center[2] - origin[2],
    );
    return distance > 0 && (b.radius * pxScale) / distance >= CLEAR_TARGET_PX;
  }
  return false;
}

const ROLE_RANK: Record<string, number> = { harmonizer: 0, waykeeper: 1, steward: 2 };
const roleRank = (role: string | undefined): number =>
  (role === undefined ? undefined : ROLE_RANK[role]) ?? 3;

/**
 * What the hover names: the clear choice; with none (several things under the pointer), the
 * first **body** candidate — at the system view the planet, which stands still, not a satellite
 * that changes from frame to frame — else the first candidate. `others`: how many more are there
 * ("+n"). `undefined`: nothing under the pointer.
 */
export function hoverTarget(result: ScenePick): { target: PickTarget; others: number } | undefined {
  if (result.choice) return { target: result.choice, others: 0 };
  const target = result.candidates.find((c) => c.kind === 'body') ?? result.candidates[0];
  return target ? { target, others: result.candidates.length - 1 } : undefined;
}
