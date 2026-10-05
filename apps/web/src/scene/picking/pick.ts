import type { Vec3 } from '../camera/flight.js';

/**
 * Picking (P3-05): which bodies lie under the pointer, as plain maths over the anchor registry —
 * each body is its anchor's bounding sphere (world centre + visual radius). No three.js and no
 * mesh raycast: about forty spheres per pick, independent of whatever mesh (LOD tier, P3-06) a
 * body draws, and the instanced background belt is never a candidate.
 *
 * Distances on screen are measured at the body's depth along the pointer's ray: `pxScale` is the
 * viewport's pixels per world unit at distance 1 (`height / (2 tan(fov / 2))`), so a length `L`
 * at depth `t` spans `L × pxScale / t` pixels. Exact near the ray, which is where it matters.
 */
export interface PickSphere {
  bodyId: string;
  center: Vec3;
  radius: number;
}

export interface PickRay {
  origin: Vec3;
  /** Unit length. */
  direction: Vec3;
}

export interface PickCandidate {
  bodyId: string;
  /** Along the ray to the body's centre's closest approach (world units). */
  depth: number;
  /** Where the ray enters the (target-sized) sphere; `Infinity` when it misses it. */
  entry: number;
  /** Pointer to the body's centre, in pixels. */
  screenDistance: number;
  /** The body's radius on screen, in pixels. */
  screenRadius: number;
  /** The ray passes through the body (or through its minimum target, for a tiny one). */
  hit: boolean;
  /** The ray passes through the drawn body itself (not only its minimum target). */
  onBody: boolean;
}

export interface PickResult {
  /**
   * Everything under the pointer, for the "what's here" list: the bodies the ray passes through,
   * nearest first, then the others (a speck's target, a near miss) closest to the pointer first.
   */
  candidates: PickCandidate[];
  /** The body the pointer means, when that is clear; `undefined` with several candidates. */
  choice: string | undefined;
}

/** Every body is at least this big for picking, in pixels of radius (a speck of an asteroid). */
export const MIN_TARGET_PX = 6;
/** Bodies this close to the pointer, beyond their target, count as "here" (corner case 24). */
export const CLUSTER_PX = 6;
/** A hit body at least this big on screen is clearly what the user aimed at: no list. */
export const CLEAR_TARGET_PX = 12;
/** The "what's here" list never grows past this. */
export const MAX_CANDIDATES = 8;

/**
 * How generous a pick is, in CSS pixels (P7-03): a mouse points to the pixel, a fingertip covers
 * about 40 px and lands a few pixels off, so a tap gets larger minimum targets (a 32 px disc for a
 * body or a satellite, 48 px for a question beacon, 32 px for a task marker) and a wider cluster.
 * Larger targets mean more taps near several specks find more than one: those open the "what's
 * here" list (corner case 24), never a guess.
 */
export interface PickSlop {
  /** `MIN_TARGET_PX` for bodies and satellites. */
  minTargetPx: number;
  /** `CLUSTER_PX` for bodies. */
  clusterPx: number;
  /** A floor on a question beacon's target radius (its own is `BEACON.targetPx`); 0: none. */
  beaconPx: number;
  /** A floor on a task marker's target radius (its own is `MARKER_SIZE.targetPx`); 0: none. */
  markerPx: number;
}

/** A mouse or a pen (and the hover, which a finger never has): the targets as they always were. */
export const POINTER_SLOP: PickSlop = {
  minTargetPx: MIN_TARGET_PX,
  clusterPx: CLUSTER_PX,
  beaconPx: 0,
  markerPx: 0,
};

/** A finger. */
export const TOUCH_SLOP: PickSlop = {
  minTargetPx: 16,
  clusterPx: 8,
  beaconPx: 24,
  markerPx: 16,
};

/** The slop for a `PointerEvent.pointerType`: a finger gets `TOUCH_SLOP`, anything else the pointer's. */
export function pickSlop(pointerType: string | undefined): PickSlop {
  return pointerType === 'touch' ? TOUCH_SLOP : POINTER_SLOP;
}

/** Pixels per world unit at distance 1, for a vertical field of view in degrees. */
export function pixelScale(viewportHeightPx: number, fovDeg: number): number {
  return viewportHeightPx / (2 * Math.tan((fovDeg * Math.PI) / 180 / 2));
}

/**
 * The bodies under the pointer and the one it means:
 * 1. the nearest body the ray passes through is the choice when it is at least
 *    `CLEAR_TARGET_PX` on screen (a body in front hides those behind it);
 * 2. otherwise every body within its target plus `CLUSTER_PX` of the pointer is a candidate:
 *    one candidate is the choice; several make a "what's here" list (no guessing);
 * 3. none: the pointer is over empty space.
 * Bodies behind the camera, or around it (the camera inside a body), are never candidates.
 */
export function pickBodies(
  ray: PickRay,
  spheres: readonly PickSphere[],
  pxScale: number,
  slop: PickSlop = POINTER_SLOP,
): PickResult {
  const { minTargetPx, clusterPx } = slop;
  const candidates: PickCandidate[] = [];
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  for (const s of spheres) {
    const vx = s.center[0] - ox;
    const vy = s.center[1] - oy;
    const vz = s.center[2] - oz;
    const distSq = vx * vx + vy * vy + vz * vz;
    if (distSq <= s.radius * s.radius) continue; // the camera is inside it
    const depth = vx * dx + vy * dy + vz * dz;
    if (depth <= 0) continue; // behind the camera
    const perpendicular = Math.sqrt(Math.max(0, distSq - depth * depth));
    const perPx = depth / pxScale; // world units per pixel at this depth
    const screenRadius = s.radius / perPx;
    const screenDistance = perpendicular / perPx;
    const target = Math.max(s.radius, minTargetPx * perPx);
    if (screenDistance > Math.max(screenRadius, minTargetPx) + clusterPx) continue;
    const hit = perpendicular <= target;
    const entry = hit
      ? depth - Math.sqrt(Math.max(0, target * target - perpendicular * perpendicular))
      : Infinity;
    const onBody = perpendicular <= s.radius;
    candidates.push({ bodyId: s.bodyId, depth, entry, screenDistance, screenRadius, hit, onBody });
  }
  // The nearest body in the way: it hides whatever is behind it.
  let nearest: PickCandidate | undefined;
  for (const c of candidates) if (c.hit && (!nearest || c.entry < nearest.entry)) nearest = c;
  candidates.sort(
    (a, b) =>
      Number(b.onBody) - Number(a.onBody) ||
      (a.onBody ? a.entry - b.entry : a.screenDistance - b.screenDistance) ||
      (a.bodyId < b.bodyId ? -1 : a.bodyId > b.bodyId ? 1 : 0),
  );
  const listed = candidates.slice(0, MAX_CANDIDATES);
  if (nearest && nearest.screenRadius >= CLEAR_TARGET_PX) {
    return { candidates: listed, choice: nearest.bodyId };
  }
  return { candidates: listed, choice: listed.length === 1 ? listed[0]!.bodyId : undefined };
}
