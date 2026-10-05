import {
  BoxGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  OctahedronGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The project overlay's models (P6-04), procedural, vertex-coloured, unlit (like the satellites:
 * they read the same on the night side), each about one unit tall along +y — the instance's axis
 * (`InstanceList`): the surface normal for a pin or a robot, outward for a buoy or a drone — and
 * scaled per instance.
 *
 * - **pin**: a task on a surface — a hexagonal pad and a mast; its glowing head (the task's state
 *   colour) is a separate glow instance at the top (`PIN_HEAD_Y`);
 * - **buoy**: a task in orbit — a small octahedral beacon in a ring; its glow is a glow instance;
 * - **robot**: a Steward on a surface — a tracked rover: chassis, cab, mast with a light (a glow
 *   instance at `ROBOT_LIGHT_Y`), an arm;
 * - **drone**: a Steward in orbit — a hub with four arms and rotor rings, a light underneath.
 * `simple` (the mobile tier): fewer segments.
 */

type Rgb = readonly [number, number, number];

function paint(g: BufferGeometry, rgb: Rgb): BufferGeometry {
  const n = g.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set(rgb, i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

function merge(parts: BufferGeometry[], what: string): BufferGeometry {
  // Every part indexed, or every part not (`mergeGeometries` needs them alike).
  const alike = parts.some((g) => !g.index) ? parts.map(nonIndexed) : parts;
  const merged = mergeGeometries(alike);
  alike.forEach((g) => {
    if (!parts.includes(g)) g.dispose();
  });
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error(`overlay ${what} geometry: incompatible parts`);
  merged.computeBoundingSphere();
  return merged;
}

function nonIndexed(g: BufferGeometry): BufferGeometry {
  return g.index ? g.toNonIndexed() : g;
}

const PAD: Rgb = [0.62, 0.66, 0.74];
const MAST: Rgb = [0.86, 0.89, 0.96];
const RING: Rgb = [0.55, 0.6, 0.7];
const HULL: Rgb = [1, 0.66, 0.3];
const DARK: Rgb = [0.3, 0.32, 0.38];
const METAL: Rgb = [0.75, 0.78, 0.84];

/** Where the pin's head sits (unit height). */
export const PIN_HEAD_Y = 1;
/** Where the robot's light sits (unit height). */
export const ROBOT_LIGHT_Y = 1.05;

export interface ModelDetail {
  simple: boolean;
}

const seg = (d: ModelDetail, full: number) => (d.simple ? Math.max(4, Math.round(full / 2)) : full);

export function pinGeometry(d: ModelDetail): BufferGeometry {
  const pad = new CylinderGeometry(0.42, 0.48, 0.1, 6);
  pad.translate(0, 0.05, 0);
  const mast = new CylinderGeometry(0.045, 0.06, 0.9, seg(d, 8));
  mast.translate(0, 0.55, 0);
  return merge([paint(pad, PAD), paint(mast, MAST)], 'pin');
}

export function buoyGeometry(d: ModelDetail): BufferGeometry {
  // A small core: the glowing state light (a glow instance) shows round it.
  const core = new OctahedronGeometry(0.22, 0);
  const ring = new TorusGeometry(0.62, 0.06, seg(d, 6), seg(d, 24));
  ring.rotateX(Math.PI / 2);
  return merge([paint(core, MAST), paint(ring, RING)], 'buoy');
}

export function robotGeometry(d: ModelDetail): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const add = (g: BufferGeometry, rgb: Rgb, x = 0, y = 0, z = 0) => {
    g.translate(x, y, z);
    parts.push(paint(g, rgb));
  };
  // Tracks, chassis, cab.
  add(new BoxGeometry(0.22, 0.2, 0.9), DARK, -0.36, 0.1, 0);
  add(new BoxGeometry(0.22, 0.2, 0.9), DARK, 0.36, 0.1, 0);
  add(new BoxGeometry(0.6, 0.24, 0.8), HULL, 0, 0.3, 0);
  add(new BoxGeometry(0.42, 0.22, 0.36), HULL, 0, 0.53, -0.16);
  // Mast (the light sits on top) and an arm reaching forward.
  add(new CylinderGeometry(0.03, 0.03, 0.4, seg(d, 6)), METAL, 0.16, 0.82, -0.2);
  const arm = new BoxGeometry(0.08, 0.08, 0.5);
  arm.rotateX(-0.5);
  add(arm, METAL, 0, 0.48, 0.42);
  return merge(parts, 'robot');
}

export function droneGeometry(d: ModelDetail): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const hub = new CylinderGeometry(0.22, 0.26, 0.2, seg(d, 8));
  parts.push(paint(hub, HULL));
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4;
    const arm = new BoxGeometry(0.62, 0.05, 0.07);
    arm.translate(0.31, 0, 0);
    arm.rotateY(angle);
    parts.push(paint(arm, METAL));
    const rotor = new TorusGeometry(0.17, 0.025, seg(d, 4), seg(d, 16));
    rotor.rotateX(Math.PI / 2);
    rotor.translate(Math.cos(angle) * 0.62, 0.04, -Math.sin(angle) * 0.62);
    parts.push(paint(rotor, DARK));
  }
  return merge(parts, 'drone');
}

/** The glowing heads and lights: a small octahedron, coloured per instance. */
export function glowGeometry(): BufferGeometry {
  return new OctahedronGeometry(0.5, 0);
}
