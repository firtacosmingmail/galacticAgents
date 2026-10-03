import type { Id } from '@galactic/protocol';
import type { Vec3 } from '../camera/flight.js';
import { BEACON } from './beacon-look.js';

/**
 * The drawn beacons as picking sees them (P4-05), like `satellites/registry.ts`: one live frame
 * per beacon, whose glyph centre and target radius the renderer (`Beacons.tsx`) rewrites in place
 * every frame. No three.js.
 */
export interface BeaconFrame {
  bodyId: Id;
  /** Drawn this frame (its body's anchor exists and is in front of the camera). */
  visible: boolean;
  /** The glyph's centre, in world units. */
  center: [number, number, number];
  /** World units per screen pixel at the glyph's depth (the click target is measured in pixels). */
  perPx: number;
}

let frames: readonly BeaconFrame[] = [];

/** Replaces the published set (the renderer, when beacons come or go). */
export function publishBeacons(next: readonly BeaconFrame[]): void {
  frames = next;
}

/** The published frames (live: rewritten in place each frame). */
export function beaconFrames(): readonly BeaconFrame[] {
  return frames;
}

/**
 * Writes one beacon's frame (the renderer, once per frame): its glyph's centre and the world units
 * per pixel there, or `undefined` when it is not drawn this frame.
 */
export function placeBeacon(bodyId: Id, center: Vec3 | undefined, perPx = 0): void {
  for (const f of frames) {
    if (f.bodyId !== bodyId) continue;
    f.visible = center !== undefined;
    if (center) {
      f.center[0] = center[0];
      f.center[1] = center[1];
      f.center[2] = center[2];
      f.perPx = perPx;
    }
    return;
  }
}

/** Whether any beacon is drawn. */
export function beaconsDrawn(): boolean {
  for (const f of frames) if (f.visible) return true;
  return false;
}

/**
 * The beacon under the pointer's ray (`origin`, unit `direction`): the one whose glyph centre is
 * within `BEACON.targetPx` of the pointer on screen, nearest the pointer first. A beacon is drawn
 * over everything (no depth test), so nothing hides it from a click either. `undefined`: none.
 */
export function beaconUnder(
  ray: { origin: Vec3; direction: Vec3 },
  list: readonly BeaconFrame[] = frames,
): Id | undefined {
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.direction;
  let best: Id | undefined;
  let bestPx = Infinity;
  for (const f of list) {
    if (!f.visible || f.perPx <= 0) continue;
    const vx = f.center[0] - ox;
    const vy = f.center[1] - oy;
    const vz = f.center[2] - oz;
    const depth = vx * dx + vy * dy + vz * dz;
    if (depth <= 0) continue;
    const off = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - depth * depth));
    // `perPx` was measured at the body's distance; the glyph is about as far.
    const px = off / f.perPx;
    if (px <= BEACON.targetPx && px < bestPx) {
      best = f.bodyId;
      bestPx = px;
    }
  }
  return best;
}
