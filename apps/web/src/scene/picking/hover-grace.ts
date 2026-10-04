import type { Point } from './store.js';

/**
 * Hover grace for satellites (P4-08 review): an orbiting satellite stays under a still pointer for
 * about 150 ms, too short to read its card. Once picked (with the ordinary rule, `pickScene`), the
 * satellite stays hovered — card and ring following it — while:
 * 1. the pointer stays within `GRACE_STILL_PX` of where the satellite was picked (the user is
 *    reading: the satellite may orbit away from a still pointer); then, once the pointer has moved
 *    further,
 * 2. the pointer stays within `max(the satellite's screen radius, GRACE_RADIUS_PX)` of the
 *    satellite's projected centre (the user follows it).
 * It is released when the satellite is occluded by a body, off screen or gone (the caller passes
 * `undefined`), after `GRACE_CAP_MS` since the pointer last moved, and — the caller's part — when
 * the popover opens or the pointer leaves the canvas. Off under reduced motion (satellites stand
 * still there: the ordinary rule is enough). Pure: no three.js, no DOM.
 */
export const GRACE_STILL_PX = 6;
export const GRACE_RADIUS_PX = 14;
export const GRACE_CAP_MS = 3000;

export interface Grace {
  agentId: string;
  /** The pointer when the satellite was picked. */
  pickedAt: Point;
  /** The pointer has left `GRACE_STILL_PX` of `pickedAt` (rule 2 from then on). */
  strayed: boolean;
}

/** A satellite as the pointer sees it this frame: its projected centre and radius, in pixels. */
export interface SatelliteOnScreen extends Point {
  radius: number;
}

export function startGrace(agentId: string, pointer: Point): Grace {
  return { agentId, pickedAt: { x: pointer.x, y: pointer.y }, strayed: false };
}

/**
 * Whether the kept satellite stays hovered this frame. `seen`: `undefined` when it is occluded, off
 * screen or gone; `idleMs`: since the pointer last moved. Records the pointer's straying in `grace`.
 */
export function keepsGrace(
  grace: Grace,
  pointer: Point,
  seen: SatelliteOnScreen | undefined,
  idleMs: number,
): boolean {
  if (!seen || idleMs > GRACE_CAP_MS) return false;
  if (!grace.strayed) {
    if (distance(pointer, grace.pickedAt) <= GRACE_STILL_PX) return true;
    grace.strayed = true;
  }
  return distance(pointer, seen) <= Math.max(seen.radius, GRACE_RADIUS_PX);
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
