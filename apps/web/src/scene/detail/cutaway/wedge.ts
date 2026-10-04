/**
 * The cutaway's geometry and timing as plain numbers (P6-03; no three.js, testable): the wedge
 * that is removed, the clipping planes that remove it, the two cut faces with their bands, the
 * open/close animation and where the labels go.
 *
 * Frame: the body's own (y along its spin axis, x–z its equator), radius 1. The wedge is the
 * slice between the azimuths `a` and `b = a + angle` about the axis (azimuth φ measured from +x
 * towards +z), through both poles; it faces the camera (centred `WEDGE_TURN` off its azimuth).
 */

/** The wedge's full opening: a quarter of the body. */
export const WEDGE_ANGLE = Math.PI / 2;
/**
 * The wedge is centred this far round from the camera's azimuth, so the two cut faces are seen at
 * different angles (one nearly face-on, the other glancing) and the cut reads as a solid, not as a
 * flat disc split down the middle.
 */
export const WEDGE_TURN = (20 * Math.PI) / 180;
/** Seconds to open or close (instant with reduced motion). */
export const OPEN_S = 0.6;

export interface Wedge {
  /** Azimuths of the two cut faces, radians (`b - a` is the opening). */
  a: number;
  b: number;
}

/** The wedge centred on `azimuth` with this opening. */
export function wedgeAbout(azimuth: number, angle: number): Wedge {
  return { a: azimuth - angle / 2, b: azimuth + angle / 2 };
}

/** The camera's azimuth about the axis, from its position in the body's frame. */
export function azimuthOf(x: number, z: number): number {
  return Math.atan2(z, x);
}

/**
 * The two clipping planes (normal x, y, z; constant 0: through the centre) whose *intersection*
 * of negative sides is the wedge — three's `clipIntersection`: a point is removed only when its
 * signed distance to every plane is negative. n·p < 0 ⇔ φ > a for the first, φ < b for the second
 * (for an opening under π).
 */
export function wedgePlanes(w: Wedge): [[number, number, number], [number, number, number]] {
  return [
    [Math.sin(w.a), 0, -Math.cos(w.a)],
    [-Math.sin(w.b), 0, Math.cos(w.b)],
  ];
}

/** Whether a point of the body's frame is inside the removed wedge (what the planes clip). */
export function inWedge(w: Wedge, p: readonly [number, number, number]): boolean {
  const [n1, n2] = wedgePlanes(w);
  const d1 = n1[0] * p[0] + n1[1] * p[1] + n1[2] * p[2];
  const d2 = n2[0] * p[0] + n2[1] * p[1] + n2[2] * p[2];
  return d1 < 0 && d2 < 0;
}

/**
 * The animation's next openness (0 closed … 1 open) towards `target` after `dt` seconds: linear in
 * time over `OPEN_S`, eased when drawn (`easeOpen`). Reduced motion jumps straight to the target.
 */
export function stepOpen(open: number, target: number, dt: number, reducedMotion: boolean): number {
  if (reducedMotion || OPEN_S <= 0) return target;
  const step = Math.max(0, dt) / OPEN_S;
  return target > open ? Math.min(target, open + step) : Math.max(target, open - step);
}

/** Smoothstep easing of the openness. */
export function easeOpen(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * How much of the cutaway the detail view's cross-fade lets show: none in the system view, all of
 * it once the view is in (the cut closes as the view fades out and opens once it has faded in).
 */
export function mixGate(mix: number): number {
  return easeOpen((mix - 0.6) / 0.4);
}

/**
 * One cut face: the half disc on the +x side of the face's x–y plane (x outward along the face's
 * azimuth, y the axis), as concentric half annuli, one per band, `segments` steps from pole to
 * pole. `radii` are the bands' outer radii, outermost first (the last band reaches the centre);
 * `colors` their linear RGB. Non-indexed triangles: positions and colours, three floats a vertex.
 */
export function faceGeometry(
  radii: readonly number[],
  colors: readonly (readonly [number, number, number])[],
  segments: number,
): { positions: Float32Array; colors: Float32Array } {
  const pos: number[] = [];
  const col: number[] = [];
  const at = (r: number, t: number): [number, number, number] => {
    const angle = -Math.PI / 2 + (t / segments) * Math.PI;
    return [r * Math.cos(angle), r * Math.sin(angle), 0];
  };
  for (const [i, outer] of radii.entries()) {
    const inner = radii[i + 1] ?? 0;
    const c = colors[i] ?? [1, 1, 1];
    for (let s = 0; s < segments; s++) {
      const o0 = at(outer, s);
      const o1 = at(outer, s + 1);
      const quad: [number, number, number][] =
        inner > 0
          ? [o0, at(inner, s), o1, o1, at(inner, s), at(inner, s + 1)]
          : [o0, [0, 0, 0], o1];
      for (const v of quad) {
        pos.push(v[0], v[1], v[2]);
        col.push(c[0], c[1], c[2]);
      }
    }
  }
  return { positions: new Float32Array(pos), colors: new Float32Array(col) };
}

/** The labels sit on the first cut face, along a line this far above the equator. */
export const LABEL_ELEVATION = (35 * Math.PI) / 180;

/**
 * Where a band's label points, in the body's frame (radius 1): the middle of the band, on the cut
 * face at azimuth `a`, `LABEL_ELEVATION` above the equator.
 */
export function labelPoint(
  outer: number,
  inner: number,
  a: number,
  out: [number, number, number] = [0, 0, 0],
): [number, number, number] {
  const r = (outer + inner) / 2;
  const flat = r * Math.cos(LABEL_ELEVATION);
  out[0] = flat * Math.cos(a);
  out[1] = r * Math.sin(LABEL_ELEVATION);
  out[2] = flat * Math.sin(a);
  return out;
}

/**
 * Screen de-clutter for the labels: their y positions (CSS pixels, label centres) pushed apart so
 * no two are closer than `gap`, keeping their order and moving as little as possible (each one
 * only down from the one above, then the stack back up by half its overflow). In place; returns it.
 */
export function spreadVertically(ys: number[], gap: number): number[] {
  const order = ys.map((_, i) => i).sort((i, j) => ys[i]! - ys[j]!);
  const placed = order.map((i) => ys[i]!);
  for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k]!, placed[k - 1]! + gap);
  let shift = 0;
  for (let k = 0; k < placed.length; k++) shift = Math.max(shift, placed[k]! - ys[order[k]!]!);
  for (let k = 0; k < placed.length; k++) ys[order[k]!] = placed[k]! - shift / 2;
  return ys;
}
