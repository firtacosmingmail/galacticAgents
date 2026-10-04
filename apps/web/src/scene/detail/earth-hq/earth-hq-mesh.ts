import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Earth's detail HQ station (P6-05), procedural (no assets): the system HQ's model (P4-02,
 * `satellites/hq/hq-mesh.ts`) grown into a station seen up close. About one unit across, like the
 * system one, so the Harmonizer's frame `size` scales it to the same footprint — its pick sphere
 * and hover ring still fit — and its −y faces Earth (the satellites' orientation, `bodyMatrix`).
 * Shaded by vertex colours under the state's tint, like every satellite.
 *
 * Four geometries:
 * - **core**: a spine with two habitation modules and a node, a top module (the strobe sits on
 *   it), a dish and mast toward Earth, a **docking ring** with two docking ports, radiators, and a
 *   truss carrying **four solar arrays** (two panels a side, cells in two shades);
 * - **ring**: the habitat torus, eight light and dark segments and four spokes, turning about the
 *   spine (`hqRingMatrix`, shared with the system HQ);
 * - **nav**: the port (red) and starboard (green) lights at the arrays' tips;
 * - **strobe**: the white light on the top module.
 * Plus `glowGeometry`, a disc whose vertex colours fade from the centre, drawn additively facing
 * the camera: the thinking glow.
 *
 * `simple` (the mobile tier): fewer segments, two arrays instead of four, no docking ports or
 * radiators — the silhouette and the turning ring stay.
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
  const merged = mergeGeometries(parts); // every part is an indexed primitive
  parts.forEach((g) => g.dispose());
  if (!merged) throw new Error(`Earth HQ ${what} geometry: incompatible parts`);
  merged.computeBoundingSphere();
  return merged;
}

const HULL: Rgb = [1, 1, 1];
const MODULE: Rgb = [0.86, 0.89, 0.96];
const METAL: Rgb = [0.7, 0.72, 0.78];
const DARK_METAL: Rgb = [0.45, 0.48, 0.56];
const CELL_A: Rgb = [0.32, 0.45, 0.85];
const CELL_B: Rgb = [0.22, 0.33, 0.7];

/** The habitat ring's radius (the spine is y), as the system HQ's. */
export const EARTH_HQ_RING_RADIUS = 0.24;
/** The solar arrays' outer tips (x), where the navigation lights sit. */
export const EARTH_HQ_SPAN = 0.52;
/** The truss's height on the spine. */
const TRUSS_Y = 0.22;

export interface StationDetail {
  simple: boolean;
}

/** The radial segment count, by detail. */
const seg = (d: StationDetail, full: number) => (d.simple ? Math.max(6, full / 2) : full);

export function earthHqCoreGeometry(detail: StationDetail): BufferGeometry {
  const s = (n: number) => seg(detail, n);
  const parts: BufferGeometry[] = [];
  const add = (g: BufferGeometry, rgb: Rgb, x = 0, y = 0, z = 0) => {
    g.translate(x, y, z);
    parts.push(paint(g, rgb));
  };
  // Spine, habitation modules, node, top module.
  add(new CylinderGeometry(0.05, 0.05, 0.66, s(16)), HULL);
  add(new CylinderGeometry(0.085, 0.085, 0.13, s(16)), MODULE, 0, 0.1);
  add(new CylinderGeometry(0.08, 0.08, 0.11, s(16)), MODULE, 0, -0.07);
  add(new SphereGeometry(0.07, s(12), s(8)), HULL, 0, TRUSS_Y);
  add(new CylinderGeometry(0.06, 0.07, 0.07, s(16)), MODULE, 0, 0.31);
  // Toward Earth: the dish and its mast.
  add(new ConeGeometry(0.11, 0.07, s(16), 1, true), METAL, 0, -0.36);
  add(new CylinderGeometry(0.006, 0.006, 0.08, 4), METAL, 0, -0.42);
  // The docking ring under the modules, in the xz plane.
  const dock = new TorusGeometry(0.105, 0.016, s(8), s(32));
  dock.rotateX(Math.PI / 2);
  add(dock, DARK_METAL, 0, -0.25);
  // The truss across the spine, and the solar arrays: two panels a side (one when simple).
  add(new BoxGeometry(2 * EARTH_HQ_SPAN, 0.022, 0.022), METAL, 0, TRUSS_Y);
  const panels = detail.simple ? [0.36] : [0.26, 0.43];
  for (const side of [-1, 1]) {
    for (const x of panels) {
      const width = detail.simple ? 0.28 : 0.15;
      // Two cells deep, in two shades, with a thin frame between them.
      add(new BoxGeometry(width, 0.008, 0.11), CELL_A, side * x, TRUSS_Y, 0.065);
      add(new BoxGeometry(width, 0.008, 0.11), CELL_B, side * x, TRUSS_Y, -0.065);
    }
  }
  if (!detail.simple) {
    // Docking ports on the node (±z) and radiators along the lower module (±x).
    for (const side of [-1, 1]) {
      const port = new CylinderGeometry(0.03, 0.03, 0.08, 10);
      port.rotateX(Math.PI / 2);
      add(port, MODULE, 0, TRUSS_Y, side * 0.1);
      add(new BoxGeometry(0.006, 0.12, 0.16), HULL, side * 0.13, -0.07);
    }
  }
  return merge(parts, 'core');
}

