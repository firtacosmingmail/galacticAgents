import type { Vec3Tuple } from '../../orbit.js';

/**
 * The HQ station's **viewing slot** in Earth's detail view (P6-06; SPEC decision 89; notes in
 * `docs/tasks/notes/P6-06-07-detail-view.md`). No three.js.
 *
 * At the detail framing (`DETAIL_FRAME_RADII`, 2.85 radii) Earth fills most of the view, and the
 * station on its 1.8-radii shell was on screen only while it passed the limb: about 9 % of its
 * orbit in a square canvas, about half in a 2:1 one (measured, P6-06 notes). So while Earth is
 * shown in detail the station leaves its orbit for a place **fixed in the view**: on the line of
 * sight through `HQ_SLOT.ndc` (right of and above the centre of the canvas), at the depth of
 * Earth's centre when that point is clear of Earth by `HQ_SLOT.clearance` (wide canvases: the
 * station floats beside the globe; in a very wide one pulled in to `HQ_SLOT.maxReach`, inside the
 * Moon's orbit), otherwise nearer the camera, where that line of sight first
 * comes within `clearance` of Earth's centre (narrow canvases: the station floats in front of the
 * globe's upper-right limb). When the camera is so close that no such point lies at least
 * `HQ_SLOT.minDistance` in front of it, there is no slot and the station keeps its orbit.
 *
 * The slot is applied to the Harmonizer's satellite frame itself (`overrideHqPose`), so picking,
 * the hover card and ring, the click (select the Harmonizer, open its chat) and the beam's apex
 * all follow it. `HqSlotter` blends it in with the cross-fade (the station flies from its orbit
 * to the slot while the view fades in, and back on the way out) and follows the camera with a
 * short lag (`HQ_SLOT.followS`), so it drifts back into place after the user turns the view
 * instead of being pasted onto the screen; under reduced motion it snaps.
 */
export const HQ_SLOT = {
  /** The slot's place on the canvas, normalised device coordinates (−1…1; +y up). */
  ndc: [0.7, 0.55] as const,
  /** The slot is at least this many Earth radii from Earth's centre (glow 1.035 + half the station 0.21 + a gap). */
  clearance: 1.35,
  /**
   * …and at most this many (a very wide canvas pulls the slot's x in): clear of the Moon, whose
   * orbit (2.21 R, radius 0.26 R in the readable layout) comes no nearer Earth's centre than
   * 1.94 R — less half the station (0.21 R) and a small gap.
   */
  maxReach: 1.7,
  /** …and at least this many Earth radii in front of the camera. */
  minDistance: 0.9,
  /** Seconds the station takes to follow (≈ 63 %) a change of the slot (the camera turning). */
  followS: 0.35,
} as const;

/** The camera as the slot needs it: position, unit axes (right, up, forward) and its field. */
export interface SlotCamera {
  position: Vec3Tuple;
  right: Vec3Tuple;
  up: Vec3Tuple;
  forward: Vec3Tuple;
  /** tan(vertical field of view / 2). */
  tanHalfFov: number;
  /** Width / height. */
  aspect: number;
}

/** The slot's line of sight (unit, world), rewritten by `sight` (no allocation per frame). */
const dir: Vec3Tuple = [0, 0, 0];

/** `dir` ← the unit line of sight through the view-plane offsets `x`, `y` (tan units). */
function sight(camera: SlotCamera, x: number, y: number): void {
  const d0 = camera.forward[0] + x * camera.right[0] + y * camera.up[0];
  const d1 = camera.forward[1] + x * camera.right[1] + y * camera.up[1];
  const d2 = camera.forward[2] + x * camera.right[2] + y * camera.up[2];
  const len = Math.hypot(d0, d1, d2);
  dir[0] = d0 / len;
  dir[1] = d1 / len;
  dir[2] = d2 / len;
}

/**
 * The slot for a camera and Earth (`centre`, visual radius `radius`): its world position, written
 * into `out`, and the returned **size factor** — the station is drawn the size it would look at
 * the depth of Earth's centre (1 there; below 1 when the slot comes nearer the camera, so in a
 * narrow canvas it does not loom over the globe). `undefined` when there is no slot (the camera
 * too close to Earth). In a canvas so wide that the slot's pixel at Earth's depth is farther than
 * `HQ_SLOT.maxReach` from Earth's centre, the slot's x is pulled in until it is not (its height
 * stays): the station never meets the Moon's orbit.
 */
