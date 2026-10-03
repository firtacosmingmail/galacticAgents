import { mulberry32 } from '@galactic/protocol';
import {
  Color,
  Euler,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
  type InstancedMesh,
} from 'three';
import type { ScaleMode } from '../scale.js';
import { rockPositions, ROCK_STRIDE, type BackgroundBelt } from './belt-model.js';

/**
 * The three.js side of the belt (P3-03): the rock geometry and the instance buffers. Kept apart
 * from `Belt.tsx` so the instancing is testable in jsdom (three's math runs without WebGL).
 */

/**
 * A lumpy rock: an icosahedron (flat-shaded later) whose vertices are pushed in or out by a
 * seeded amount. The geometry is not indexed (a corner repeats in every face that meets there),
 * so the jitter is chosen per corner position: every copy of a corner moves together and the
 * surface stays closed. Unit radius, give or take the jitter.
 */
export function rockGeometry(seed: number, detail = 0, jitter = 0.28): IcosahedronGeometry {
  const geometry = new IcosahedronGeometry(1, detail);
  const pos = geometry.getAttribute('position');
  const rand = mulberry32(seed);
  const byCorner = new Map<string, number>();
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    let k = byCorner.get(key);
    if (k === undefined) {
      k = 1 - jitter / 2 + rand() * jitter;
      byCorner.set(key, k);
    }
    v.multiplyScalar(k);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

const WARM = new Color('#8a6a4c');
const GREY = new Color('#7d7a76');

/**
 * Writes every rock's matrix (orbit position at `mode`, rotation, size × squash) and colour into
 * the instanced mesh, then recomputes its bounding sphere so frustum culling sees the whole ring
 * (InstancedMesh's sphere covers all instances, not the unit rock).
 */
export function writeBeltInstances(mesh: InstancedMesh, belt: BackgroundBelt, mode: ScaleMode) {
  const positions = rockPositions(belt, mode);
  const m = new Matrix4();
  const p = new Vector3();
  const q = new Quaternion();
  const e = new Euler();
  const s = new Vector3();
  const c = new Color();
  const count = Math.min(belt.count, mesh.instanceMatrix.count);
  for (let i = 0; i < count; i++) {
    const o = i * ROCK_STRIDE;
    const d = belt.data;
    const size = d[o + 3]!;
    p.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
    q.setFromEuler(e.set(d[o + 7]!, d[o + 8]!, d[o + 9]!));
    s.set(size * d[o + 4]!, size * d[o + 5]!, size * d[o + 6]!);
    mesh.setMatrixAt(i, m.compose(p, q, s));
    c.copy(GREY)
      .lerp(WARM, d[o + 10]!)
      .multiplyScalar(d[o + 11]! / 0.6);
    mesh.setColorAt(i, c);
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
}
