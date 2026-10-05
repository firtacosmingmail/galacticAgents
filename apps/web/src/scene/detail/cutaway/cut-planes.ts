import type { Plane } from 'three';

/**
 * The cutaway's two world-space clipping planes, shared (P6-04): the project overlay clips its
 * surface markers and Steward robots with the same planes, so what stands on the removed wedge of
 * crust goes with it, and leaves out of picking what is cut. The planes are the cutaway's own
 * objects, rewritten in place every frame (parked — removing nothing — while the cut is closed);
 * `undefined` while no cutaway is mounted. Type-only three import.
 */
let planes: readonly Plane[] | undefined;

export function publishCutPlanes(next: readonly Plane[] | undefined): void {
  planes = next;
}

/**
 * Withdraws `own` if it is still the published set (a cutaway unmounting). When the detail scene
 * swaps bodies in one commit, the new cutaway may publish before the old one's cleanup runs: the
 * old one never withdraws the new one's planes.
 */
export function withdrawCutPlanes(own: readonly Plane[] | undefined): void {
  if (own !== undefined && planes === own) planes = undefined;
}

export function cutPlanes(): readonly Plane[] | undefined {
  return planes;
}
