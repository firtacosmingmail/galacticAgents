import type { Id } from '@galactic/protocol';
import type { Vec3 } from '../../camera/flight.js';
import type { PickSphere } from '../../picking/pick.js';
import { occluded } from '../../picking/scene-pick.js';
import { MARKER_SIZE } from './overlay-model.js';

/**
 * The detail view's task markers as picking sees them (P6-04), like `beacons/registry.ts`: one
 * live frame per drawn marker, whose centre and radius the overlay (`ProjectOverlay.tsx`) rewrites
 * in place every frame. No three.js.
 */
export interface TaskMarkerFrame {
  taskId: Id;
  /** The body it is on (the shown body, or a sub-project moon in its planet's view). */
  bodyId: Id;
  /** Drawn this frame: its body is there, it has grown in, and the cutaway has not removed it. */
  visible: boolean;
  /** The pick centre (world units): a little above the pin's foot, or the buoy's centre. */
  center: [number, number, number];
  /** Its drawn radius (world units). */
  radius: number;
  /**
   * Its own body's radius as an occluder (world units): the planet's sphere for a surface marker
   * (a ringed planet's pick sphere is its rings' reach, which would hide every pin), the anchor's
   * for an orbit marker.
   */
  occluder: number;
}

let frames: readonly TaskMarkerFrame[] = [];

/** Replaces the published set (the overlay, when markers come or go; `[]` when it unmounts). */
export function publishTaskMarkers(next: readonly TaskMarkerFrame[]): void {
  frames = next;
}

export function taskMarkerFrames(): readonly TaskMarkerFrame[] {
  return frames;
}

/** Whether any marker is drawn (picking re-picks every frame then: markers ride the spin). */
export function taskMarkersDrawn(): boolean {
  for (const f of frames) if (f.visible) return true;
  return false;
}

/**
 * The marker under the pointer's ray (`origin`, unit `direction`): within its drawn radius on
 * screen, or `MARKER_SIZE.targetPx` of it, and not behind a body (`occluded`: the far side of the
 * planet, a moon in front). Of several, the one nearest the pointer on screen, then the nearest.
 * `pxScale`: pixels per world unit at distance 1 (`pixelScale`).
 */
export function taskMarkerUnder(
  ray: { origin: Vec3; direction: Vec3 },
  pxScale: number,
  bodies: readonly PickSphere[],
  list: readonly TaskMarkerFrame[] = frames,
): TaskMarkerFrame | undefined {
  return taskMarkerHit(ray, pxScale, bodies, list)?.frame;
}

/** `taskMarkerUnder` with how far from the marker's centre the pointer is (CSS pixels). */
export function taskMarkerHit(
  ray: { origin: Vec3; direction: Vec3 },
  pxScale: number,
  bodies: readonly PickSphere[],
  list: readonly TaskMarkerFrame[] = frames,
  minTargetPx = 0,
): { frame: TaskMarkerFrame; px: number } | undefined {
  // P7-03: a finger's tap gets a larger target (`PickSlop.markerPx`).
  const targetPx = Math.max(MARKER_SIZE.targetPx, minTargetPx);
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  let best: TaskMarkerFrame | undefined;
  let bestPx = Infinity;
  let bestDepth = Infinity;
  for (const f of list) {
    if (!f.visible) continue;
    const vx = f.center[0] - ox;
    const vy = f.center[1] - oy;
    const vz = f.center[2] - oz;
    const depth = vx * dx + vy * dy + vz * dz;
    if (depth <= 0) continue;
    const perPx = depth / pxScale;
    const px = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - depth * depth)) / perPx;
    if (px > Math.max(f.radius / perPx, targetPx)) continue;
    if (px > bestPx || (px === bestPx && depth >= bestDepth)) continue;
    if (hidden(ray.origin, f, bodies)) continue;
    best = f;
    bestPx = px;
    bestDepth = depth;
  }
  return best ? { frame: best, px: bestPx } : undefined;
}

const own: PickSphere & { center: [number, number, number] } = {
  bodyId: '',
  center: [0, 0, 0],
  radius: 0,
};
const one: PickSphere[] = [own];
const others: PickSphere[] = [];

/** Behind a body: another body's pick sphere, or its own body at `occluder` radius. */
function hidden(origin: Vec3, f: TaskMarkerFrame, bodies: readonly PickSphere[]): boolean {
  others.length = 0;
  let mine: PickSphere | undefined;
  for (const b of bodies) {
    if (b.bodyId === f.bodyId) mine = b;
    else others.push(b);
  }
  if (occluded(origin, f.center, others)) return true;
  if (!mine) return false;
  own.bodyId = mine.bodyId;
  own.center[0] = mine.center[0];
  own.center[1] = mine.center[1];
  own.center[2] = mine.center[2];
  own.radius = f.occluder;
  return occluded(origin, f.center, one);
}
