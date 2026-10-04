import type { Object3D } from 'three';

/**
 * The objects that draw a body in its stead (P6-01): while the detail view is on, its sub-scene
 * draws the body (and a planet's moons) with meshes of its own, at the anchors' places, and the
 * system's meshes of those bodies are hidden. The anchors do not change (the camera, picking and
 * labels keep reading them); only what the selection outline collects does: the stand-in's meshes
 * instead of the anchor's subtree (`picking/Picking.tsx`'s `OutlineSync`). Each stand-in carries
 * `userData.bodyId`, so a planet's stand-in does not outline its moons' stand-ins nested in it.
 *
 * Type-only import of three.
 */
const standIns = new Map<string, Object3D>();

/** Registers `object` as drawing `bodyId`; returns the cleanup (a no-op without an object). */
export function registerStandIn(bodyId: string, object: Object3D | null): () => void {
  if (!object) return () => {};
  standIns.set(bodyId, object);
  return () => {
    if (standIns.get(bodyId) === object) standIns.delete(bodyId);
  };
}

/** The object drawing `bodyId` in a detail view, if any. */
export function standInFor(bodyId: string): Object3D | undefined {
  return standIns.get(bodyId);
}
