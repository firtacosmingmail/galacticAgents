import type { Material, Object3D, Plane } from 'three';
import { isCutMesh } from './target.js';

/**
 * The cutaway's material bookkeeping (P6-03): which materials of the shown body carry the wedge's
 * two clipping planes. Three compiles a program per number of clipping planes and per
 * `clipIntersection`, so assigning or removing them recompiles the body's materials. To keep
 * opening, closing and the fade free of recompiles, the planes stay assigned (with
 * `clipIntersection` on) for as long as the part is mounted, and a closed cut **parks** them
 * (`parkPlanes`): pushed so far out that every point is on their kept side, they remove nothing.
 * The planes are taken back (`unclip`) only when the part unmounts (the view is left), and from a
 * material that is no longer on the body (`clipBody` prunes it: a level change swaps the material).
 */

/** How far out a parked plane sits, world units: well beyond any scene distance. */
export const PARKED_CONSTANT = 1e9;

/** Moves the planes so they clip nothing: every point's signed distance is positive. */
export function parkPlanes(planes: readonly Plane[]): void {
  for (const plane of planes) {
    plane.normal.set(0, 1, 0);
    plane.constant = PARKED_CONSTANT;
  }
}

/**
 * The materials carrying the planes, with the frame (`stamp`) they were last seen on the body; a
 * material not seen in the latest scan has been swapped out.
 */
export type ClippedMaterials = Map<Material, number>;

/**
 * Gives the body's cut meshes' materials the planes (an assignment only when a material does not
 * have them yet), skipping another body's subtree (a moon), and takes them back from materials no
 * longer on the body. `stamp` identifies this scan (a frame counter).
 */
export function clipBody(
  group: Object3D,
  bodyId: string,
  planes: Plane[],
  clipped: ClippedMaterials,
  stamp: number,
): void {
  const visit = (o: Object3D) => {
    if (o !== group && typeof o.userData.bodyId === 'string' && o.userData.bodyId !== bodyId)
      return;
    if (isCutMesh(o)) {
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (m.clippingPlanes !== planes) m.clippingPlanes = planes;
        m.clipIntersection = true;
        clipped.set(m, stamp);
      }
    }
    for (const child of o.children) visit(child);
  };
  visit(group);
  for (const [m, seen] of clipped) {
    if (seen === stamp) continue;
    release(m);
    clipped.delete(m);
  }
}

/** Takes the planes back from every material (the part unmounting). */
export function unclip(clipped: ClippedMaterials): void {
  for (const m of clipped.keys()) release(m);
  clipped.clear();
}

function release(m: Material): void {
  m.clippingPlanes = null;
  m.clipIntersection = false;
}
