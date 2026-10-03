import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Matrix4,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The HQ station's model (P4-02), procedural, about one unit across like a satellite (the frame's
 * `size` scales it), shaded by vertex colours under the state's tint. Its −y faces Earth (the
 * same orientation as a satellite, `bodyMatrix`). Two meshes: the **core** (hub, top module, a
 * dish toward Earth, a truss with two solar wings, a beacon) and the **ring** (a habitat torus with
 * light and dark segments and two spokes), which turns about the hub's axis — the segments make
 * the turning visible.
 */

function paint(g: BufferGeometry, rgb: readonly [number, number, number]): BufferGeometry {
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set(rgb, i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

function merge(parts: BufferGeometry[], what: string): BufferGeometry {
  const merged = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error(`HQ ${what} geometry: incompatible parts`);
  merged.computeBoundingSphere();
  return merged;
}

/** The ring's radius (the hub's axis is y). */
export const HQ_RING_RADIUS = 0.24;

export function hqCoreGeometry(): BufferGeometry {
  const hub = paint(new CylinderGeometry(0.07, 0.07, 0.56, 12), [1, 1, 1]);
  const top = paint(new CylinderGeometry(0.1, 0.1, 0.12, 12), [0.85, 0.88, 0.95]);
  top.translate(0, 0.2, 0);
  const dish = paint(new ConeGeometry(0.1, 0.08, 12, 1, true), [0.8, 0.8, 0.82]);
  dish.translate(0, -0.31, 0);
  const truss = paint(new BoxGeometry(0.9, 0.025, 0.025), [0.7, 0.72, 0.78]);
  truss.translate(0, 0.2, 0);
  const wings = [-1, 1].map((side) => {
    const wing = paint(new BoxGeometry(0.22, 0.012, 0.18), [0.38, 0.5, 0.85]);
    wing.translate(side * 0.36, 0.2, 0);
    return wing;
  });
  const beacon = paint(new SphereGeometry(0.035, 8, 6), [1, 1, 1]);
  beacon.translate(0, 0.3, 0);
  return merge([hub, top, dish, truss, ...wings, beacon], 'core');
}

export function hqRingGeometry(): BufferGeometry {
  const torus = new TorusGeometry(HQ_RING_RADIUS, 0.032, 6, 36);
  torus.rotateX(Math.PI / 2); // in the xz plane, around the hub's axis
  // Six segments, light and dark in turn, so the ring's turning shows.
  const pos = torus.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const angle = Math.atan2(pos.getZ(i), pos.getX(i)) + Math.PI;
    const light = Math.floor((angle / (2 * Math.PI)) * 6) % 2 === 0;
    colors.set(light ? [1, 1, 1] : [0.42, 0.47, 0.58], i * 3);
  }
  torus.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const spokeX = paint(new BoxGeometry(HQ_RING_RADIUS * 2, 0.016, 0.016), [0.7, 0.72, 0.78]);
  const spokeZ = paint(new BoxGeometry(0.016, 0.016, HQ_RING_RADIUS * 2), [0.7, 0.72, 0.78]);
  return merge([torus, spokeX, spokeZ], 'ring');
}

const spin = new Matrix4();

/** The ring's matrix: the core's, turned by `angle` about the hub's axis (y). */
export function hqRingMatrix(core: Matrix4, angle: number, out: Matrix4): Matrix4 {
  return out.multiplyMatrices(core, spin.makeRotationY(angle));
}
