import type { Vec3 } from '../camera/flight.js';
import {
  CLEAR_TARGET_PX,
  MAX_CANDIDATES,
  MIN_TARGET_PX,
  pickBodies,
  type PickRay,
  type PickResult,
  type PickSphere,
} from './pick.js';

/**
 * Picking over bodies **and satellites** (P4-08): the same ray-vs-sphere maths as `pickBodies`,
 * with each drawn satellite (`satellites/registry.ts`: its frame's live `position`, half its `size`)
 * as one more sphere, never smaller than `MIN_TARGET_PX` on screen. No three.js.
 *
 * The rule, on top of the bodies' one (`pick.ts`):
 * 1. a satellite counts only when the ray passes through its target and no body's drawn surface
 *    is in front of it (a satellite behind its planet is hidden by it);
 * 2. a satellite under the pointer wins over every body that is clearly a target (at least
 *    `CLEAR_TARGET_PX` on screen: the planet it orbits, seen up close) — of several satellites,
 *    the one nearest the pointer on screen;
 * 3. when a speck of a body is under the pointer too (the system view: a planet a few pixels wide
 *    and its satellites all inside a few pixels), nothing is guessed: everything under the
 *    pointer goes to the "what's here" list, satellites first (corner case 24);
 * 4. no satellite under the pointer: the bodies' result, unchanged.
 * Satellites merely near the pointer (within `CLUSTER_PX` of their target) are not candidates:
 * they orbit, and a list that flickers with them would be noise.
 */
export interface SatelliteSphere {
  agentId: string;
  center: Vec3;
  radius: number;
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
  /** Everything under the pointer: satellites first, then the bodies' candidates. */
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
function hidden(origin: Vec3, point: Vec3, spheres: readonly PickSphere[]): boolean {
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
): ScenePick {
  const bodies = pickBodies(ray, bodySpheres, pxScale);
  const satellites: SatelliteCandidate[] = [];
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
    if (screenDistance > Math.max(screenRadius, MIN_TARGET_PX)) continue;
    if (hidden(ray.origin, s.center, bodySpheres)) continue; // behind a body
    satellites.push({ agentId: s.agentId, depth, screenDistance, screenRadius });
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
  const candidates = [
    ...satellites.map((s) => satellite(s.agentId)),
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
