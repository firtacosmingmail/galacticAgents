import {
  BoxGeometry,
  Color,
  ConeGeometry,
  Float32BufferAttribute,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Matrix4,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BEAM, beamProfile } from './look.js';
import type { SatelliteFrame } from './director.js';

/**
 * The satellites' three.js pieces (P4-01): the shared geometries, and the per-frame write of a
 * `SatelliteFrame` into a body matrix, a beam matrix and their colours, used by both renderers
 * (a mesh pair per satellite, or the instanced meshes). Allocation-free per frame.
 */

/** Paints every vertex of `g` with one colour (the satellites are shaded by vertex colours). */
function paint(g: BufferGeometry, rgb: readonly [number, number, number]): BufferGeometry {
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set(rgb, i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

/**
 * A satellite one unit across: a bus with two solar panels along x and a small dish on the side
 * that faces its body (−y). Light bus, darker panels; the tint multiplies both.
 */
export function satelliteGeometry(): BufferGeometry {
  const bus = paint(new BoxGeometry(0.3, 0.3, 0.42), [1, 1, 1]);
  const left = paint(new BoxGeometry(0.34, 0.02, 0.24), [0.38, 0.5, 0.85]);
  left.translate(-0.33, 0, 0);
  const right = paint(new BoxGeometry(0.34, 0.02, 0.24), [0.38, 0.5, 0.85]);
  right.translate(0.33, 0, 0);
  const dish = paint(new ConeGeometry(0.12, 0.1, 10, 1, true), [0.85, 0.85, 0.85]);
  dish.translate(0, -0.2, 0);
  const merged = mergeGeometries([bus, left, right, dish]);
  [bus, left, right, dish].forEach((g) => g.dispose());
  if (!merged) throw new Error('satellite geometry: incompatible parts');
  merged.computeBoundingSphere();
  return merged;
}

/**
 * The beam: an open cone, apex at the origin, base one unit down (−y) with radius 1, brightest at
 * the apex: the vertex colours follow `beamProfile` down `BEAM.segments` rings (a steep falloff to
 * `BEAM.baseFade` at the base). Scaled per frame to reach the body's surface.
 */
export function beamGeometry(): BufferGeometry {
  const cone = new ConeGeometry(1, 1, 20, BEAM.segments, true);
  cone.translate(0, -0.5, 0);
  const pos = cone.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const v = beamProfile(-pos.getY(i)); // along: 0 at the apex, 1 at the base
    colors.set([v, v, v], i * 3);
  }
  cone.setAttribute('color', new Float32BufferAttribute(colors, 3));
  cone.computeBoundingSphere();
  return cone;
}

const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const dir = new Vector3();
const axis = new Vector3();
const pos = new Vector3();
const scale = new Vector3();
const quat = new Quaternion();
const tilt = new Quaternion();

/** The satellite's matrix: at its position, its −y (dish) facing its target, `size` across. */
export function bodyMatrix(f: SatelliteFrame, out: Matrix4): Matrix4 {
  pos.set(f.position[0], f.position[1], f.position[2]);
  if (!f.visible) return out.makeScale(0, 0, 0);
  dir.set(f.target[0] - pos.x, f.target[1] - pos.y, f.target[2] - pos.z);
  if (dir.lengthSq() < 1e-12) dir.copy(DOWN);
  quat.setFromUnitVectors(DOWN, dir.normalize());
  return out.compose(pos, quat, scale.setScalar(f.size));
}

/**
 * The beam's matrix: apex at the satellite, swung by `sweep` across the surface, reaching the
 * body's surface, `BEAM.width` body radii wide there. A zero scale while the beam is off.
 */
export function beamMatrix(f: SatelliteFrame, out: Matrix4): Matrix4 {
  if (!f.visible || f.beam <= 0) return out.makeScale(0, 0, 0);
  pos.set(f.position[0], f.position[1], f.position[2]);
  dir.set(f.target[0] - pos.x, f.target[1] - pos.y, f.target[2] - pos.z);
  const distance = dir.length();
  if (distance < 1e-6) return out.makeScale(0, 0, 0);
  dir.divideScalar(distance);
  if (f.sweep !== 0) {
    axis.crossVectors(dir, Math.abs(dir.y) > 0.95 ? X : UP).normalize();
    dir.applyQuaternion(tilt.setFromAxisAngle(axis, f.sweep));
  }
  quat.setFromUnitVectors(DOWN, dir);
  const length = Math.max(0.05 * f.bodyRadius, distance - f.bodyRadius * 0.97);
  const width = BEAM.width * f.bodyRadius;
  return out.compose(pos, quat, scale.set(width, length, width));
}

const tintCache = new Map<string, Color>();

/** The satellite's colour: its tint times its brightness, written into `out`. */
export function bodyColor(f: SatelliteFrame, out: Color): Color {
  let base = tintCache.get(f.tint);
  if (!base) {
    base = new Color(f.tint);
    tintCache.set(f.tint, base);
  }
  return out.copy(base).multiplyScalar(f.brightness);
}

/** The beam's colour (`f.beamTint`; additive: brightness is strength), with or without bloom. */
export function beamColor(f: SatelliteFrame, bloom: boolean, out: Color): Color {
  const gain = (bloom ? BEAM.bloomGain : BEAM.plainGain) * f.beam;
  const c = f.beamTint;
  return out.setRGB(c[0] * gain, c[1] * gain, c[2] * gain);
}