export function hqSlot(
  camera: SlotCamera,
  centre: readonly [number, number, number],
  radius: number,
  out: Vec3Tuple,
): number | undefined {
  // The line of sight through the slot's pixel: forward + x·right + y·up (`sight`).
  let x = HQ_SLOT.ndc[0] * camera.tanHalfFov * camera.aspect;
  const y = HQ_SLOT.ndc[1] * camera.tanHalfFov;
  // Earth's centre from the camera, and its depth along the view axis.
  const c0 = centre[0] - camera.position[0];
  const c1 = centre[1] - camera.position[1];
  const c2 = centre[2] - camera.position[2];
  const depth = c0 * camera.forward[0] + c1 * camera.forward[1] + c2 * camera.forward[2];
  const reach = HQ_SLOT.maxReach * radius;
  let level = 0;
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  // At the depth of Earth's centre, x pulled in while that is beyond the reach (exact in one step
  // when the camera looks at Earth's centre, as the detail view's does; a few for an offset one).
  for (let i = 0; i < 4; i++) {
    sight(camera, x, y);
    const cosine =
      dir[0] * camera.forward[0] + dir[1] * camera.forward[1] + dir[2] * camera.forward[2];
    level = depth / cosine;
    p0 = dir[0] * level - c0;
    p1 = dir[1] * level - c1;
    p2 = dir[2] * level - c2;
    if (Math.hypot(p0, p1, p2) <= reach * (1 + 1e-9) || !(depth > 0)) break;
    // Its offsets across the view: the upward one kept, the rightward one shortened.
    const px = p0 * camera.right[0] + p1 * camera.right[1] + p2 * camera.right[2];
    const py = p0 * camera.up[0] + p1 * camera.up[1] + p2 * camera.up[2];
    if (!(px > 1e-12)) break;
    x *= Math.sqrt(Math.max(0, reach * reach - py * py)) / px;
  }
  // Earth's centre along the line of sight (`along`) and off it (`off`).
  const along = c0 * dir[0] + c1 * dir[1] + c2 * dir[2];
  const off = Math.sqrt(Math.max(0, c0 * c0 + c1 * c1 + c2 * c2 - along * along));
  const clearance = HQ_SLOT.clearance * radius;
  let t = level;
  // …unless that is too close to Earth: then where the line first comes within `clearance` (it
  // does: the line's nearest point to the centre, `off` away, is no farther than that point).
  if (Math.hypot(p0, p1, p2) < clearance) t = along - Math.sqrt(clearance * clearance - off * off);
  if (!(t >= HQ_SLOT.minDistance * radius)) return undefined;
  out[0] = camera.position[0] + dir[0] * t;
  out[1] = camera.position[1] + dir[1] * t;
  out[2] = camera.position[2] + dir[2] * t;
  return Math.min(1, t / level);
}

/**
 * `a` → `b` by `t` (0…1) about the origin, written into `out`: the direction turns along the great
 * circle and the length changes linearly, so the path never comes nearer the origin than the
 * shorter of the two — a straight line from the orbit's far side to the slot would cut through
 * Earth. Opposite directions turn about an axis perpendicular to `a`.
 */
