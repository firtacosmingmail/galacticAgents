import type { Vec3 } from '../camera/flight.js';

/**
 * The label projector's maths (P3-07), with no three.js: projecting an anchor to the screen,
 * hiding labels whose body is behind the Sun (or a planet), de-cluttering overlaps by priority,
 * the change threshold for DOM writes and the update throttle. `LabelProjector.tsx` feeds it the
 * camera's matrices and the anchors.
 */

/** Pixels between the top of a body on screen and the bottom of its label. */
export const LABEL_GAP_PX = 4;
/** A label is rewritten only when it moved more than this many pixels. */
export const MOVE_THRESHOLD_PX = 0.5;
/** Extra room around each label when testing overlaps. */
export const DECLUTTER_MARGIN_PX = 2;

export interface ScreenPoint {
  x: number;
  y: number;
  /** Distance in front of the camera along its view axis (clip `w`). */
  depth: number;
}

/**
 * Projects a world point with a column-major view-projection matrix (three's `elements`) to CSS
 * pixels from the viewport's top-left. `undefined` when the point is behind the camera (or on its
 * plane).
 */
export function projectToScreen(
  viewProjection: ArrayLike<number>,
  p: Vec3,
  width: number,
  height: number,
): ScreenPoint | undefined {
  const m = viewProjection;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(w > 1e-6)) return undefined;
  const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
  const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
  return {
    x: ((cx / w + 1) / 2) * width,
    y: ((1 - cy / w) / 2) * height,
    depth: w,
  };
}

export interface Occluder {
  bodyId: string;
  center: Vec3;
  radius: number;
}

/**
 * Whether the line of sight from `eye` to `target` passes through one of the occluders (the Sun,
 * the planets) in front of the target. The target's own sphere is skipped.
 */
export function occluded(
  eye: Vec3,
  target: Vec3,
  targetId: string,
  occluders: readonly Occluder[],
): boolean {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 1e-9) return false;
  const ux = dx / dist;
  const uy = dy / dist;
  const uz = dz / dist;
  for (const o of occluders) {
    if (o.bodyId === targetId) continue;
    const ox = o.center[0] - eye[0];
    const oy = o.center[1] - eye[1];
    const oz = o.center[2] - eye[2];
    const t = ox * ux + oy * uy + oz * uz;
    // Behind the eye, or not in front of the target: it cannot hide it.
    if (t <= 0 || t >= dist) continue;
    const d2 = ox * ox + oy * oy + oz * oz - t * t;
    if (d2 < o.radius * o.radius) return true;
  }
  return false;
}

export interface LabelBox {
  bodyId: string;
  /** The anchor's point on screen (the label is centred above it). */
  x: number;
  y: number;
  /** The body's radius on screen, in pixels. */
  r: number;
  /** The label's size (measured once per content change). */
  w: number;
  h: number;
  priority: number;
  depth: number;
  /**
   * Kept inside the viewport's top edge (the selected body's label, and the camera's focus): when
   * the body is near the top of the screen its label slides down over the body instead of
   * disappearing above the viewport.
   */
  pinTop?: boolean;
}

/**
 * The label's rectangle: centred horizontally on the body, its bottom just above the body. A
 * `pinTop` label that would stick out above the viewport is clamped to its top edge.
 */
export function labelRect(b: LabelBox): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  let bottom = b.y - b.r - LABEL_GAP_PX;
  if (b.pinTop && bottom - b.h < 0) bottom = b.h;
  return { left: b.x - b.w / 2, right: b.x + b.w / 2, top: bottom - b.h, bottom };
}

/**
 * Whether the label can show: some of it inside the viewport (its bottom below the top edge, so
 * a label pushed entirely above the viewport is hidden — unless `pinTop` clamps it back) and its
 * body not entirely above the viewport.
 */
export function onScreen(b: LabelBox, width: number, height: number): boolean {
  const rect = labelRect(b);
  return (
    rect.right >= 0 &&
    rect.left <= width &&
    rect.top <= height &&
    rect.bottom >= 0 &&
    b.y + b.r >= 0
  );
}

/** Ordering of `declutter`: priority first, then the nearer body, then the id (stable). */
export function byPriority(a: LabelBox, b: LabelBox): number {
  return b.priority - a.priority || a.depth - b.depth || (a.bodyId < b.bodyId ? -1 : 1);
}

/**
 * Hides lower-priority labels that overlap a higher-priority one (selected > blocked on user >
 * in progress > other open work > finished). Greedy: labels are taken in `byPriority` order and
 * kept when they overlap none kept before. Returns the ids to show.
 */
export function declutter(boxes: readonly LabelBox[], margin = DECLUTTER_MARGIN_PX): Set<string> {
  const kept: { left: number; top: number; right: number; bottom: number }[] = [];
  const shown = new Set<string>();
  for (const b of [...boxes].sort(byPriority)) {
    const r = labelRect(b);
    const clash = kept.some(
      (k) =>
        r.left < k.right + margin &&
        r.right > k.left - margin &&
        r.top < k.bottom + margin &&
        r.bottom > k.top - margin,
    );
    if (clash) continue;
    kept.push(r);
    shown.add(b.bodyId);
  }
  return shown;
}

/** Whether a label at (x, y) must be rewritten, given where it was last written. */
export function movedEnough(
  last: { x: number; y: number } | undefined,
  x: number,
  y: number,
  threshold = MOVE_THRESHOLD_PX,
): boolean {
  return !last || Math.abs(last.x - x) > threshold || Math.abs(last.y - y) > threshold;
}

/**
 * At most `hz` updates a second. `due(now)` answers and, when due, counts the update; a forced
 * update (new labels, a resize) goes through `force()`. `wait(now)` is how long until the next one
 * is due (ms), for a frame loop that renders on demand.
 */
export class Throttle {
  private last: number | undefined;
  private forced = false;
  constructor(private hz: number) {}

  setRate(hz: number): void {
    this.hz = hz;
  }

  force(): void {
    this.forced = true;
  }

  due(now: number): boolean {
    if (this.forced || this.last === undefined || now - this.last >= this.interval() - 1) {
      this.forced = false;
      this.last = now;
      return true;
    }
    return false;
  }

  wait(now: number): number {
    if (this.forced || this.last === undefined) return 0;
    return Math.max(0, this.interval() - 1 - (now - this.last));
  }

  private interval(): number {
    return 1000 / Math.max(1, this.hz);
  }
}
