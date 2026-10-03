import type { Id } from '@galactic/protocol';
import type { SatelliteFrame } from './director.js';

/**
 * The satellites as the rest of the scene sees them (P4-01), like `anchors.ts` for bodies: one
 * live `SatelliteFrame` per drawn satellite, keyed by agent id, whose position, size, mode and
 * beam the director rewrites in place every frame. Readers:
 * - P4-02 (HQ station, legend), P4-03 (a transport shuttle flies between a Steward's frame and its
 *   Waykeeper's), P4-05 (beacons) and P4-04 (fly / land markers) read frames here;
 * - picking (SPEC §4.1: "clicking a satellite selects that agent") can test the frames' spheres
 *   (`position`, `size`) the way it tests the anchors; it does not yet (P4-01 leaves picking as is).
 *
 * Type-only imports: no three.js.
 */
let frames: ReadonlyMap<Id, SatelliteFrame> = new Map();
const listeners = new Set<() => void>();

/** Replaces the published set (the director calls it when satellites are added or removed). */
export function publishSatellites(next: ReadonlyMap<Id, SatelliteFrame>): void {
  frames = next;
  listeners.forEach((l) => l());
}

export function getSatellite(agentId: Id): SatelliteFrame | undefined {
  return frames.get(agentId);
}

export function allSatellites(): SatelliteFrame[] {
  return [...frames.values()];
}

/** Called when satellites are added or removed (not when they move or change mode). */
export function onSatellitesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