export function swing(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
  out: Vec3Tuple,
): Vec3Tuple {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  if (la < 1e-9 || lb < 1e-9 || t >= 1) {
    out[0] = a[0] + (b[0] - a[0]) * Math.min(1, t);
    out[1] = a[1] + (b[1] - a[1]) * Math.min(1, t);
    out[2] = a[2] + (b[2] - a[2]) * Math.min(1, t);
    return out;
  }
  // Unit directions (scalars, not arrays: this runs every frame).
  const u0 = a[0] / la;
  const u1 = a[1] / la;
  const u2 = a[2] / la;
  const v0 = b[0] / lb;
  const v1 = b[1] / lb;
  const v2 = b[2] / lb;
  let cos = Math.min(1, Math.max(-1, u0 * v0 + u1 * v1 + u2 * v2));
  // The component of v perpendicular to u (the turn's plane).
  let w0 = v0 - cos * u0;
  let w1 = v1 - cos * u1;
  let w2 = v2 - cos * u2;
  let lw = Math.hypot(w0, w1, w2);
  if (lw < 1e-6) {
    if (cos > 0) cos = 1; // the same direction: no turn
    // Opposite (or the same): any perpendicular axis.
    if (Math.abs(u1) < 0.9) {
      w0 = -u2;
      w1 = 0;
      w2 = u0;
    } else {
      w0 = 0;
      w1 = u2;
      w2 = -u1;
    }
    lw = Math.hypot(w0, w1, w2);
  }
  const angle = Math.acos(cos) * t;
  const c = Math.cos(angle);
  const sn = Math.sin(angle) / lw;
  const len = la + (lb - la) * t;
  out[0] = (u0 * c + w0 * sn) * len;
  out[1] = (u1 * c + w1 * sn) * len;
  out[2] = (u2 * c + w2 * sn) * len;
  return out;
}

/**
 * Moves the station between its orbit and its slot (see the header): `place` takes where the
 * orbit has it this frame and writes where it is drawn, blending by the cross-fade's `mix` and
 * following the slot with a lag, and returns the factor for its size (1 on its orbit). Both moves
 * swing about Earth's centre (`swing`), never through it. One instance per mounted station.
 */
export class HqSlotter {
  /** Where it heads, relative to Earth's centre, and its size factor (followed with a lag). */
  private offset: Vec3Tuple | undefined;
  private scale = 1;
  private at: number | undefined;
  private mix: number | undefined;
  private readonly slot: Vec3Tuple = [0, 0, 0];
  private readonly blend: Vec3Tuple = [0, 0, 0];
  /** Scratch: the orbit and the goal relative to Earth's centre (no allocation per frame). */
  private readonly fromOrbit: Vec3Tuple = [0, 0, 0];
  private readonly goal: Vec3Tuple = [0, 0, 0];

  /**
   * `orbit`: the station's orbit position this frame (world); `centre`, `radius`: Earth's;
   * `mix`: the cross-fade (0 system … 1 detail); `now`: seconds (a real clock: the camera turns in
   * real time); `out` may be `orbit`.
   */
  place(
    orbit: readonly [number, number, number],
    centre: readonly [number, number, number],
    radius: number,
    camera: SlotCamera,
    mix: number,
    now: number,
    reducedMotion: boolean,
    out: Vec3Tuple,
  ): number {
    const o0 = orbit[0] - centre[0];
    const o1 = orbit[1] - centre[1];
    const o2 = orbit[2] - centre[2];
    const scale = hqSlot(camera, centre, radius, this.slot);
    const slot = scale === undefined ? undefined : this.slot;
    const from = this.fromOrbit;
    from[0] = o0;
    from[1] = o1;
    from[2] = o2;
    const goal = this.goal;
    goal[0] = slot ? slot[0] - centre[0] : o0;
    goal[1] = slot ? slot[1] - centre[1] : o1;
    goal[2] = slot ? slot[2] - centre[2] : o2;
    const dt = this.at === undefined ? 0 : Math.min(0.5, Math.max(0, now - this.at));
    this.at = now;
    const m = Math.min(1, Math.max(0, mix));
    // While the view fades out (the camera flying away) the slot is no longer followed: the
    // station goes back to its orbit from where it was.
    const leaving = this.mix !== undefined && m < this.mix;
    this.mix = m;
    this.offset ??= [o0, o1, o2];
    if (!leaving) {
      const k = reducedMotion ? 1 : 1 - Math.exp(-dt / HQ_SLOT.followS);
      swing(this.offset, goal, k, this.offset);
      this.scale += ((scale ?? 1) - this.scale) * k;
    }
    const at = swing(from, this.offset, m, this.blend);
    out[0] = centre[0] + at[0];
    out[1] = centre[1] + at[1];
    out[2] = centre[2] + at[2];
    return 1 + (this.scale - 1) * m;
  }
}
