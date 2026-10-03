import { useState, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Vector3, type Object3D } from 'three';
import type { LodConfig } from '../quality.js';

/**
 * Level-of-detail selection for planets and moons (P3-06). Distances are in body radii (camera
 * to the body's centre ÷ its visual radius), so the same table works for a giant and a small moon
 * and in both scales (true scale's tiny bodies stay far-level until the camera is right on them).
 *
 * Why not three's `LOD` or drei's `<Detailed>`: those swap child objects by distance, while here a
 * level also means a texture painted lazily in a worker, and the swap must leave the body's anchor
 * group (registered once, `anchors.ts`) and its mesh untouched: only the mesh's geometry and the
 * material's maps change.
 */

/**
 * The level for a camera `distance` (in body radii), given the level shown now: levels are
 * nearest first, level i holding while `distance < levels[i].within`. Moving to a nearer level
 * needs the distance to drop `hysteresis` (a fraction) below that level's boundary, moving to a
 * farther one needs it to rise as far above the current level's boundary, so a camera parked on a
 * boundary does not flicker between two levels.
 */
export function selectLodLevel(
  distance: number,
  levels: readonly { within: number }[],
  current: number,
  hysteresis: number,
): number {
  const last = levels.length - 1;
  let level = Math.max(0, Math.min(last, Number.isFinite(current) ? Math.trunc(current) : last));
  while (level > 0 && distance < levels[level - 1]!.within * (1 - hysteresis)) level--;
  while (level < last && distance > levels[level]!.within * (1 + hysteresis)) level++;
  return level;
}

/** The camera's distance from `object`'s world position, in units of `radius`. */
export function distanceInRadii(
  object: Object3D,
  cameraPosition: Vector3,
  radius: number,
  scratch: Vector3,
): number {
  scratch.setFromMatrixPosition(object.matrixWorld);
  return scratch.distanceTo(cameraPosition) / Math.max(radius, 1e-6);
}

/**
 * The LOD level a body shows, re-evaluated every rendered frame from the camera's distance to
 * `ref` (the body's anchor group; read only). Starts at the farthest level; a change re-renders
 * the body (rare: crossing a boundary), and nothing in the anchor binding depends on it.
 */
export function useLodLevel(
  ref: RefObject<Object3D | null>,
  radius: number,
  lod: LodConfig,
): number {
  const far = lod.levels.length - 1;
  const [state, setState] = useState({ lod, level: far });
  // A tier change starts again from the farthest level of the new table.
  const shown = state.lod === lod ? Math.min(state.level, far) : far;
  const [scratch] = useState(() => new Vector3());
  useFrame(({ camera }) => {
    const object = ref.current;
    if (!object) return;
    const d = distanceInRadii(object, camera.position, radius, scratch);
    const next = selectLodLevel(d, lod.levels, shown, lod.hysteresis);
    if (next !== shown || state.lod !== lod) setState({ lod, level: next });
  });
  return shown;
}
