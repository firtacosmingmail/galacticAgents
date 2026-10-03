import type { Id } from '@galactic/protocol';
import type { SatelliteFrame } from './director.js';

/**
 * The satellites as the rest of the scene sees them (P4-01), like `anchors.ts` for bodies: one
 * live `SatelliteFrame` per drawn satellite, keyed by agent id, whose position, size, mode and
 * beam the director rewrites in place every frame. A satellite whose agent just ended stays here
 * while it shrinks out (`presence` < 1). Readers:
 * - the renderer (`Satellites.tsx`) draws one satellite per published id (`satelliteIds`);
 * - P4-02 (HQ station, legend), P4-03 (a transport shuttle flies between a Steward's frame and its
 *   Waykeeper's), P4-05 (beacons) and P4-04 (fly / land markers) read frames here;
 * - picking (P4-08; SPEC §4.1: "clicking a satellite selects that agent") tests the visible
 *   frames' spheres (`position`, half the `size`) next to the anchors' (`picking/scene-pick.ts`),
 *   and the hover card and ring follow the hovered frame.
 *
 * Type-only imports: no three.js.
 */
let frames: ReadonlyMap<Id, SatelliteFrame> = new Map();
let ids: readonly Id[] = [];
const listeners = new Set<() => void>();

/** Replaces the published set (the director calls it when satellites are added or removed). */
export function publishSatellites(next: ReadonlyMap<Id, SatelliteFrame>): void {
  frames = next;
  ids = [...next.keys()];
  listeners.forEach((l) => l());
}

export function getSatellite(agentId: Id): SatelliteFrame | undefined {
  return frames.get(agentId);
}

export function allSatellites(): SatelliteFrame[] {
  return [...frames.values()];
}

/** The published agent ids, in the director's order; the same array until the next publish. */
export function satelliteIds(): readonly Id[] {
  return ids;
}

/** Called when satellites are added or removed (not when they move or change mode). */
export function onSatellitesChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