export function earthHqRingGeometry(detail: StationDetail): BufferGeometry {
  const torus = new TorusGeometry(EARTH_HQ_RING_RADIUS, 0.03, seg(detail, 10), seg(detail, 64));
  torus.rotateX(Math.PI / 2); // in the xz plane, around the spine
  // Eight segments, light and dark in turn, so the ring's turning shows.
  const pos = torus.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const angle = Math.atan2(pos.getZ(i), pos.getX(i)) + Math.PI;
    const light = Math.floor((angle / (2 * Math.PI)) * 8) % 2 === 0;
    colors.set(light ? [1, 1, 1] : [0.4, 0.45, 0.56], i * 3);
  }
  torus.setAttribute('color', new Float32BufferAttribute(colors, 3));
  const parts: BufferGeometry[] = [torus];
  const spokes = detail.simple ? 2 : 4;
  for (let i = 0; i < spokes; i++) {
    const spoke = paint(new BoxGeometry(EARTH_HQ_RING_RADIUS * 2, 0.014, 0.014), METAL);
    spoke.rotateY((i * Math.PI) / spokes);
    parts.push(spoke);
  }
  return merge(parts, 'ring');
}

/** The port (red, −x) and starboard (green, +x) lights at the arrays' tips. */
export function earthHqNavGeometry(detail: StationDetail): BufferGeometry {
  const parts = [-1, 1].map((side) => {
    const light = paint(
      new SphereGeometry(0.022, seg(detail, 8), seg(detail, 6)),
      side < 0 ? [1, 0.15, 0.12] : [0.15, 1, 0.3],
    );
    light.translate(side * (EARTH_HQ_SPAN + 0.02), TRUSS_Y, 0);
    return light;
  });
  return merge(parts, 'nav');
}

/** The white strobe on the top module. */
export function earthHqStrobeGeometry(detail: StationDetail): BufferGeometry {
  const strobe = paint(new SphereGeometry(0.024, seg(detail, 8), seg(detail, 6)), [1, 1, 1]);
  strobe.translate(0, 0.37, 0);
  return strobe;
}

/** Where the glow sits on the station (the node, at the truss). */
export const EARTH_HQ_GLOW_CENTER: readonly [number, number, number] = [0, TRUSS_Y * 0.5, 0];
/** The glow disc's radius, in station units. */
export const EARTH_HQ_GLOW_RADIUS = 0.55;

/** The glow: a unit disc in the xy plane, white at the centre fading to black at the rim. */
export function glowGeometry(): BufferGeometry {
  // Rings of vertices (not a fan from the centre), so the falloff is a curve, not a cone.
  const disc = new RingGeometry(0, 1, 32, 6);
  const pos = disc.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const r = Math.min(1, Math.hypot(pos.getX(i), pos.getY(i)));
    const v = (1 - r) ** 2;
    colors.set([v, v, v], i * 3);
  }
  disc.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return disc;
}
